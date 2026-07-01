import type {
  DocumentTable,
  StructuredOcrDocumentType,
  StructuredOcrField,
  StructuredOcrResult,
  StructuredOcrSection,
} from './documentTypes';

export interface OcrStructurerPageInput {
  pageNumber: number;
  text: string;
  confidence?: number;
}

export interface OcrStructurerInput {
  text: string;
  pages?: OcrStructurerPageInput[];
  warnings?: string[];
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function splitLines(text: string): string[] {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPageTitle(line: string): boolean {
  return /^#{1,3}\s*Page\s+\d+/i.test(line);
}

function getPageNumberFromLine(line: string): number | undefined {
  const match = line.match(/^#{1,3}\s*Page\s+(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function getPages(input: OcrStructurerInput): OcrStructurerPageInput[] {
  if (input.pages?.length) {
    return input.pages.map((page) => ({
      ...page,
      text: normalizeText(page.text || ''),
    }));
  }

  const text = normalizeText(input.text || '');
  if (!text) return [];

  const parts = text.split(/\n(?=##\s*Page\s+\d+)/i);
  if (parts.length <= 1 && !/^##\s*Page\s+\d+/i.test(text)) {
    return [{ pageNumber: 1, text }];
  }

  return parts
    .map((part, index) => {
      const lines = splitLines(part);
      const firstLine = lines[0] || '';
      const pageNumber = getPageNumberFromLine(firstLine) || index + 1;
      return {
        pageNumber,
        text: lines.filter((line) => !isPageTitle(line)).join('\n'),
      };
    })
    .filter((page) => page.text.trim());
}

function looksLikeKey(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  return compact.length >= 2 && compact.length <= 18 && /[\p{L}\p{N}]/u.test(compact);
}

function parseField(line: string, pageNumber?: number, confidence?: number): StructuredOcrField | null {
  const colonMatch = line.match(/^(.{2,24}?)[：:]\s*(.+)$/);
  if (colonMatch && looksLikeKey(colonMatch[1])) {
    return {
      key: colonMatch[1].trim(),
      value: colonMatch[2].trim(),
      pageNumber,
      confidence,
      sourceText: line,
    };
  }

  const spacedMatch = line.match(/^([\p{Script=Han}A-Za-z0-9（）()\/\-_]{2,16})\s{2,}(.{1,120})$/u);
  if (spacedMatch && looksLikeKey(spacedMatch[1])) {
    return {
      key: spacedMatch[1].trim(),
      value: spacedMatch[2].trim(),
      pageNumber,
      confidence,
      sourceText: line,
    };
  }

  return null;
}

function splitTableLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.includes('|')) {
    return trimmed
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
  }

  if (trimmed.includes('\t')) {
    return trimmed
      .split('\t')
      .map((cell) => cell.trim())
      .filter(Boolean);
  }

  if (/\s{2,}/.test(trimmed)) {
    return trimmed
      .split(/\s{2,}/)
      .map((cell) => cell.trim())
      .filter(Boolean);
  }

  return [];
}

function isLikelyTableRow(cells: string[]): boolean {
  if (cells.length < 2 || cells.length > 12) return false;
  const meaningfulCells = cells.filter((cell) => cell.replace(/\s/g, '').length > 0);
  if (meaningfulCells.length < 2) return false;
  return meaningfulCells.some((cell) => /[\p{Script=Han}A-Za-z]/u.test(cell));
}

function makeTable(rows: string[][], index: number, pageNumber?: number): DocumentTable | null {
  const normalizedRows = rows.filter((row) => isLikelyTableRow(row));
  if (normalizedRows.length < 2) return null;

  const columnCount = Math.max(...normalizedRows.map((row) => row.length));
  const paddedRows = normalizedRows.map((row) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ''),
  ]);
  const headers = paddedRows[0].map((cell, colIndex) => cell || `列 ${colIndex + 1}`);

  return {
    title: pageNumber ? `OCR 表格 ${index + 1}（第 ${pageNumber} 页）` : `OCR 表格 ${index + 1}`,
    headers,
    rows: paddedRows.slice(1),
    rowCount: Math.max(0, paddedRows.length - 1),
    columnCount,
  };
}

function extractTablesFromLines(lines: string[], pageNumber?: number): { tables: DocumentTable[]; consumed: Set<number> } {
  const tables: DocumentTable[] = [];
  const consumed = new Set<number>();
  let currentRows: string[][] = [];
  let currentIndexes: number[] = [];

  const flush = () => {
    const table = makeTable(currentRows, tables.length, pageNumber);
    if (table) {
      tables.push(table);
      currentIndexes.forEach((index) => consumed.add(index));
    }
    currentRows = [];
    currentIndexes = [];
  };

  lines.forEach((line, index) => {
    const cells = splitTableLine(line);
    if (isLikelyTableRow(cells)) {
      currentRows.push(cells);
      currentIndexes.push(index);
      return;
    }
    flush();
  });
  flush();

  return { tables, consumed };
}

function isListLine(line: string): boolean {
  return /^([-*•]|[0-9]+[.、)]|[一二三四五六七八九十]+[、.])\s*/.test(line);
}

function isLikelyTitle(line: string): boolean {
  const compact = line.replace(/\s/g, '');
  return compact.length >= 4 && compact.length <= 34 && !/[。；;:：]$/.test(line);
}

