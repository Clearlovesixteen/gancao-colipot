export const PADDLE_DET_MODEL = 'PP-OCRv5_mobile_det';
export const PADDLE_REC_MODEL = 'PP-OCRv5_mobile_rec';
export const PADDLE_DET_MODEL_FILE = `${PADDLE_DET_MODEL}.tar`;
export const PADDLE_REC_MODEL_FILE = `${PADDLE_REC_MODEL}.tar`;

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

