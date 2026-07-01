import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export interface OcrProgress {
  status: string;
  progress: number;
  pageNumber?: number;
  pageCount?: number;
}

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  confidence?: number;
  quality?: OcrQuality;
}

export interface OcrResult {
  text: string;
  pages: OcrPageResult[];
  quality: OcrQuality;
  warnings: string[];
}

export interface OcrQuality {
  confidence?: number;
  strangeCharRatio: number;
  textLength: number;
  lowConfidence: boolean;
  likelyGarbled: boolean;
}

export interface OcrOptions {
  maxPages?: number;
  onProgress?: (progress: OcrProgress) => void;
}

function runtimeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return `/${path}`;
}

export function getOcrWorkerOptions(onProgress?: (progress: OcrProgress) => void): Record<string, any> {
  return {
    workerPath: runtimeUrl('tesseract/worker.min.js'),
    corePath: runtimeUrl('tesseract/core'),
    langPath: runtimeUrl('tesseract/lang-data'),
    workerBlobURL: false,
    logger: (message: any) => {
      if (!onProgress) return;
      onProgress({
        status: String(message.status || 'ocr'),
        progress: Number(message.progress || 0),
      });
    },
  };
}

export function getOcrErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, any>;
    const message = record.message || record.error || record.reason || record.type;
    if (message) return String(message);
  }
  return 'OCR 初始化或识别失败，请重新加载插件后再试。';
}

async function getWorker(onProgress?: (progress: OcrProgress) => void): Promise<any> {
  const tesseract = await import('tesseract.js');
  const createWorker = (tesseract as any).createWorker;
  const worker = await createWorker('chi_sim+eng', 1, getOcrWorkerOptions(onProgress));
  await worker.setParameters?.({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
  });
  return worker;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function readBlobAsDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败，无法 OCR'));
    image.src = dataUrl;
  });
}