function classifyDocumentType(fields: StructuredOcrField[], tables: DocumentTable[], text: string): StructuredOcrDocumentType {
  const compact = text.replace(/\s/g, '');
  if (/(发票|税额|价税合计|购买方|销售方)/.test(compact)) return 'receipt';
  if (/(合同|甲方|乙方|签订|协议)/.test(compact)) return 'contract';
  if (tables.length >= 1) return 'table';
  if (fields.length >= 3) return 'form';
  if (/(摘要|背景|结论|方案|研究|分析|报告)/.test(compact)) return 'report';
  return 'unknown';
}

function makeSummary(result: Pick<StructuredOcrResult, 'documentType' | 'pageCount' | 'fields' | 'tables' | 'sections' | 'warnings'>): string {
  const labels: Record<StructuredOcrDocumentType, string> = {
    form: '表单型资料',
    table: '表格型资料',
    report: '报告型资料',
    receipt: '票据型资料',
    contract: '合同型资料',
    unknown: '未确定类型资料',
  };
  const warningText = result.warnings.length ? `，有 ${result.warnings.length} 条识别提示` : '';
  return `${labels[result.documentType]}，共 ${result.pageCount || 1} 页，识别出 ${result.fields.length} 个字段、${result.tables.length} 个表格、${result.sections.length} 个正文区块${warningText}。`;
}

export function structuredOcrToMarkdown(result: StructuredOcrResult): string {
  const lines: string[] = [
    `# OCR 结构化结果`,
    '',
    `- 类型：${result.documentType}`,
    `- 页数：${result.pageCount}`,
    `- 字段：${result.fields.length}`,
    `- 表格：${result.tables.length}`,
    `- 摘要：${result.summary}`,
  ];

  if (result.warnings.length) {
    lines.push('', '## 识别提示', ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.fields.length) {
    lines.push('', '## 关键字段');
    result.fields.forEach((field) => {
      lines.push(`- ${field.key}：${field.value}${field.pageNumber ? `（第 ${field.pageNumber} 页）` : ''}`);
    });
  }

  result.tables.forEach((table, index) => {
    lines.push('', `## ${table.title || `表格 ${index + 1}`}`);
    lines.push(table.headers.join(' | '));
    lines.push(table.headers.map(() => '---').join(' | '));
    table.rows.forEach((row) => lines.push(row.join(' | ')));
  });

  if (result.sections.length) {
    lines.push('', '## 正文区块');
    result.sections.slice(0, 30).forEach((section) => {
      const title = section.title || (section.pageNumber ? `第 ${section.pageNumber} 页` : section.type);
      lines.push('', `### ${title}`, section.text);
    });
  }

  return lines.join('\n');
}

export function structureOcrText(input: OcrStructurerInput): StructuredOcrResult {
  const rawText = normalizeText(input.text || '');
  const pages = getPages(input);
  const fields: StructuredOcrField[] = [];
  const tables: DocumentTable[] = [];
  const sections: StructuredOcrSection[] = [];
  const warnings = [...(input.warnings || [])];

  pages.forEach((page) => {
    const lines = splitLines(page.text);
    const { tables: pageTables, consumed } = extractTablesFromLines(lines, page.pageNumber);
    tables.push(...pageTables);

    const listItems: string[] = [];
    let paragraphBuffer: string[] = [];

    const flushParagraph = () => {
      if (!paragraphBuffer.length) return;
      const text = paragraphBuffer.join('\n').trim();
      if (text) {
        sections.push({
          type: 'paragraph',
          text,
          pageNumber: page.pageNumber,
          confidence: page.confidence,
        });
      }
      paragraphBuffer = [];
    };

    const flushList = () => {
      if (!listItems.length) return;
      sections.push({
        type: 'list',
        text: listItems.join('\n'),
        items: [...listItems],
        pageNumber: page.pageNumber,
        confidence: page.confidence,
      });
      listItems.length = 0;
    };

    lines.forEach((line, index) => {
      if (consumed.has(index) || isPageTitle(line)) {
        flushParagraph();
        flushList();
        return;
      }

      const field = parseField(line, page.pageNumber, page.confidence);
      if (field) {
        flushParagraph();
        flushList();
        fields.push(field);
        sections.push({
          type: 'key_value',
          text: `${field.key}: ${field.value}`,
          pageNumber: page.pageNumber,
          confidence: page.confidence,
        });
        return;
      }

      if (isListLine(line)) {
        flushParagraph();
        listItems.push(line.replace(/^([-*•]|[0-9]+[.、)]|[一二三四五六七八九十]+[、.])\s*/, '').trim());
        return;
      }

      flushList();
      if (!paragraphBuffer.length && isLikelyTitle(line)) {
        sections.push({
          type: 'title',
          title: line,
          text: line,
          pageNumber: page.pageNumber,
          confidence: page.confidence,
        });
        return;
      }

      paragraphBuffer.push(line);
    });

    flushParagraph();
    flushList();
  });

  if (!rawText) warnings.push('未识别到文字');
  if (!fields.length && !tables.length && rawText.length > 0) {
    warnings.push('未识别出明显字段或表格，已按正文区块展示。');
  }

  const documentType = classifyDocumentType(fields, tables, rawText);
  const baseResult = {
    documentType,
    pageCount: pages.length || 1,
    fields,
    tables,
    sections,
    rawText,
    warnings: Array.from(new Set(warnings)),
    createdAt: Date.now(),
  };

  return {
    ...baseResult,
    summary: makeSummary(baseResult),
  };
}
