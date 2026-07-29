import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export interface ParsedUploadedFile {
  status: 'parsed' | 'partial' | 'unsupported' | 'error';
  kind: 'text' | 'json' | 'table' | 'spreadsheet' | 'document' | 'presentation' | 'pdf' | 'image' | 'binary';
  text?: string;
  sheets?: Array<{
    name: string;
    rows: any[][];
    headers?: string[];
    rowCount: number;
    columnCount: number;
  }>;
  metadata: {
    name: string;
    type: string;
    size: number;
    extension: string;
    parsedAt: number;
  };
  warning?: string;
  error?: string;
}

const MAX_TEXT_LENGTH = 80000;
const MAX_SHEET_ROWS = 200;
const MAX_SHEETS = 8;

function getExtension(name: string): string {
  const match = name.toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] || '';
}

function truncateText(text: string, maxLength = MAX_TEXT_LENGTH): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxLength), truncated: true };
}

function decodeHtmlEntities(value: string): string {
  if (typeof document === 'undefined') {
    return value
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function stripXmlTags(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function normalizeRows(rows: any[][]): any[][] {
  return rows.map((row) => row.map((cell) => {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object') return JSON.stringify(cell);
    return String(cell);
  }));
}

function rowsToText(sheetName: string, rows: any[][]): string {
  const previewRows = rows.slice(0, MAX_SHEET_ROWS);
  const body = previewRows.map((row) => row.join('\t')).join('\n');
  return `# ${sheetName}\n${body}`;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 ZIP 解压');
  }

  const blobPart = data.buffer instanceof ArrayBuffer
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data.slice().buffer as ArrayBuffer;

  try {
    const stream = new Blob([blobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    const stream = new Blob([blobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

async function extractZipText(arrayBuffer: ArrayBuffer, wantedFiles: RegExp[]): Promise<string> {
  const bytes = new Uint8Array(arrayBuffer);
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= 0; i--) {
    if (readUint32(bytes, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error('未找到 ZIP 目录');
  }

  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirOffset = readUint32(bytes, eocdOffset + 16);
  const decoder = new TextDecoder();
  const extracted: string[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    if (readUint32(bytes, offset) !== 0x02014b50) break;

    const compressionMethod = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const fileNameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    const fileName = decoder.decode(bytes.slice(offset + 46, offset + 46 + fileNameLength));

    if (wantedFiles.some((pattern) => pattern.test(fileName))) {
      const localNameLength = readUint16(bytes, localHeaderOffset + 26);
      const localExtraLength = readUint16(bytes, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let contentBytes: Uint8Array;

      if (compressionMethod === 0) {
        contentBytes = compressed;
      } else if (compressionMethod === 8) {
        contentBytes = await inflateRaw(compressed);
      } else {
        throw new Error(`不支持的 ZIP 压缩方式: ${compressionMethod}`);
      }

      extracted.push(decoder.decode(contentBytes));
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return extracted.join('\n');
}

async function parseOfficeZip(file: File, extension: string): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const arrayBuffer = await file.arrayBuffer();
  const wantedFiles = extension === 'docx'
    ? [/^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/]
    : [/^ppt\/slides\/slide\d+\.xml$/];
  const xml = await extractZipText(arrayBuffer, wantedFiles);
  const { text, truncated } = truncateText(stripXmlTags(xml));

  return {
    status: truncated ? 'partial' : 'parsed',
    kind: extension === 'docx' ? 'document' : 'presentation',
    text,
    warning: truncated ? '内容较长，已截断前 80000 字符。' : undefined,
  };
}

async function parseDocx(file: File): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const normalized = result.value.replace(/\n{3,}/g, '\n\n').trim();
  const { text, truncated } = truncateText(normalized);
  const warnings = result.messages?.map((item: any) => item.message).filter(Boolean) || [];

  return {
    status: truncated || warnings.length > 0 ? 'partial' : 'parsed',
    kind: 'document',
    text,
    warning: [
      truncated ? '内容较长，已截断前 80000 字符。' : '',
      ...warnings,
    ].filter(Boolean).join('；') || undefined,
  };
}

async function parsePptx(file: File): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const aIndex = Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const bIndex = Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return aIndex - bIndex;
    });

  const slideTexts: string[] = [];

  for (const slideName of slideFiles) {
    const xml = await zip.files[slideName].async('text');
    const slideIndex = slideName.match(/slide(\d+)\.xml$/)?.[1] || String(slideTexts.length + 1);
    const textNodes = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map((match) => decodeHtmlEntities(match[1]));
    const text = textNodes.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) {
      slideTexts.push(`## Slide ${slideIndex}\n${text}`);
    }
  }

  const { text, truncated } = truncateText(slideTexts.join('\n\n'));

  return {
    status: truncated ? 'partial' : 'parsed',
    kind: 'presentation',
    text,
    warning: truncated ? 'PPT 内容较长，已截断前 80000 字符。' : undefined,
  };
}

async function parseSpreadsheet(file: File): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'sheets' | 'warning'>> {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const sheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, blankrows: false }) as any[][];
    const rows = normalizeRows(rawRows.slice(0, MAX_SHEET_ROWS));
    const headers = rows[0]?.map(String) || [];
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

    return {
      name: sheetName,
      rows,
      headers,
      rowCount: rawRows.length,
      columnCount,
    };
  });
  const allText = sheets.map((sheet) => rowsToText(sheet.name, sheet.rows)).join('\n\n');
  const { text, truncated } = truncateText(allText);
  const limited = workbook.SheetNames.length > MAX_SHEETS || sheets.some((sheet) => sheet.rowCount > MAX_SHEET_ROWS);

  return {
    status: truncated || limited ? 'partial' : 'parsed',
    kind: 'spreadsheet',
    sheets,
    text,
    warning: limited || truncated ? '表格较大，仅保留前 8 个 Sheet、每个 Sheet 前 200 行用于 AI 分析。' : undefined,
  };
}

async function parseTextLike(file: File, kind: ParsedUploadedFile['kind']): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const rawText = await file.text();
  const { text, truncated } = truncateText(rawText);

  return {
    status: truncated ? 'partial' : 'parsed',
    kind,
    text,
    warning: truncated ? '内容较长，已截断前 80000 字符。' : undefined,
  };
}

async function parseJson(file: File): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const rawText = await file.text();
  const parsed = JSON.parse(rawText);
  const pretty = JSON.stringify(parsed, null, 2);
  const { text, truncated } = truncateText(pretty);

  return {
    status: truncated ? 'partial' : 'parsed',
    kind: 'json',
    text,
    warning: truncated ? 'JSON 较大，已截断前 80000 字符。' : undefined,
  };
}