function normalizeOcrText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getStrangeCharRatio(text: string): number {
  const compact = text.replace(/\s/g, '');
  if (!compact) return 0;
  const strange = compact.match(/[^\u4e00-\u9fffA-Za-z0-9，。、《》；：？！“”‘’（）【】\[\]{}()<>.,;:!?'"`~@#$%^&*_+=/\\|\-·￥¥%]/g);
  return (strange?.length || 0) / compact.length;
}

export function evaluateOcrQuality(text: string, confidence?: number): OcrQuality {
  const normalized = normalizeOcrText(text);
  const strangeCharRatio = getStrangeCharRatio(normalized);
  const textLength = normalized.replace(/\s/g, '').length;
  const lowConfidence = typeof confidence === 'number' && confidence > 0 && confidence < 55;
  const likelyGarbled = textLength > 0 && (
    strangeCharRatio > 0.18 ||
    (lowConfidence && textLength < 80)
  );

  return {
    confidence,
    strangeCharRatio,
    textLength,
    lowConfidence,
    likelyGarbled,
  };
}

function mergeOcrQuality(pages: OcrPageResult[]): OcrQuality {
  const text = pages.map((page) => page.text).join('\n\n');
  const confidences = pages
    .map((page) => page.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number');
  const confidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : undefined;
  return evaluateOcrQuality(text, confidence);
}

function getOcrWarnings(quality: OcrQuality, hasText: boolean): string[] {
  const warnings: string[] = [];
  if (!hasText) {
    warnings.push('未识别到文字');
  }
  if (quality.lowConfidence || quality.likelyGarbled) {
    warnings.push('本地 OCR 置信度较低，识别结果可能存在乱码或漏字，建议使用模型文件解析兜底。');
  }
  return warnings;
}

function preprocessCanvas(source: HTMLCanvasElement | HTMLImageElement, options: { binarize?: boolean } = {}): HTMLCanvasElement {
  const sourceWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth || source.width;
  const sourceHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight || source.height;
  const maxDimension = 3600;
  const minDimension = Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(maxDimension / Math.max(1, minDimension), minDimension < 1600 ? 2.5 : 1.5);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建 OCR 预处理画布');

  canvas.width = width;
  canvas.height = height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  let sum = 0;
  const gray = new Uint8ClampedArray(width * height);

  for (let index = 0; index < data.length; index += 4) {
    const value = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
    const contrasted = Math.max(0, Math.min(255, (value - 128) * 1.35 + 128));
    gray[index / 4] = contrasted;
    sum += contrasted;
  }

  if (options.binarize) {
    const threshold = Math.max(115, Math.min(180, sum / gray.length));
    for (let index = 0; index < gray.length; index += 1) {
      const value = gray[index] > threshold ? 255 : 0;
      const offset = index * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function scoreOcrPage(page: OcrPageResult): number {
  const quality = page.quality || evaluateOcrQuality(page.text, page.confidence);
  const confidenceScore = typeof quality.confidence === 'number' ? quality.confidence : 50;
  const lengthScore = Math.min(80, quality.textLength / 8);
  const strangePenalty = quality.strangeCharRatio * 160;
  const garbledPenalty = quality.likelyGarbled ? 40 : 0;
  return confidenceScore + lengthScore - strangePenalty - garbledPenalty;
}

function shouldRetryOcr(page: OcrPageResult): boolean {
  const quality = page.quality || evaluateOcrQuality(page.text, page.confidence);
  return quality.likelyGarbled || quality.lowConfidence || quality.textLength < 60;
}

function pickBetterOcrPage(current: OcrPageResult, candidate: OcrPageResult): OcrPageResult {
  return scoreOcrPage(candidate) > scoreOcrPage(current) ? candidate : current;
}

async function recognizeDataUrl(
  dataUrl: string,
  pageNumber: number,
  worker: any,
  pageCount: number,
  onProgress?: (progress: OcrProgress) => void
): Promise<OcrPageResult> {
  onProgress?.({ status: 'recognizing', progress: 0, pageNumber, pageCount });
  const result = await worker.recognize(dataUrl);
  const text = normalizeOcrText(String(result?.data?.text || ''));
  const confidence = typeof result?.data?.confidence === 'number' ? result.data.confidence : undefined;
  const quality = evaluateOcrQuality(text, confidence);
  onProgress?.({ status: 'done', progress: 1, pageNumber, pageCount });
  return { pageNumber, text, confidence, quality };
}

export async function ocrImage(file: Blob, options: OcrOptions = {}): Promise<OcrResult> {
  const worker = await getWorker(options.onProgress);
  try {
    const dataUrl = await readBlobAsDataUrl(file);
    const image = await loadImage(dataUrl);
    const enhanced = preprocessCanvas(image, { binarize: false });
    let page = await recognizeDataUrl(canvasToDataUrl(enhanced), 1, worker, 1, options.onProgress);
    if (shouldRetryOcr(page)) {
      const binarized = preprocessCanvas(image, { binarize: true });
      const retryPage = await recognizeDataUrl(canvasToDataUrl(binarized), 1, worker, 1, options.onProgress);
      page = pickBetterOcrPage(page, retryPage);
    }
    const quality = mergeOcrQuality([page]);
    const hasText = Boolean(page.text.trim());
    return {
      text: page.text,
      pages: [page],
      quality,
      warnings: getOcrWarnings(quality, hasText),
    };
  } finally {
    await worker.terminate?.();
  }
}

export async function renderPdfPageToDataUrls(pdf: any, pageNumber: number): Promise<{ enhanced: string; binarized: string }> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 3 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 OCR 画布');

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return {
    enhanced: canvasToDataUrl(preprocessCanvas(canvas, { binarize: false })),
    binarized: canvasToDataUrl(preprocessCanvas(canvas, { binarize: true })),
  };
}

export async function ocrPdf(file: Blob, options: OcrOptions = {}): Promise<OcrResult> {
  const maxPages = options.maxPages || 20;
  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const worker = await getWorker(options.onProgress);
  const pages: OcrPageResult[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      options.onProgress?.({ status: 'rendering', progress: (pageNumber - 1) / pageCount, pageNumber, pageCount });
      const dataUrls = await renderPdfPageToDataUrls(pdf, pageNumber);
      let page = await recognizeDataUrl(dataUrls.enhanced, pageNumber, worker, pageCount, options.onProgress);
      if (shouldRetryOcr(page)) {
        const retryPage = await recognizeDataUrl(dataUrls.binarized, pageNumber, worker, pageCount, options.onProgress);
        page = pickBetterOcrPage(page, retryPage);
      }
      pages.push(page);
    }

    const text = pages.map((page) => `## Page ${page.pageNumber}\n${page.text}`).join('\n\n').trim();
    const quality = mergeOcrQuality(pages);
    const hasText = Boolean(text.trim());
    return {
      text,
      pages,
      quality,
      warnings: getOcrWarnings(quality, hasText),
    };
  } finally {
    await worker.terminate?.();
    try {
      await pdf.cleanup?.();
      await loadingTask.destroy?.();
    } catch (error) {
      console.warn('PDF OCR 资源释放失败:', error);
    }
  }
}

export async function runOcr(file: Blob, mimeType: string, options: OcrOptions = {}): Promise<OcrResult> {
  const fileName = typeof File !== 'undefined' && file instanceof File ? file.name.toLowerCase() : '';
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    return ocrPdf(file, options);
  }
  if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(fileName)) {
    return ocrImage(file, options);
  }
  throw new Error('当前文件类型不支持 OCR');
}
