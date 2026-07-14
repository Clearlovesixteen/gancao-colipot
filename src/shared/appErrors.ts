import { redactSecrets } from './modelProfiles';

export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_CAPABILITY_MISSING'
  | 'MODEL_INVALID_RESPONSE'
  | 'MODEL_HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'CONTENT_SCRIPT_UNAVAILABLE'
  | 'OCR_RUNTIME_ERROR'
  | 'TASK_BLOCKED'
  | 'TASK_STOPPED'
  | 'TASK_RUNTIME_RESTARTED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_ERROR';

export interface AppErrorPayload {
  success: false;
  code: AppErrorCode;
  error: string;
  recovery?: string;
  retryable: boolean;
  detail?: unknown;
}

const RECOVERY_BY_CODE: Record<AppErrorCode, string> = {
  UNAUTHENTICATED: '请先完成登录，再重新执行当前操作。',
  MODEL_NOT_CONFIGURED: '请前往工作台的模型设置，添加并启用一个模型配置。',
  MODEL_CAPABILITY_MISSING: '请切换到支持当前能力的模型，或修改模型能力配置。',
  MODEL_INVALID_RESPONSE: '请重试；若持续失败，请切换模型或检查模型兼容性。',
  MODEL_HTTP_ERROR: '请检查 Base URL、模型名称、API Key 和服务端配额后重试。',
  NETWORK_ERROR: '请检查网络、模型地址和代理设置后重试。',
  CONTENT_SCRIPT_UNAVAILABLE: '请刷新当前网页；浏览器内置页面无法执行页面能力。',
  OCR_RUNTIME_ERROR: '请运行插件健康检查，确认 PaddleOCR 模型和 ORT 资源完整。',
  TASK_BLOCKED: '请根据任务卡中的阻塞原因补充页面状态或输入后重试。',
  TASK_STOPPED: '任务已停止，可从任务中心重新执行。',
  TASK_RUNTIME_RESTARTED: '扩展后台已重启，请从任务中心重新执行该任务。',
  VALIDATION_ERROR: '请补充或修正任务配置后重试。',
  UNKNOWN_ERROR: '请重试；若问题持续，请复制任务日志进行排查。',
};

const RETRYABLE_CODES = new Set<AppErrorCode>([
  'MODEL_INVALID_RESPONSE',
  'MODEL_HTTP_ERROR',
  'NETWORK_ERROR',
  'CONTENT_SCRIPT_UNAVAILABLE',
  'OCR_RUNTIME_ERROR',
  'TASK_BLOCKED',
  'TASK_STOPPED',
  'TASK_RUNTIME_RESTARTED',
  'UNKNOWN_ERROR',
]);

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
    public options: { recovery?: string; retryable?: boolean; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function inferAppErrorCode(error: unknown): AppErrorCode {
  const explicit = String((error as any)?.code || '');
  if (explicit in RECOVERY_BY_CODE) return explicit as AppErrorCode;
  const message = String((error as any)?.message || error || '');
  if (/未登录|请登录|登录后/.test(message)) return 'UNAUTHENTICATED';
  if (/尚未配置模型|API Key/.test(message)) return 'MODEL_NOT_CONFIGURED';
  if (/content script|Receiving end does not exist|Could not establish connection/i.test(message)) return 'CONTENT_SCRIPT_UNAVAILABLE';
  if (/PaddleOCR|ONNX|ORT|OCR.*(?:失败|超时)/i.test(message)) return 'OCR_RUNTIME_ERROR';
  if (/已停止|取消/.test(message)) return 'TASK_STOPPED';
  if (/缺少|请输入|无效|校验失败/.test(message)) return 'VALIDATION_ERROR';
  if (/Failed to fetch|NetworkError|网络|超时|timeout/i.test(message)) return 'NETWORK_ERROR';
  if (/阻塞|未找到目标|无法定位|没有.*按钮/.test(message)) return 'TASK_BLOCKED';
  return 'UNKNOWN_ERROR';
}

export function toAppErrorPayload(
  error: unknown,
  fallback = '操作失败',
  options: { secrets?: string[]; detail?: unknown } = {},
): AppErrorPayload {
  const code = inferAppErrorCode(error);
  const rawMessage = String((error as any)?.message || error || fallback);
  const message = String(redactSecrets(rawMessage, options.secrets || [])) || fallback;
  const appError = error instanceof AppError ? error : null;
  const detail = options.detail ?? appError?.options.detail;
  return {
    success: false,
    code,
    error: message,
    recovery: appError?.options.recovery || RECOVERY_BY_CODE[code],
    retryable: appError?.options.retryable ?? RETRYABLE_CODES.has(code),
    ...(detail === undefined ? {} : { detail: redactSecrets(detail, options.secrets || []) }),
  };
}

export function sanitizeForPersistence<T>(value: T, secrets: string[] = []): T {
  return redactSecrets(value, secrets) as T;
}
