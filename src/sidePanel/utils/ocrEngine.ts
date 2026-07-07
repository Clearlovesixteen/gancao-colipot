import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const PADDLE_DET_MODEL = 'PP-OCRv5_mobile_det';
const PADDLE_REC_MODEL = 'PP-OCRv5_mobile_rec';
const PADDLE_DET_MODEL_FILE = `${PADDLE_DET_MODEL}.tar`;
const PADDLE_REC_MODEL_FILE = `${PADDLE_REC_MODEL}.tar`;

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

interface PaddleOcrLine {
  text?: string;
  score?: number;
  poly?: Array<{ x?: number; y?: number } | [number, number]>;
}

interface PaddleOcrResultLike {
  items?: PaddleOcrLine[];
}

interface PaddleOcrSandboxBridge {
  predict: (imageData: ImageData) => Promise<PaddleOcrResultLike>;
}

interface PaddleOcrSandboxResponse {
  source?: string;
  id?: string;
  ok?: boolean;
  result?: PaddleOcrResultLike;
  error?: string;
}

const SANDBOX_REQUEST_SOURCE = 'gancao-paddleocr';
const SANDBOX_RESPONSE_SOURCE = 'gancao-paddleocr-sandbox';
const PADDLE_SANDBOX_TIMEOUT_MS = 120000;

let paddleSandboxBridgePromise: Promise<PaddleOcrSandboxBridge> | null = null;

function runtimeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return `/${path}`;
}

export function getPaddleOcrRuntimeOptions(): Record<string, any> {
  return {
    worker: false,
    sandboxUrl: runtimeUrl('paddleocrSandbox.html'),
    textDetectionModelName: PADDLE_DET_MODEL,
    textDetectionModelAsset: {
      url: runtimeUrl(`paddleocr/models/${PADDLE_DET_MODEL_FILE}`),
    },
    textRecognitionModelName: PADDLE_REC_MODEL,
    textRecognitionModelAsset: {
      url: runtimeUrl(`paddleocr/models/${PADDLE_REC_MODEL_FILE}`),
    },
    ortOptions: {
      backend: 'wasm',
      wasmPaths: runtimeUrl('paddleocr/ort/'),
      numThreads: 1,
      simd: true,
      proxy: false,
    },
  };
}

export function getOcrErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return normalizePaddleErrorMessage(error.message);
  if (typeof error === 'string' && error.trim()) return normalizePaddleErrorMessage(error);
  if (error && typeof error === 'object') {
    const record = error as Record<string, any>;
    const message = record.message || record.error || record.reason || record.type;
    if (message) return normalizePaddleErrorMessage(String(message));
  }
  return 'PaddleOCR 初始化或识别失败，请重新加载插件后再试。';
}

function normalizePaddleErrorMessage(message: string): string {
  if (/unsafe-eval|content security policy|CSP|script-src/i.test(message)) {
    return `PaddleOCR 运行时需要在扩展 sandbox 页面中初始化，请检查 manifest sandbox 配置、paddleocrSandbox.html 和 paddleocrSandbox.js 是否已打包。原始错误：${message}`;
  }
  if (/PP-OCRv5_mobile_(det|rec)\.tar|model asset|404|not found|failed to fetch|fetch/i.test(message)) {
    return `PaddleOCR 模型资产缺失或无法加载，请检查 public/paddleocr/models/${PADDLE_DET_MODEL_FILE} 和 ${PADDLE_REC_MODEL_FILE} 是否已打包。原始错误：${message}`;
  }
  if (/wasm|onnx|ort|InferenceSession|WebAssembly/i.test(message)) {
    return `PaddleOCR WebAssembly/ONNX Runtime 初始化失败，请检查 dist/paddleocr/ort 资源是否存在。原始错误：${message}`;
  }
  return message;
}

async function getPaddleSandboxBridge(onProgress?: (progress: OcrProgress) => void): Promise<PaddleOcrSandboxBridge> {
  if (!paddleSandboxBridgePromise) {
    paddleSandboxBridgePromise = (async () => {
      onProgress?.({ status: 'initializing', progress: 0.02 });
      await assertPaddleModelAssets();
      if (typeof document === 'undefined') {
        throw new Error('PaddleOCR sandbox 只能在浏览器页面中初始化');
      }

      const iframe = document.createElement('iframe');
      iframe.src = getPaddleOcrRuntimeOptions().sandboxUrl;
      iframe.title = 'PaddleOCR Sandbox';
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');

      const pending = new Map<string, {
        resolve: (value: PaddleOcrResultLike) => void;
        reject: (reason?: unknown) => void;
        timer: number;
      }>();

      const cleanupPending = (id: string) => {
        const request = pending.get(id);
        if (!request) return;
        window.clearTimeout(request.timer);
        pending.delete(id);
      };

      window.addEventListener('message', (event: MessageEvent<PaddleOcrSandboxResponse>) => {
        if (event.source !== iframe.contentWindow) return;
        const response = event.data;
        if (!response || response.source !== SANDBOX_RESPONSE_SOURCE || !response.id || response.id === 'ready') return;
        const request = pending.get(response.id);
        if (!request) return;
        cleanupPending(response.id);
        if (response.ok) {
          request.resolve(response.result || {});
        } else {
          request.reject(new Error(response.error || 'PaddleOCR sandbox 识别失败'));
        }
      });

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error('PaddleOCR sandbox 页面加载超时'));
        }, 30000);
        iframe.onload = () => {
          window.clearTimeout(timer);
          resolve();
        };
        iframe.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error('PaddleOCR sandbox 页面加载失败'));
        };
        (document.body || document.documentElement).appendChild(iframe);
      });

      onProgress?.({ status: 'initializing', progress: 1 });

      return {
        predict(imageData: ImageData): Promise<PaddleOcrResultLike> {
          return new Promise((resolve, reject) => {
            const targetWindow = iframe.contentWindow;
            if (!targetWindow) {
              reject(new Error('PaddleOCR sandbox 页面不可用'));
              return;
            }

            const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timer = window.setTimeout(() => {
              cleanupPending(id);
              reject(new Error('PaddleOCR sandbox 响应超时'));
            }, PADDLE_SANDBOX_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timer });
            targetWindow.postMessage({
              source: SANDBOX_REQUEST_SOURCE,
              id,
              type: 'predict',
              imageData,
            }, '*');
          });
        },
      };
    })().catch((error) => {
      paddleSandboxBridgePromise = null;
      throw error;
    });
  }
  return paddleSandboxBridgePromise;
}

