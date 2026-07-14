import { checkDocumentRepositoryHealth } from './documentStore';
import { getPaddleOcrRuntimeOptions } from './ocrEngine';
import { isAuthenticated } from './auth';

export type HealthCheckStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheckItem {
  id: string;
  title: string;
  status: HealthCheckStatus;
  message: string;
  detail?: string;
}

function ok(id: string, title: string, message: string, detail?: string): HealthCheckItem {
  return { id, title, status: 'pass', message, detail };
}

function warn(id: string, title: string, message: string, detail?: string): HealthCheckItem {
  return { id, title, status: 'warn', message, detail };
}

function fail(id: string, title: string, message: string, detail?: string): HealthCheckItem {
  return { id, title, status: 'fail', message, detail };
}

function sendRuntimeMessage<T = any>(payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime 不可用'));
      return;
    }
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      resolve(response);
    });
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (!chrome?.tabs?.query) return null;
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

async function sendTabMessage<T = any>(tabId: number, payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      resolve(response);
    });
  });
}

async function checkBackground(): Promise<HealthCheckItem> {
  try {
    const response = await sendRuntimeMessage<{ status?: string }>({ type: 'GET_STATUS' });
    return ok('background', '后台服务', `后台可响应，LLM 状态：${response?.status || 'unknown'}`);
  } catch (error: any) {
    return fail('background', '后台服务', '后台消息通道不可用', error?.message);
  }
}

async function checkModelProfile(): Promise<HealthCheckItem> {
  try {
    const response = await sendRuntimeMessage<any>({ type: 'GET_MODEL_PROFILES' });
    if (!response?.success) return fail('model', '模型配置', '无法读取模型配置', response?.error);
    const active = (response.profiles || []).find((profile: any) => profile.active);
    return active
      ? ok('model', '模型配置', `当前模型：${active.name} / ${active.model}`, `${active.baseUrl} · Key ${active.apiKey || '已配置'}`)
      : warn('model', '模型配置', '尚未配置活动模型，请前往工作台设置页添加 API Key');
  } catch (error: any) {
    return fail('model', '模型配置', '检查模型配置失败', error?.message);
  }
}

async function checkAuth(): Promise<HealthCheckItem> {
  try {
    const authed = await isAuthenticated();
    return authed
      ? ok('auth', '登录态', '插件当前为已登录状态')
      : warn('auth', '登录态', '插件当前未登录，AI/自动操作/资料工具会被拦截');
  } catch (error: any) {
    return fail('auth', '登录态', '读取登录态失败', error?.message);
  }
}

async function checkContentScript(): Promise<HealthCheckItem> {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return warn('content', '页面注入', '未找到当前活动标签页');
    if (tab.url && /^(chrome|edge|about|devtools):/i.test(tab.url)) {
      return warn('content', '页面注入', '当前是浏览器内置页，content script 无法注入', tab.url);
    }
    const response = await sendTabMessage(tab.id, {
      type: 'EXECUTE_BROWSER_TOOL',
      toolName: 'get_page_info',
      arguments: { include_html: false },
    });
    if (response?.success) {
      return ok('content', '页面注入', 'content script 可响应页面工具', response.result?.url || tab.url);
    }
    return fail('content', '页面注入', 'content script 响应失败', response?.error);
  } catch (error: any) {
    return fail('content', '页面注入', '无法调用当前页面 content script', error?.message);
  }
}

async function checkDownloadsPermission(): Promise<HealthCheckItem> {
  try {
    if (!chrome?.permissions?.contains) {
      return warn('downloads', '下载权限', 'chrome.permissions API 不可用，无法检查 downloads 权限');
    }
    const granted = await new Promise<boolean>((resolve) => {
      chrome.permissions.contains({ permissions: ['downloads'] }, resolve);
    });
    return granted
      ? ok('downloads', '下载权限', 'downloads 权限已授予')
      : fail('downloads', '下载权限', '缺少 downloads 权限，真实导出/下载捕获会失败');
  } catch (error: any) {
    return fail('downloads', '下载权限', '检查 downloads 权限失败', error?.message);
  }
}

async function checkPaddleOcrAssets(): Promise<HealthCheckItem> {
  try {
    const options = getPaddleOcrRuntimeOptions();
    const urls = [
      options.sandboxUrl,
      options.textDetectionModelAsset.url,
      options.textRecognitionModelAsset.url,
      `${options.ortOptions.wasmPaths}ort-wasm-simd.wasm`,
    ];
    const results = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return { url, ok: response.ok, status: response.status };
    }));
    const failed = results.filter((item) => !item.ok);
    if (failed.length) {
      return fail(
        'paddleocr',
        'PaddleOCR 资源',
        'PaddleOCR sandbox、模型或 ORT wasm 资源缺失',
        failed.map((item) => `${item.status} ${item.url}`).join('\n'),
      );
    }
    return ok('paddleocr', 'PaddleOCR 资源', 'sandbox、模型和 ORT wasm 资源可访问');
  } catch (error: any) {
    return fail('paddleocr', 'PaddleOCR 资源', '检查 PaddleOCR 资源失败', error?.message);
  }
}

async function checkDocumentDb(): Promise<HealthCheckItem> {
  try {
    const health = await checkDocumentRepositoryHealth();
    if (!health.success) return fail('documents', '资料库', '资料库 schema 不完整', `缺少：${health.missingStores.join('、')}`);
    return ok('documents', '资料库', `IndexedDB v${health.version} 可读，当前资料 ${health.assetCount} 个`, health.stores.join(', '));
  } catch (error: any) {
    return fail('documents', '资料库', '资料中心 IndexedDB 读取失败', error?.message);
  }
}

async function checkTraceRead(): Promise<HealthCheckItem> {
  try {
    const response = await sendRuntimeMessage({
      type: 'EXECUTE_TOOL',
      toolName: 'get_task_trace',
      arguments: {},
    });
    if (response?.success === false && /未登录|登录/.test(String(response.error || response.message || ''))) {
      return warn('trace', '任务轨迹', '任务轨迹工具需要登录后检查', response.error || response.message);
    }
    if (response?.success === false) {
      return fail('trace', '任务轨迹', '任务轨迹工具不可用', response.error || response.message);
    }
    return ok('trace', '任务轨迹', '任务轨迹工具可响应');
  } catch (error: any) {
    return fail('trace', '任务轨迹', '读取任务轨迹失败', error?.message);
  }
}

export async function runPluginHealthCheck(): Promise<HealthCheckItem[]> {
  return Promise.all([
    checkBackground(),
    checkModelProfile(),
    checkAuth(),
    checkContentScript(),
    checkDownloadsPermission(),
    checkPaddleOcrAssets(),
    checkDocumentDb(),
    checkTraceRead(),
  ]);
}
