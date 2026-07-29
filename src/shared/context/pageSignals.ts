import type {
  BrowserPageSignal,
  BrowserPageState,
} from '../automation/automationTypes';

interface PageSignalInput {
  pageState?: BrowserPageState;
  existingSignals?: BrowserPageSignal[];
  textPreview?: string;
  title?: string;
  consoleErrors?: unknown[];
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function errorSource(error: any): string {
  return compact(`${error?.source || ''} ${error?.type || ''} ${error?.level || ''} ${error?.message || ''}`);
}

function classifyErrorSignal(errors: unknown[]): BrowserPageSignal[] {
  const counts = { console_error: 0, resource_error: 0, network_error: 0 };
  for (const error of errors as any[]) {
    const source = errorSource(error);
    if (/(resource|script|stylesheet|image|font|media|加载失败|404)/i.test(source)) {
      counts.resource_error += 1;
    } else if (/(network|fetch|xhr|request|net::|网络)/i.test(source)) {
      counts.network_error += 1;
    } else {
      counts.console_error += 1;
    }
  }

  const signals: BrowserPageSignal[] = [];
  if (counts.console_error) {
    signals.push({
      type: 'console_error',
      severity: 'error',
      message: `捕获到 ${counts.console_error} 条脚本错误。`,
      source: 'console',
    });
  }
  if (counts.resource_error) {
    signals.push({
      type: 'resource_error',
      severity: 'error',
      message: `捕获到 ${counts.resource_error} 条资源加载错误。`,
      source: 'resource',
    });
  }
  if (counts.network_error) {
    signals.push({
      type: 'network_error',
      severity: 'error',
      message: `捕获到 ${counts.network_error} 条网络请求错误。`,
      source: 'network',
    });
  }
  return signals;
}

export function mergePageSignals(...groups: Array<BrowserPageSignal[] | undefined>): BrowserPageSignal[] {
  const merged = new Map<BrowserPageSignal['type'], BrowserPageSignal>();
  for (const signal of groups.flatMap((group) => group || [])) {
    const current = merged.get(signal.type);
    if (!current || (current.severity !== 'error' && signal.severity === 'error')) {
      merged.set(signal.type, signal);
    }
  }
  return [...merged.values()];
}

export function derivePageSignals(input: PageSignalInput): BrowserPageSignal[] {
  const state = input.pageState;
  const text = compact(`${input.title || ''} ${input.textPreview || ''}`);
  const inferred: BrowserPageSignal[] = [];

  if (
    state?.kind === 'login_page'
    || (!input.existingSignals?.length && /(请先登录|请登录|扫码登录|账号登录|sign in to|log in to)/i.test(text))
  ) {
    inferred.push({ type: 'login', severity: 'warning', message: '页面处于登录或未登录状态。', source: 'page_state' });
  }
  if (state?.hasCaptcha || /(验证码|安全验证|人机验证|captcha)/i.test(text)) {
    inferred.push({ type: 'captcha', severity: 'warning', message: '页面出现验证码或安全验证信号。', source: 'page_state' });
  }
  if (
    state?.kind === 'permission_page'
    || state?.hasPermissionDenied
    || /(无权限|权限不足|403 forbidden|access denied|permission denied)/i.test(text)
  ) {
    inferred.push({ type: 'permission', severity: 'error', message: '页面出现权限不足信号。', source: 'page_state' });
  }
  if (state?.kind === 'empty_page' || state?.hasEmptyState) {
    inferred.push({ type: 'empty', severity: 'info', message: '页面处于空状态或暂无数据。', source: 'page_state' });
  }

  return mergePageSignals(
    input.existingSignals,
    inferred,
    classifyErrorSignal(input.consoleErrors || []),
  );
}

export function getBlockingPageSignal(signals: BrowserPageSignal[] = []): BrowserPageSignal | undefined {
  return signals.find((signal) => signal.type === 'captcha')
    || signals.find((signal) => signal.type === 'login')
    || signals.find((signal) => signal.type === 'permission');
}