async function parsePdf(file: File): Promise<Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'warning'>> {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({
    data,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) {
        pageTexts.push(`## Page ${pageNumber}\n${pageText}`);
      }
    }

    const extractedText = pageTexts.join('\n\n').trim();
    const truncated = truncateText(extractedText);
    return {
      status: truncated.truncated ? 'partial' : 'parsed',
      kind: 'pdf',
      text: truncated.text,
      warning: extractedText
        ? (truncated.truncated ? 'PDF 文本较长，已截断前 80000 字符。' : undefined)
        : 'PDF 已解析，但未提取到文本。可能是扫描件或图片型 PDF，需要 OCR 能力。',
    };
  } finally {
    try {
      await pdf.cleanup?.();
      await loadingTask.destroy?.();
    } catch (cleanupError) {
      console.warn('PDF 资源释放失败:', cleanupError);
    }
  }
}

export async function parseUploadedFile(file: File): Promise<ParsedUploadedFile> {
  const extension = getExtension(file.name);
  const metadata = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    extension,
    parsedAt: Date.now(),
  };

  try {
    let parsed: Pick<ParsedUploadedFile, 'status' | 'kind' | 'text' | 'sheets' | 'warning'>;

    if (file.type.startsWith('image/')) {
      parsed = {
        status: 'parsed',
        kind: 'image',
        text: `图片文件：${file.name}，类型：${file.type || 'unknown'}，大小：${file.size} bytes。`,
      };
    } else if (['xlsx', 'xls', 'csv'].includes(extension)) {
      parsed = await parseSpreadsheet(file);
    } else if (extension === 'json' || file.type.includes('json')) {
      parsed = await parseJson(file);
    } else if (['txt', 'md', 'markdown', 'log'].includes(extension) || file.type.startsWith('text/')) {
      parsed = await parseTextLike(file, 'text');
    } else if (['html', 'htm', 'xml'].includes(extension)) {
      parsed = await parseTextLike(file, extension === 'xml' ? 'text' : 'document');
    } else if (extension === 'docx') {
      parsed = await parseDocx(file);
    } else if (extension === 'pptx') {
      parsed = await parsePptx(file);
    } else if (extension === 'pdf' || file.type === 'application/pdf') {
      parsed = await parsePdf(file);
    } else {
      parsed = {
        status: 'unsupported',
        kind: 'binary',
        text: '',
        warning: `暂不支持解析 .${extension || 'unknown'} 文件。`,
      };
    }

    return {
      ...parsed,
      metadata,
    };
  } catch (error: any) {
    return {
      status: 'error',
      kind: 'binary',
      text: '',
      metadata,
      error: error?.message || '文件解析失败',
    };
  }
}
