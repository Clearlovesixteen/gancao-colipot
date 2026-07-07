import { PaddleOCR } from '@paddleocr/paddleocr-js';

const SANDBOX_REQUEST_SOURCE = 'gancao-paddleocr';
const SANDBOX_RESPONSE_SOURCE = 'gancao-paddleocr-sandbox';
const PADDLE_DET_MODEL = 'PP-OCRv5_mobile_det';
const PADDLE_REC_MODEL = 'PP-OCRv5_mobile_rec';

type PaddleOcrRequest =
  | {
      source: typeof SANDBOX_REQUEST_SOURCE;
      id: string;
      type: 'predict';
      imageData: ImageData;
    }
  | {
      source: typeof SANDBOX_REQUEST_SOURCE;
      id: string;
      type: 'dispose';
    };

interface PaddleOcrResponse {
  source: typeof SANDBOX_RESPONSE_SOURCE;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PaddleRuntime {
  predict: (input: unknown, params?: Record<string, unknown>) => Promise<unknown[]>;
  dispose?: () => Promise<void>;
}

let paddleRuntimePromise: Promise<PaddleRuntime> | null = null;

function assetUrl(path: string): string {
  return new URL(path, window.location.href).href;
}

function getPaddleOptions(): Record<string, unknown> {
  return {
    worker: false,
    textDetectionModelName: PADDLE_DET_MODEL,
    textDetectionModelAsset: {
      url: assetUrl(`paddleocr/models/${PADDLE_DET_MODEL}.tar`),
    },
    textRecognitionModelName: PADDLE_REC_MODEL,
    textRecognitionModelAsset: {
      url: assetUrl(`paddleocr/models/${PADDLE_REC_MODEL}.tar`),
    },
    ortOptions: {
      backend: 'wasm',
      wasmPaths: assetUrl('paddleocr/ort/'),
      numThreads: 1,
      simd: true,
      proxy: false,
    },
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return String(record.message || record.error || record.reason || JSON.stringify(record));
  }
  return 'PaddleOCR sandbox 运行失败';
}

async function getPaddleRuntime(): Promise<PaddleRuntime> {
  if (!paddleRuntimePromise) {
    paddleRuntimePromise = PaddleOCR.create(getPaddleOptions()) as Promise<PaddleRuntime>;
  }
  return paddleRuntimePromise;
}

function reply(response: PaddleOcrResponse): void {
  window.parent.postMessage(response, '*');
}

window.addEventListener('message', async (event: MessageEvent<PaddleOcrRequest>) => {
  const message = event.data;
  if (!message || message.source !== SANDBOX_REQUEST_SOURCE || !message.id) return;

  try {
    if (message.type === 'dispose') {
      const runtime = await getPaddleRuntime();
      await runtime.dispose?.();
      paddleRuntimePromise = null;
      reply({ source: SANDBOX_RESPONSE_SOURCE, id: message.id, ok: true });
      return;
    }

    if (message.type !== 'predict') {
      throw new Error(`Unsupported PaddleOCR sandbox request: ${(message as any).type}`);
    }

    const runtime = await getPaddleRuntime();
    const [result] = await runtime.predict(message.imageData, {
      textDetLimitSideLen: 960,
      textRecScoreThresh: 0,
    });
    reply({ source: SANDBOX_RESPONSE_SOURCE, id: message.id, ok: true, result });
  } catch (error) {
    if (message.type === 'predict') {
      paddleRuntimePromise = null;
    }
    reply({ source: SANDBOX_RESPONSE_SOURCE, id: message.id, ok: false, error: getErrorMessage(error) });
  }
});

window.parent.postMessage({ source: SANDBOX_RESPONSE_SOURCE, id: 'ready', ok: true }, '*');