async function assertPaddleModelAssets(): Promise<void> {
  if (typeof fetch !== 'function') return;
  const options = getPaddleOcrRuntimeOptions();
  const urls = [
    options.textDetectionModelAsset.url,
    options.textRecognitionModelAsset.url,
  ];
  await Promise.all(urls.map(async (url) => {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`PaddleOCR model asset missing: ${url}`);
    }
  }));
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
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
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
    warnings.push('PaddleOCR 置信度较低，识别结果可能存在乱码或漏字，建议核对原始文件。');
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

function getPolyPoint(point: { x?: number; y?: number } | [number, number] | undefined): { x: number; y: number } {
  if (Array.isArray(point)) return { x: Number(point[0]) || 0, y: Number(point[1]) || 0 };
  return { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
}

function getLinePosition(line: PaddleOcrLine): { x: number; y: number } {
  const points = (line.poly || []).map(getPolyPoint);
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
  };
}

function normalizePaddleScore(score: number | undefined): number | undefined {
  if (typeof score !== 'number' || Number.isNaN(score)) return undefined;
  if (score <= 1) return Math.max(0, Math.min(100, score * 100));
  return Math.max(0, Math.min(100, score));
}

export function paddleResultToPage(result: PaddleOcrResultLike | undefined, pageNumber: number): OcrPageResult {
  const lines = [...(result?.items || [])]
    .filter((line) => String(line.text || '').trim())
    .sort((left, right) => {
      const leftPosition = getLinePosition(left);
      const rightPosition = getLinePosition(right);
      const yDelta = leftPosition.y - rightPosition.y;
      if (Math.abs(yDelta) > 12) return yDelta;
      return leftPosition.x - rightPosition.x;
    });
  const text = normalizeOcrText(lines.map((line) => String(line.text || '').trim()).join('\n'));
  const scores = lines
    .map((line) => normalizePaddleScore(line.score))
    .filter((score): score is number => typeof score === 'number');
  const confidence = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined;
  const quality = evaluateOcrQuality(text, confidence);
  return { pageNumber, text, confidence, quality };
}

async function recognizeCanvas(
  canvas: HTMLCanvasElement,
  pageNumber: number,
  bridge: PaddleOcrSandboxBridge,
  pageCount: number,
  onProgress?: (progress: OcrProgress) => void
): Promise<OcrPageResult> {
  onProgress?.({ status: 'recognizing', progress: 0, pageNumber, pageCount });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取 OCR 画布像素');
  const result = await bridge.predict(context.getImageData(0, 0, canvas.width, canvas.height));
  const page = paddleResultToPage(result, pageNumber);
  onProgress?.({ status: 'done', progress: 1, pageNumber, pageCount });
  return page;
}

export async function ocrImage(file: Blob, options: OcrOptions = {}): Promise<OcrResult> {
  const bridge = await getPaddleSandboxBridge(options.onProgress);
  const dataUrl = await readBlobAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const enhanced = preprocessCanvas(image, { binarize: false });
  let page = await recognizeCanvas(enhanced, 1, bridge, 1, options.onProgress);
  if (shouldRetryOcr(page)) {
    const binarized = preprocessCanvas(image, { binarize: true });
    const retryPage = await recognizeCanvas(binarized, 1, bridge, 1, options.onProgress);
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
}

export async function renderPdfPageToCanvases(pdf: any, pageNumber: number): Promise<{ enhanced: HTMLCanvasElement; binarized: HTMLCanvasElement }> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 3 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 OCR 画布');

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return {
    enhanced: preprocessCanvas(canvas, { binarize: false }),
    binarized: preprocessCanvas(canvas, { binarize: true }),
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
  const bridge = await getPaddleSandboxBridge(options.onProgress);
  const pages: OcrPageResult[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      options.onProgress?.({ status: 'rendering_pdf', progress: (pageNumber - 1) / pageCount, pageNumber, pageCount });
      const canvases = await renderPdfPageToCanvases(pdf, pageNumber);
      let page = await recognizeCanvas(canvases.enhanced, pageNumber, bridge, pageCount, options.onProgress);
      if (shouldRetryOcr(page)) {
        const retryPage = await recognizeCanvas(canvases.binarized, pageNumber, bridge, pageCount, options.onProgress);
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
