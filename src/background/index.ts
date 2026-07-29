import type { ModelMessage as Message } from '../shared/model/modelRuntimeTypes';
import { ModelGateway, ModelGatewayError } from './model/modelGateway';
import {
  deleteModelProfile,
  listModelProfiles,
  setActiveModelProfile,
  toPublicModelProfile,
  upsertModelProfile,
  type ModelProfile,
} from '../shared/model/modelProfiles';
import { AutomationRunner } from './tasks/automation';
import { ComputerUseRunner } from './browserUse/runtime/computerUseRunner';
import { BrowserUseSession } from './browserUse/runtime/browserUseSession';
import { purgeRemovedLegacyData } from './maintenance/removedLegacyData';
import { createComputerUseResumeCheckpoint } from './browserUse/runtime/computerUseCheckpoint';
import { understandComputerUseIntent as understandComputerUseIntentCore } from './browserUse/planning/computerUseIntent';
import { createComputerUsePlan as createComputerUsePlanCore } from './browserUse/planning/computerUsePlanner';
import { parseComputerUseTask } from './browserUse/planning/computerUseTaskParser';
import { performDownloadFileAction } from './browserUse/actions/downloadManager';
import { getComputerUseTrace, listComputerUseTraces, recordComputerUseTraceEvent } from './browserUse/runtime/computerUseTrace';
import {
  clearPageMonitorAlarm,
  handlePageMonitorAlarm,
  runPageMonitorNow,
  syncPageMonitorAlarms,
  upsertPageMonitorAlarm,
} from './tasks/pageMonitorRunner';
import type {
  AutomationRun,
  AutomationRunTraceSummary,
  AutomationWorkflow,
  BrowserObservation,
  ComputerUseAction,
  ComputerUseIntent,
  ComputerUsePageContext,
  ComputerUsePlan,
  ComputerUseNeedsConfirmationMessage,
  ComputerUsePhase,
  ComputerUsePhaseMemory,
  ComputerUseRunState,
  ComputerUseTaskIntent,
  ComputerUseResumeCheckpoint,
} from '../shared/automation/automationTypes';
import { getAutomationRun, listAutomationRuns, patchAutomationRun } from '../shared/automation/automationRunStore';
import { createBackgroundMessageRouter } from './handlers/backgroundMessageRouter';
import { TaskExecutorRegistry, type TaskResult } from './tasks/taskExecutorRegistry';
import { TaskRuntimeService } from './tasks/taskRuntimeService';
import { getAutomationWorkflow } from '../shared/automation/automationWorkflowStore';
import { runOcrTask, stopOcrTask } from './ocr/ocrJobService';
import { BUSINESS_TOOL_NAMES } from '../shared/tools/businessTools';
import type { PageAuthSnapshot } from '../shared/auth/authBridge';
import type { DocumentAsset, DocumentContent, PageStructuredData, RequirementTaskResult } from '../shared/documents/documentTypes';
import {
  extractJsonObject,
  isAuthenticatedValue,
  normalizeRequirementTaskResult,
  UNAUTHENTICATED_RESPONSE,
} from './business/businessHelpers';
import {
  generateRequirementTaskResult,
  getDocumentAsset,
  getDocumentChunks,
  getDocumentContent,
  listDocumentAssets,
  makeDocumentId,
  rebuildDocumentChunks,
  saveDocumentContent,
  searchDocuments,
  upsertDocumentAsset,
  upsertDocumentResult,
} from '../shared/documents/documentRepository';
import { AppError, toAppErrorPayload } from '../shared/errors/appErrors';
import { resolveBrowserContextTabId } from './browserUse/observation/browserTabContext';
import { RUNTIME_BUILD_ID, isRuntimeVersionCurrent, runtimeMismatchMessage, type RuntimeVersionInfo } from '../shared/runtime/runtimeVersion';
import { collectPageContextHub } from '../shared/context/pageContextHub';
import { collectDocumentContextHub } from '../shared/context/documentContextHub';

const modelGateway = new ModelGateway();
let modelGatewayEventsInitialized = false;

// 存储 sidePanel 的打开状态
const sidePanelOpenState = new Map<number, boolean>();

const computerUseRunners = new Map<string, AbortController>();
const computerUseConfirmations = new Map<string, (allowed: boolean) => void>();
let taskExecutorRegistry: TaskExecutorRegistry | null = null;
let taskRuntimeService: TaskRuntimeService | null = null;

const dingTalkAuthTabs = new Set<number>();

const TRUSTED_AUTH_HOST_SUFFIXES = [
  'gancao.com',
  'igancao.cn',
  'localhost',
  '127.0.0.1',
];

const COMPUTER_USE_LLM_TIMEOUT_MS = 8000;

function slimObservationForPrompt(observation: BrowserObservation): any {
  return {
    url: observation.url,
    title: observation.title,
    pageState: observation.pageState,
    viewport: observation.viewport,
    scroll: observation.scroll,
    elements: observation.elements.slice(0, 80).map((element) => ({
      elementId: element.elementId,
      role: element.role,
      tag: element.tag,
      text: element.text,
      purpose: element.purpose,
      score: element.score,
      selector: element.selector,
      bbox: element.bbox,
      visible: element.visible,
      enabled: element.enabled,
      value: element.value,
      checked: element.checked,
      placeholder: element.placeholder,
      href: element.href,
    })),
  };
}

async function callComputerUseJson(system: string, user: unknown, profileId?: string): Promise<unknown> {
  return modelGateway.callJson({ system, user, timeoutMs: COMPUTER_USE_LLM_TIMEOUT_MS, profileId });
}

async function planComputerUseAction(input: {
  goal: string;
  stepIndex: number;
  observation: BrowserObservation;
  history: Array<{ action?: ComputerUseAction; result?: unknown }>;
}, profileId?: string): Promise<ComputerUseAction> {
  const parsed = await callComputerUseJson(
    [
      '你是浏览器 Computer Use 执行器，每次只输出一个 JSON 动作。',
      '可选 action: open_tab,switch_tab,close_tab,go_back,go_forward,reload,click,double_click,right_click,click_by_coordinate,type,clear_input,focus,keyboard_shortcut,press_key,select_option,check,hover,drag,scroll,wait,wait_for_element,upload_file,download_file,extract_table,finish。',
      '优先使用 observation.elements 中的 elementId；没有可靠目标时返回 finish，并在 summary 中说明阻塞原因，禁止猜测点击。',
      '高风险动作必须设置 highRisk:true。',
    ].join('\n'),
    {
      goal: input.goal,
      stepIndex: input.stepIndex,
      observation: slimObservationForPrompt(input.observation),
      history: input.history.slice(-6),
    },
    profileId,
  );
  if (!parsed || typeof parsed !== 'object' || !(parsed as ComputerUseAction).action) {
    throw new ModelGatewayError('MODEL_INVALID_RESPONSE', 'Computer Use 规划结果缺少 action。');
  }
  return parsed as ComputerUseAction;
}

async function understandComputerUseIntentWithLLM(goal: string, taskIntent?: ComputerUseTaskIntent, profileId?: string): Promise<ComputerUseIntent> {
  return await understandComputerUseIntentCore({
    goal,
    taskIntent,
    callLLM: ({ system, user }) => callComputerUseJson(system, user, profileId),
  });
}

async function createComputerUsePlanWithLLM(input: {
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  history: Array<{ action?: ComputerUseAction; result?: unknown; verification?: unknown; plan?: ComputerUsePlan }>;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}, profileId?: string): Promise<ComputerUsePlan> {
  return await createComputerUsePlanCore({
    ...input,
    callLLM: ({ system, user }) => callComputerUseJson(system, user, profileId),
  });
}

function waitForComputerUseConfirmation(message: ComputerUseNeedsConfirmationMessage): Promise<boolean> {
  const key = `${message.runId}:${message.stepIndex}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      computerUseConfirmations.delete(key);
      resolve(false);
    }, 120000);
    computerUseConfirmations.set(key, (allowed) => {
      clearTimeout(timer);
      computerUseConfirmations.delete(key);
      resolve(allowed);
    });
  });
}

type ConsoleDiagnosticsLevel = 'error' | 'warning';

interface ConsoleDiagnosticsEntry {
  id: string;
  level: ConsoleDiagnosticsLevel;
  source: 'runtime.exception' | 'console' | 'log' | 'network' | 'content-script';
  message: string;
  stack?: string;
  url?: string;
  title?: string;
  timestamp: number;
  line?: number;
  column?: number;
  resourceUrl?: string;
}

interface ConsoleDiagnosticsResult {
  success: true;
  source: 'chrome.debugger' | 'content-script' | 'hybrid';
  url?: string;
  title?: string;
  capturedAt: number;
  durationMs?: number;
  count: number;
  errors: ConsoleDiagnosticsEntry[];
  note: string;
  fallback?: any;
}

function makeConsoleDiagnosticId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debuggerCommand<T = any>(
  target: chrome.debugger.Debuggee,
  method: string,
  commandParams?: Record<string, any>
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, commandParams, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result as T);
    });
  });
}

function attachDebugger(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function stringifyRemoteObject(value: any): string {
  if (!value) return '';
  if (typeof value.description === 'string' && value.description.trim()) return value.description;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value !== 'undefined') {
    try {
      return JSON.stringify(value.value);
    } catch {
      return String(value.value);
    }
  }
  if (typeof value.unserializableValue === 'string') return value.unserializableValue;
  return value.type || '';
}

function stackTraceToString(stackTrace: any): string | undefined {
  const callFrames = stackTrace?.callFrames;
  if (!Array.isArray(callFrames) || callFrames.length === 0) return undefined;
  return callFrames
    .map((frame: any) => {
      const location = `${frame.url || '<anonymous>'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`;
      return `at ${frame.functionName || '<anonymous>'} (${location})`;
    })
    .join('\n');
}

async function collectConsoleDiagnostics(tabId: number, args: any = {}): Promise<ConsoleDiagnosticsResult> {
  if (!chrome.debugger) {
    throw new Error('当前浏览器不支持 chrome.debugger API');
  }

  const durationMs = Math.max(1000, Math.min(Number(args.durationMs || 3500), 15000));
  const limit = Math.max(1, Math.min(Number(args.limit || 50), 200));
  const target: chrome.debugger.Debuggee = { tabId };
  const requestUrls = new Map<string, string>();
  const errors: ConsoleDiagnosticsEntry[] = [];
  const tab = await chrome.tabs.get(tabId);

  const pushError = (entry: Omit<ConsoleDiagnosticsEntry, 'id' | 'timestamp' | 'url' | 'title'> & Partial<Pick<ConsoleDiagnosticsEntry, 'timestamp' | 'url' | 'title'>>) => {
    errors.push({
      id: makeConsoleDiagnosticId('debugger'),
      timestamp: Date.now(),
      url: tab.url,
      title: tab.title,
      ...entry,
    });
    if (errors.length > limit) {
      errors.splice(0, errors.length - limit);
    }
  };

  const listener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
    if (source.tabId !== tabId) return;

    if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails || {};
      const message = stringifyRemoteObject(details.exception) || details.text || '页面运行时异常';
      pushError({
        source: 'runtime.exception',
        level: 'error',
        message,
        stack: details.exception?.description || stackTraceToString(details.stackTrace),
        line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : undefined,
        column: typeof details.columnNumber === 'number' ? details.columnNumber + 1 : undefined,
      });
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      const type = String(params?.type || '');
      if (!['error', 'warning', 'assert'].includes(type)) return;
      const message = Array.isArray(params?.args)
        ? params.args.map(stringifyRemoteObject).filter(Boolean).join(' ')
        : '控制台输出';
      pushError({
        source: 'console',
        level: type === 'warning' ? 'warning' : 'error',
        message: message || `console.${type}`,
        stack: stackTraceToString(params?.stackTrace),
      });
      return;
    }

    if (method === 'Log.entryAdded') {
      const entry = params?.entry || {};
      if (!['error', 'warning'].includes(entry.level)) return;
      pushError({
        source: 'log',
        level: entry.level === 'warning' ? 'warning' : 'error',
        message: entry.text || '浏览器日志错误',
        resourceUrl: entry.url,
        line: typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined,
      });
      return;
    }

    if (method === 'Network.requestWillBeSent' && params?.requestId) {
      requestUrls.set(params.requestId, params.request?.url || '');
      return;
    }

    if (method === 'Network.loadingFailed') {
      const resourceUrl = params?.requestId ? requestUrls.get(params.requestId) : undefined;
      pushError({
        source: 'network',
        level: 'error',
        message: `网络请求失败: ${params?.errorText || 'unknown'}`,
        resourceUrl,
      });
    }
  };

  let attached = false;
  try {
    await attachDebugger(target);
    attached = true;
    chrome.debugger.onEvent.addListener(listener);
    await Promise.allSettled([
      debuggerCommand(target, 'Runtime.enable'),
      debuggerCommand(target, 'Log.enable'),
      debuggerCommand(target, 'Network.enable'),
      debuggerCommand(target, 'Page.enable'),
    ]);

    if (args.reload === true) {
      await chrome.tabs.reload(tabId);
    }

    await sleep(durationMs);
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    if (attached) {
      await detachDebugger(target);
    }
  }

  return {
    success: true,
    source: 'chrome.debugger',
    url: tab.url,
    title: tab.title,
    capturedAt: Date.now(),
    durationMs,
    count: errors.length,
    errors,
    note: '通过 chrome.debugger 采集，不需要打开 DevTools；只能捕获 attach 之后发生的异常、控制台错误、日志和网络失败。',
  };
}

async function collectConsoleDiagnosticsWithFallback(tabId: number, args: any = {}): Promise<ConsoleDiagnosticsResult> {
  let debuggerResult: ConsoleDiagnosticsResult | null = null;
  let fallback: any = null;

  try {
    debuggerResult = await collectConsoleDiagnostics(tabId, args);
  } catch (error: any) {
    fallback = { success: false, error: error?.message || 'debugger 采集失败' };
  }

  if (args.includeContentFallback !== false) {
    try {
      fallback = await executeBrowserTool(tabId, 'get_console_errors', {
        limit: args.limit ?? 50,
        since: args.since,
      });
    } catch (error: any) {
      fallback = { success: false, error: error?.message || 'content script 采集失败' };
    }
  }

  const fallbackErrors = Array.isArray(fallback?.errors)
    ? fallback.errors
    : Array.isArray(fallback?.result?.errors)
      ? fallback.result.errors
      : [];
  const normalizedFallbackErrors: ConsoleDiagnosticsEntry[] = fallbackErrors.map((entry: any) => ({
    id: entry.id || makeConsoleDiagnosticId('content'),
    level: entry.level === 'warning' ? 'warning' : 'error',
    source: 'content-script',
    message: String(entry.message || ''),
    stack: entry.stack,
    url: entry.url,
    title: entry.title,
    timestamp: Number(entry.timestamp || Date.now()),
    line: entry.line,
    column: entry.column,
    resourceUrl: entry.resourceUrl,
  }));

  if (!debuggerResult) {
    const tab = await chrome.tabs.get(tabId);
    return {
      success: true,
      source: 'content-script',
      url: tab.url,
      title: tab.title,
      capturedAt: Date.now(),
      count: normalizedFallbackErrors.length,
      errors: normalizedFallbackErrors,
      note: fallback?.error
        ? `debugger 采集不可用，已回退 content script。debugger 错误：${fallback.error}`
        : '已回退 content script 采集；只能读取插件注入后发生的错误。',
      fallback,
    };
  }

  const merged = [...debuggerResult.errors, ...normalizedFallbackErrors]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-Math.max(1, Math.min(Number(args.limit || 50), 200)));

  return {
    ...debuggerResult,
    source: 'hybrid',
    count: merged.length,
    errors: merged,
    note: `${debuggerResult.note} 同时合并 content script 缓存作为兜底。`,
    fallback,
  };
}


// 获取当前活动标签页
async function getCurrentActiveTab(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id || null;
  } catch (error) {
    console.error('获取活动标签页失败:', error);
    return null;
  }
}

function getTabContentAccessError(tab?: chrome.tabs.Tab): string | null {
  const url = tab?.url || '';
  if (!url) return '当前标签页没有可访问的 URL，请切换到普通网页后重试。';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `当前页面地址不可识别，无法自动操作：${url}`;
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return null;

  if (parsed.protocol === 'file:') {
    return '当前是本地 file:// 页面。Chrome 需要在扩展详情页开启“允许访问文件网址”后才能注入脚本；建议先切换到 http/https 业务网页重试。';
  }

  const blockedProtocolLabels: Record<string, string> = {
    'chrome:': 'Chrome 内置页面',
    'chrome-extension:': '扩展页面',
    'devtools:': '开发者工具页面',
    'edge:': 'Edge 内置页面',
    'brave:': 'Brave 内置页面',
    'about:': '浏览器内部页面',
    'chrome-search:': 'Chrome 搜索/新标签页',
    'view-source:': '源码查看页面',
  };

  const label = blockedProtocolLabels[parsed.protocol] || `${parsed.protocol}// 页面`;
  return `${label}不能被扩展自动操作。这不是普通 host 权限问题，Chrome 不允许 content script 访问这类页面。请先切换到 http/https 业务网页，或在指令中提供要打开的完整网址后重试。`;
}

async function getCurrentAutomatableTab(): Promise<{ tabId: number; tab: chrome.tabs.Tab } | { error: string }> {
  const tabId = await getCurrentActiveTab();
  if (!tabId) return { error: '无法获取活动标签页' };

  const tab = await chrome.tabs.get(tabId);
  const accessError = getTabContentAccessError(tab);
  if (accessError) return { error: accessError };

  return { tabId, tab };
}

async function assertCanAccessTabContent(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const accessError = getTabContentAccessError(tab);
  if (accessError) throw new Error(accessError);
}

async function isBusinessAuthenticated(): Promise<boolean> {
  const result = await chrome.storage.local.get('user_auth');
  return isAuthenticatedValue(result.user_auth);
}

async function requireBusinessAuth(): Promise<typeof UNAUTHENTICATED_RESPONSE | null> {
  return await isBusinessAuthenticated() ? null : UNAUTHENTICATED_RESPONSE;
}

function broadcastDocumentCenterUpdated(payload: Record<string, unknown> = {}): void {
  chrome.runtime.sendMessage({
    type: 'DOCUMENT_CENTER_UPDATED',
    timestamp: Date.now(),
    ...payload,
  }).catch(() => {});
}

function isTrustedAuthUrl(urlLike: string | undefined | null): boolean {
  if (!urlLike) return false;

  try {
    const url = new URL(urlLike);
    const host = url.hostname.toLowerCase();
    return TRUSTED_AUTH_HOST_SUFFIXES.some((suffix) => {
      const normalized = suffix.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function sanitizePageAuthSnapshot(snapshot: PageAuthSnapshot) {
  const { token, ...safeSnapshot } = snapshot;
  return safeSnapshot;
}

async function clearPageAuthState(snapshot: PageAuthSnapshot, reason = 'page_logged_out'): Promise<any> {
  await chrome.storage.local.set({
    user_auth: false,
    pageAuthLastLogoutAt: Date.now(),
    pageAuthLastHost: snapshot.host,
    pageAuthLastLogoutReason: reason,
  });

  await chrome.storage.local.remove([
    'plugIn_userInfo',
    'userInfo',
    'dingtalkToken',
    'authToken',
    'authSource',
    'pageAuthSnapshot',
    'pageAuthHost',
  ]);

  return {
    success: true,
    authSource: 'page',
    loggedOut: true,
    host: snapshot.host,
    reason,
  };
}

async function savePageAuthState(snapshot: PageAuthSnapshot, sourceUrl?: string): Promise<any> {
  const trustedUrl = sourceUrl || snapshot.url;
  if (!isTrustedAuthUrl(trustedUrl) || !isTrustedAuthUrl(snapshot.url)) {
    return { success: false, error: '页面域名不在可信登录态同步范围内' };
  }

  if (!snapshot.token) {
    const current = await chrome.storage.local.get(['user_auth', 'authSource', 'pageAuthHost']);
    const samePageAuthHost = !current.pageAuthHost || current.pageAuthHost === snapshot.host;
    const pageLooksLoggedOut = snapshot.pageLooksLoggedOut === true;

    if (current.user_auth === true && pageLooksLoggedOut) {
      return await clearPageAuthState(snapshot, 'trusted_page_login_ui');
    }

    if (current.user_auth === true && current.authSource === 'page' && samePageAuthHost) {
      return await clearPageAuthState(snapshot, 'page_token_missing');
    }

    return {
      success: true,
      loggedOut: false,
      ignored: true,
      reason: '当前插件登录态不是页面同步来源',
    };
  }

  const userInfo = snapshot.userInfo ?? null;
  await chrome.storage.local.set({
    user_auth: true,
    plugIn_userInfo: userInfo,
    userInfo,
    authToken: snapshot.token,
    dingtalkToken: snapshot.token,
    authSource: 'page',
    pageAuthHost: snapshot.host,
    pageAuthSnapshot: sanitizePageAuthSnapshot(snapshot),
  });

  return {
    success: true,
    authSource: 'page',
    loggedIn: true,
    tokenKey: snapshot.tokenKey,
    tokenSource: snapshot.tokenSource,
  };
}

async function requestPageAuthSync(): Promise<any> {
  const tabId = await getCurrentActiveTab();
  if (!tabId) {
    return { success: false, error: '无法获取活动标签页' };
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isTrustedAuthUrl(tab.url)) {
    return { success: false, error: '当前活动页不在可信登录态同步范围内' };
  }

  await ensureCurrentContentRuntime(tabId);
  return await chrome.tabs.sendMessage(tabId, { type: 'READ_PAGE_AUTH_STATE' });
}

async function captureVisibleTab(tabId: number, format: 'png' | 'jpeg', quality?: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;
  return await chrome.tabs.captureVisibleTab(windowId, {
    format,
    quality: format === 'jpeg' ? quality : undefined,
  });
}

async function executeBrowserTool(tabId: number, toolName: string, args: any): Promise<any> {
  if (toolName === 'screenshot') {
    const format = args?.format || 'png';
    const quality = args?.quality || 90;
    const dataUrl = await captureVisibleTab(tabId, format as 'png' | 'jpeg', quality);
    return { success: true, message: '截图成功', dataUrl };
  }

  if (toolName === 'observe_page') {
    const observation = await executeContentTool(tabId, toolName, args);
    if (args?.includeScreenshot === true) {
      const dataUrl = await captureVisibleTab(tabId, 'png');
      return { ...normalizeContentToolResult(observation), screenshot: dataUrl };
    }
    return normalizeContentToolResult(observation);
  }

  return await executeContentTool(tabId, toolName, args);
}

function normalizeContentToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') {
    return result.result;
  }
  return result;
}

async function executeContentTool(tabId: number, toolName: string, args: any): Promise<any> {
  await assertCanAccessTabContent(tabId);
  await ensureCurrentContentRuntime(tabId);
  return await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_BROWSER_TOOL',
    toolName,
    arguments: args,
  });
}

async function readContentRuntimeInfo(tabId: number): Promise<RuntimeVersionInfo | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CONTENT_RUNTIME_INFO' });
    if (!response?.buildId) return null;
    return response as RuntimeVersionInfo;
  } catch {
    return null;
  }
}

async function waitForCurrentContentRuntime(tabId: number, timeoutMs = 15_000): Promise<RuntimeVersionInfo> {
  const deadline = Date.now() + timeoutMs;
  let latestInfo: RuntimeVersionInfo | null = null;
  while (Date.now() < deadline) {
    latestInfo = await readContentRuntimeInfo(tabId);
    if (latestInfo && isRuntimeVersionCurrent(latestInfo)) return latestInfo;
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  const error = new Error(runtimeMismatchMessage(latestInfo?.buildId)) as Error & { code?: string };
  error.code = 'EXTENSION_RUNTIME_MISMATCH';
  throw error;
}

async function ensureCurrentContentRuntime(tabId: number): Promise<RuntimeVersionInfo> {
  const current = await readContentRuntimeInfo(tabId);
  if (isRuntimeVersionCurrent(current)) return current!;

  // Do not inject over an old listener. Reloading guarantees the tab receives only
  // the content script bundled with the currently running service worker.
  await chrome.tabs.reload(tabId);
  return await waitForCurrentContentRuntime(tabId);
}

async function runComputerUseOnTab(options: {
  tabId: number;
  automationTaskId?: string;
  goal: string;
  intent?: ComputerUseTaskIntent;
  runId?: string;
  maxSteps?: number;
  startUrl?: string;
  allowHighRisk?: boolean;
  externalSignal?: AbortSignal;
  resumeCheckpoint?: ComputerUseResumeCheckpoint;
  modelProfileId?: string;
}): Promise<unknown> {
  const runId = options.runId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  options.externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const deterministicMode = (await chrome.storage.local.get('computerUseDeterministicMode')).computerUseDeterministicMode === true;
  const initialTab = await chrome.tabs.get(options.tabId);
  const tabSession = new BrowserUseSession({
    initialTabId: options.tabId,
    listTabs: async () => (await chrome.tabs.query({ windowId: initialTab.windowId }))
      .flatMap((tab) => typeof tab.id === 'number'
        ? [{
          id: tab.id,
          windowId: tab.windowId,
          openerTabId: tab.openerTabId,
          url: tab.url,
          title: tab.title,
          active: tab.active,
        }]
        : []),
  });
  await tabSession.initialize();

  return await new Promise((resolve, reject) => {
    let latestTaskPlan = options.resumeCheckpoint?.taskPlan;
    const emit = (message: any) => {
      latestTaskPlan = message?.result?.taskPlan || message?.intent?.taskPlan || latestTaskPlan;
      const resumeCheckpoint = message?.type === 'COMPUTER_USE_ERROR'
        ? createComputerUseResumeCheckpoint({
          goal: options.goal,
          taskPlan: latestTaskPlan,
          runState: message.runState,
          phaseIndex: message.phaseIndex,
          lastPageUrl: message.lastObservation?.url || message.afterObservation?.url || message.observation?.url,
        })
        : undefined;
      const eventWithTask = options.automationTaskId
        ? { ...message, automationTaskId: options.automationTaskId }
        : message;
      const msg = resumeCheckpoint && !eventWithTask.resumeCheckpoint
        ? { ...eventWithTask, resumeCheckpoint }
        : eventWithTask;
      if (typeof msg?.runId === 'string' && msg.type?.startsWith?.('COMPUTER_USE_')) {
        recordComputerUseTraceEvent(msg);
      }
      if (msg.type !== 'COMPUTER_USE_FINISHED' && msg.type !== 'COMPUTER_USE_ERROR') {
        chrome.runtime.sendMessage(msg).catch(() => {});
      }
      if (msg.type === 'COMPUTER_USE_FINISHED') {
        resolve(msg);
      } else if (msg.type === 'COMPUTER_USE_ERROR') {
        reject(new Error(msg.error));
      }
    };

    computerUseRunners.set(runId, controller);
    emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId,
      goal: options.goal,
      stepIndex: 0,
      state: 'observing',
      result: { summary: '后台已接收自动操作任务，正在准备观察当前页面...' },
    });

    const intent = options.intent || parseComputerUseTask(options.goal, options.startUrl);
    const runPromise = new ComputerUseRunner({
        tabId: options.tabId,
        tabSession,
        runId,
        goal: options.goal,
        maxSteps: Math.max(1, Math.min(Number(options.maxSteps || 8), 30)),
        startUrl: intent.actionType === 'search' ? options.startUrl : options.startUrl || intent.startUrl,
        allowHighRisk: options.allowHighRisk === true,
        signal: controller.signal,
        navigate: navigateTab,
        executeBrowserTool,
        tabActionDeps: {
          createTab: async ({ url, active, openerTabId }) => {
            const tab = await chrome.tabs.create({ url, active, openerTabId });
            if (typeof tab.id !== 'number') throw new Error('创建标签页失败：缺少标签页 ID');
            const readyTab = await waitForBrowserUseTabReady(tab.id, 30_000, controller.signal);
            return {
              id: tab.id,
              windowId: readyTab.windowId,
              openerTabId: readyTab.openerTabId,
              url: readyTab.url,
              title: readyTab.title,
              active: readyTab.active,
            };
          },
          activateTab: async (tabId) => { await chrome.tabs.update(tabId, { active: true }); },
          closeTab: async (tabId) => { await chrome.tabs.remove(tabId); },
          goBack: async (tabId) => { await chrome.tabs.goBack(tabId); },
          goForward: async (tabId) => { await chrome.tabs.goForward(tabId); },
          reload: async (tabId) => { await chrome.tabs.reload(tabId); },
        },
        executeDownloadAction: ({ action, pageUrl, tabId }) => performDownloadFileAction({
          runId,
          tabId,
          pageUrl,
          action,
          click: () => executeContentTool(tabId, 'click_element', action),
        }),
        understandIntent: ({ goal }) => deterministicMode
          ? understandComputerUseIntentCore({ goal, taskIntent: intent })
          : understandComputerUseIntentWithLLM(goal, intent, options.modelProfileId),
        createPlan: deterministicMode
          ? (input) => createComputerUsePlanCore(input)
          : (input) => createComputerUsePlanWithLLM(input, options.modelProfileId),
        planNextAction: (input) => planComputerUseAction(input, options.modelProfileId),
        confirmAction: waitForComputerUseConfirmation,
        emit,
        resumeCheckpoint: options.resumeCheckpoint,
      }).run();

    runPromise.finally(() => {
      options.externalSignal?.removeEventListener('abort', abortFromExternal);
      computerUseRunners.delete(runId);
    });
  });
}

function summarizeComputerUseTrace(runId: string): { traceSummary: AutomationRunTraceSummary; traceSnapshot: unknown; checkpoint?: ComputerUseResumeCheckpoint } {
  const trace = getComputerUseTrace(runId);
  const entries = trace?.entries || [];
  const lastEntry = entries[entries.length - 1] as any;
  const lastObservation = [...entries].reverse().find((entry: any) => entry.observation)?.observation as BrowserObservation | undefined;
  const phaseEntries = entries.filter((entry: any) => entry.phaseType || entry.phaseGoal);
  const lastRunState = [...entries].reverse().find((entry: any) => entry.runState)?.runState;
  const taskPlan = (entries.find((entry: any) => entry.result?.taskPlan) as any)?.result?.taskPlan
    || entries.find((entry: any) => entry.plan)?.intent?.taskPlan;
  const checkpoint = trace?.status === 'error' && lastRunState && taskPlan
    ? {
      goal: trace.goal,
      taskPlan,
      phaseIndex: Number(lastEntry?.phaseIndex ?? lastRunState.currentPhaseIndex ?? 0),
      runState: lastRunState,
      lastPageUrl: lastObservation?.url,
      createdAt: Date.now(),
    } satisfies ComputerUseResumeCheckpoint
    : undefined;
  return {
    traceSnapshot: trace || null,
    traceSummary: {
      traceRunId: runId,
      entryCount: entries.length,
      phaseCount: new Set(phaseEntries.map((entry: any) => `${entry.phaseIndex ?? ''}:${entry.phaseType ?? ''}:${entry.phaseGoal ?? ''}`)).size,
      currentPhase: lastEntry?.phaseGoal || lastEntry?.phaseType,
      lastAction: lastEntry?.action?.action,
      lastPageTitle: lastObservation?.title,
      lastPageUrl: lastObservation?.url,
      lastError: lastEntry?.error,
      lastVerification: lastEntry?.verification ? JSON.stringify(lastEntry.verification).slice(0, 500) : undefined,
      },
    checkpoint,
  };
}

async function executeComputerUseTask(run: AutomationRun, signal: AbortSignal): Promise<TaskResult> {
  const goal = String(run.goal || '').trim();
  if (!goal) return { status: 'failed', summary: '任务缺少目标描述', error: '任务缺少目标描述' };

  const authError = await requireBusinessAuth();
  if (authError) return { status: 'failed', summary: authError.error || '未登录', error: authError.error || '未登录' };

  const explicitStartUrl = typeof run.metadata?.startUrl === 'string' ? String(run.metadata.startUrl).trim() : '';
  const intent = parseComputerUseTask(goal, explicitStartUrl);
  const startUrl = intent.startUrl || '';
  if (startUrl) {
    const startUrlAccessError = getTabContentAccessError({ url: startUrl } as chrome.tabs.Tab);
    if (startUrlAccessError) return { status: 'failed', summary: `起始页面不可自动操作：${startUrlAccessError}`, error: `起始页面不可自动操作：${startUrlAccessError}` };
  }

  const tabId = await getCurrentActiveTab();
  if (!tabId) return { status: 'failed', summary: '无法获取活动标签页', error: '无法获取活动标签页' };
  if (!startUrl) {
    const tabCheck = await getCurrentAutomatableTab();
    if ('error' in tabCheck) return { status: 'failed', summary: tabCheck.error, error: tabCheck.error };
  }

  const computerUseRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const resumeCheckpoint = (run.metadata?.resumeCheckpoint || undefined) as ComputerUseResumeCheckpoint | undefined;
  await patchAutomationRun(run.id, { metadata: { ...(run.metadata || {}), computerUseRunId } });
  try {
    const result: any = await runComputerUseOnTab({
      tabId,
      automationTaskId: run.id,
      runId: computerUseRunId,
      goal,
      intent,
      maxSteps: Number(run.metadata?.maxSteps || 12),
      startUrl: startUrl || undefined,
      allowHighRisk: run.metadata?.allowHighRisk === true,
      externalSignal: signal,
      resumeCheckpoint,
      modelProfileId: typeof run.metadata?.modelProfileId === 'string' ? run.metadata.modelProfileId : undefined,
    });
    const { traceSummary, traceSnapshot } = summarizeComputerUseTrace(computerUseRunId);
    await patchAutomationRun(run.id, {
      metadata: { ...(run.metadata || {}), computerUseRunId, resumeCheckpoint: undefined },
    });
    return {
      status: result?.result?.partial ? 'partial' : 'success',
      summary: result?.summary || '自动操作完成',
      output: result,
      trace: { traceSummary, traceSnapshot, computerUseRunId },
    };
  } catch (error: any) {
    const { traceSummary, traceSnapshot, checkpoint } = summarizeComputerUseTrace(computerUseRunId);
    await patchAutomationRun(run.id, {
      metadata: { ...(run.metadata || {}), computerUseRunId, resumeCheckpoint: checkpoint },
    });
    return {
      status: signal.aborted || error?.message === '已停止' ? 'stopped' : 'failed',
      summary: error?.message || '自动操作失败',
      error: error?.message || '自动操作失败',
      trace: { traceSummary, traceSnapshot, computerUseRunId },
    };
  }
}

async function executePageDiagnosisTask(run: AutomationRun): Promise<TaskResult> {
  const tabId = await getCurrentActiveTab();
  if (!tabId) return { status: 'failed', summary: '无法获取活动标签页', error: '无法获取活动标签页' };
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const contentAccessError = getTabContentAccessError(tab);
  if (contentAccessError) return { status: 'failed', summary: contentAccessError, error: contentAccessError };

  const context = await collectPageContextHub({
    executeTool: async (toolName, args = {}) => {
      const browserToolName = toolName === 'get_current_page_info' ? 'get_page_info' : toolName;
      return executeBrowserTool(tabId, browserToolName, args);
    },
    collectConsoleErrors: () => run.metadata?.useDebugger === true
      ? collectConsoleDiagnosticsWithFallback(tabId, {
        limit: 50,
        durationMs: Number(run.metadata?.durationMs || 3500),
        reload: run.metadata?.reload === true,
        includeContentFallback: true,
      })
      : executeBrowserTool(tabId, 'get_console_errors', { limit: 50 }),
    includeStructuredData: true,
    includeTables: true,
    observeLimit: 180,
  });
  const answer = await modelGateway.completeText({
    system: '你是页面诊断助手。请按“问题摘要、风险等级、可能原因、定位步骤、修复建议、需要补充的信息”输出，禁止编造未采集到的错误。',
    user: { goal: run.goal || '诊断当前页面', context },
    profileId: typeof run.metadata?.modelProfileId === 'string' ? run.metadata.modelProfileId : undefined,
  });
  return { status: 'success', summary: '页面诊断完成', output: { answer, context } };
}

async function executeDocumentQaTask(run: AutomationRun): Promise<TaskResult> {
  const question = String(run.goal || run.metadata?.question || '').trim();
  if (!question) return { status: 'failed', summary: '请输入资料问题', error: '请输入资料问题' };
  const documentIds = Array.isArray(run.metadata?.documentIds) ? run.metadata?.documentIds.map(String) : undefined;
  const context = await collectDocumentContextHub({
    question,
    documentIds,
    limit: 8,
    fallbackDocumentLimit: 3,
  });
  if (!context.sources.length) {
    return { status: 'failed', summary: '资料中心没有可读取内容', error: '资料中心没有可读取内容' };
  }
  const answer = await modelGateway.completeText({
    system: '你是资料问答助手。先给结论，再标注引用来源（文件名、页码、章节或 chunk），明确不确定和缺失信息。只依据给定资料回答。',
    user: { question, sources: context.sources, warnings: context.warnings },
    profileId: typeof run.metadata?.modelProfileId === 'string' ? run.metadata.modelProfileId : undefined,
  });
  return {
    status: context.matchedBySearch ? 'success' : 'partial',
    summary: context.matchedBySearch ? '资料问答完成' : '资料问答完成（使用全文兜底）',
    output: { answer, sources: context.sources, warnings: context.warnings },
  };
}

async function executeExtractTask(run: AutomationRun): Promise<TaskResult> {
  const mode = String(run.metadata?.extractMode || 'structured');
  const toolName = mode === 'tables' ? 'extract_page_tables' : 'extract_page_structured_data';
  const tabId = await getCurrentActiveTab();
  if (!tabId) return { status: 'failed', summary: '无法获取活动标签页', error: '无法获取活动标签页' };
  const output = await executeBrowserTool(tabId, toolName, {});
  const result = output?.result || output;
  const count = mode === 'tables'
    ? Number(result?.tables?.length || 0)
    : Number(result?.tables?.length || 0) + Number(result?.fields?.length || 0) + Number(result?.lists?.length || 0);
  if (!count) return { status: 'partial', summary: '页面中未提取到结构化数据', output: result };
  return { status: 'success', summary: `已提取 ${count} 组结构化数据`, output: result };
}

async function executeWorkflowTask(
  run: AutomationRun,
  context: { signal: AbortSignal; progress(stage: string, message: string, data?: unknown): void },
): Promise<TaskResult> {
  const { signal } = context;
  const workflowId = String(run.workflowId || run.metadata?.workflowId || '');
  const stored = workflowId ? await getAutomationWorkflow(workflowId) : null;
  const sourceWorkflow = stored?.workflow || run.metadata?.workflow as AutomationWorkflow | undefined;
  const runtimeVariables = run.metadata?.variables && typeof run.metadata.variables === 'object'
    ? run.metadata.variables as Record<string, unknown>
    : {};
  const workflow = sourceWorkflow ? {
    ...sourceWorkflow,
    variables: { ...(sourceWorkflow.variables || {}), ...runtimeVariables },
  } : undefined;
  if (!workflow?.steps?.length) return { status: 'failed', summary: '工作流不存在或步骤为空', error: '工作流不存在或步骤为空' };
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (!tab.id) return { status: 'failed', summary: '无法创建工作流标签页', error: '无法创建工作流标签页' };
  const workflowRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return await new Promise<TaskResult>((resolve) => {
    const runner = new AutomationRunner({
      tabId: tab.id!, runId: workflowRunId, workflow, navigate: navigateTab, executeBrowserTool, captureVisibleTab,
      runComputerUse: (goal, options) => runComputerUseOnTab({ ...options, goal, externalSignal: signal }),
      emit: (event: any) => {
        if (event.type === 'WORKFLOW_RUN_PROGRESS') {
          context.progress(
            'workflow_step',
            `步骤 ${event.stepIndex + 1} ${event.state === 'done' ? '完成' : '执行中'}：${event.step.type}`,
            { event },
          );
        }
        if (event.type === 'WORKFLOW_RUN_FINISHED') resolve({ status: 'success', summary: '工作流执行完成', output: event.result, trace: event.result?.steps });
        if (event.type === 'WORKFLOW_RUN_ERROR') resolve({ status: signal.aborted ? 'stopped' : 'failed', summary: event.error, error: event.error });
      },
    });
    signal.addEventListener('abort', () => runner.stop(), { once: true });
    runner.run();
  });
}

function getTaskExecutorRegistry(): TaskExecutorRegistry {
  if (taskExecutorRegistry) return taskExecutorRegistry;
  taskExecutorRegistry = new TaskExecutorRegistry()
    .register({
      kind: 'browser_use',
      async validate(run) {
        if (!String(run.goal || '').trim()) throw new Error('任务缺少目标描述');
      },
      run: (run, context) => executeComputerUseTask(run, context.signal),
    })
    .register({
      kind: 'page_monitor',
      async validate(run) {
        if (!(run.metadata as any)?.monitor?.url) throw new Error('监控配置缺少 URL');
      },
      async run(run) {
        const result = await runPageMonitorNow(run.id, { executeBrowserTool }, { manageTaskLifecycle: false });
        const latest = await getAutomationRun(run.id);
        return {
          status: result.success ? (latest?.status === 'success' ? 'success' : 'partial') : 'failed',
          summary: latest?.resultSummary || result.error || '页面监控完成',
          output: result,
          error: result.error,
          trace: latest?.traceSummary,
        };
      },
    })
    .register({ kind: 'page_diagnosis', validate: async () => undefined, run: (run) => executePageDiagnosisTask(run) })
    .register({
      kind: 'document_qa',
      async validate(run) { if (!String(run.goal || run.metadata?.question || '').trim()) throw new Error('请输入资料问题'); },
      run: (run) => executeDocumentQaTask(run),
    })
    .register({ kind: 'extract', validate: async () => undefined, run: (run) => executeExtractTask(run) })
    .register({
      kind: 'ocr',
      async validate(run) { if (!run.metadata?.assetId) throw new Error('OCR 任务缺少资料 ID'); },
      run: (run) => runOcrTask(run),
      stop: (runId) => stopOcrTask(runId),
    })
    .register({
      kind: 'workflow',
      async validate(run) { if (!run.workflowId && !run.metadata?.workflowId && !run.metadata?.workflow) throw new Error('请选择工作流'); },
      run: (run, context) => executeWorkflowTask(run, context),
    });
  return taskExecutorRegistry;
}

function getTaskRuntimeService(): TaskRuntimeService {
  if (taskRuntimeService) return taskRuntimeService;
  taskRuntimeService = new TaskRuntimeService({
    registry: getTaskExecutorRegistry(),
    repository: {
      get: getAutomationRun,
      list: listAutomationRuns,
      patch: patchAutomationRun,
    },
    authorize: async () => {
      const authError = await requireBusinessAuth();
      if (authError) {
        throw new AppError('UNAUTHENTICATED', authError.error || '未登录');
      }
    },
    emit: (event) => {
      chrome.runtime.sendMessage(event).catch(() => {});
    },
    getSecrets: async () => (await listModelProfiles()).map((profile) => profile.apiKey).filter(Boolean),
  });
  return taskRuntimeService;
}

async function generateRequirementTasksWithLLM(
  assets: DocumentAsset[],
  chunks: Awaited<ReturnType<typeof getDocumentChunks>>[],
  fallback: RequirementTaskResult
): Promise<RequirementTaskResult> {
  const flatChunks = chunks.flat();
  const documentIds = assets.map((asset) => asset.id);
  const chunkContext = flatChunks.slice(0, 24).map((chunk) => ({
    documentId: chunk.assetId,
    chunkId: chunk.id,
    title: chunk.title,
    pageNumber: chunk.pageNumber,
    sectionTitle: chunk.sectionTitle,
    text: chunk.text.slice(0, 1800),
  }));

  if (chunkContext.length === 0) return fallback;

  const parsed = await modelGateway.callJson({
    system: '你是研发需求拆解助手。只返回 JSON，不要 markdown。字段必须符合 RequirementTaskResult，tasks 必须包含 title/module/type/priority/description/acceptanceCriteria/dependencies/risks/openQuestions/sourceRefs。',
    user: {
      documents: assets.map((asset) => ({ id: asset.id, title: asset.title })),
      chunks: chunkContext,
      fallbackHint: fallback.summary,
    },
  });
  return normalizeRequirementTaskResult(parsed, fallback, documentIds);
}

async function handleBusinessTool(toolName: string, args: any, contextTabId?: number): Promise<any> {
  if (!BUSINESS_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const authError = await requireBusinessAuth();
  if (authError) return authError;

  if (toolName === 'list_documents') {
    const assets = await listDocumentAssets();
    return {
      success: true,
      documents: assets,
      count: assets.length,
    };
  }

  if (toolName === 'read_document') {
    const id = String(args?.id || '');
    const maxLength = Number(args?.maxLength || 20000);
    const [asset, content, chunks] = await Promise.all([
      getDocumentAsset(id),
      getDocumentContent(id),
      getDocumentChunks(id),
    ]);
    if (!asset) return { success: false, error: '未找到资料' };
    const text = content?.text || '';
    return {
      success: true,
      asset,
      content: {
        text: text.slice(0, maxLength),
        truncated: text.length > maxLength,
        localText: content?.localText?.slice(0, maxLength),
        ocrText: content?.ocrText?.slice(0, maxLength),
        structuredOcr: content?.structuredOcr,
        tables: content?.tables || [],
        metadata: content?.metadata,
      },
      chunks: chunks.slice(0, 20),
    };
  }

  if (toolName === 'search_documents') {
    const matches = await searchDocuments(
      String(args?.query || ''),
      Array.isArray(args?.documentIds) ? args.documentIds.map(String) : undefined,
      Number(args?.limit || 8)
    );
    return {
      success: true,
      matches: matches.map((match) => ({
        score: match.score,
        asset: match.asset,
        chunk: {
          id: match.chunk.id,
          text: match.chunk.text,
          pageNumber: match.chunk.pageNumber,
          sectionTitle: match.chunk.sectionTitle,
          index: match.chunk.index,
        },
      })),
    };
  }

  if (toolName === 'summarize_document') {
    const id = String(args?.id || '');
    const [asset, content, chunks] = await Promise.all([
      getDocumentAsset(id),
      getDocumentContent(id),
      getDocumentChunks(id),
    ]);
    if (!asset) return { success: false, error: '未找到资料' };
    return {
      success: true,
      asset,
      excerpts: chunks.slice(0, 12).map((chunk) => ({
        chunkId: chunk.id,
        pageNumber: chunk.pageNumber,
        sectionTitle: chunk.sectionTitle,
        text: chunk.text.slice(0, 1600),
      })),
      tables: content?.tables?.slice(0, 4) || [],
    };
  }

  if (toolName === 'compare_documents') {
    const ids: string[] = Array.isArray(args?.ids) ? args.ids.map(String) : [];
    const docs = await Promise.all(ids.map(async (id) => ({
      asset: await getDocumentAsset(id),
      content: await getDocumentContent(id),
      chunks: await getDocumentChunks(id),
    })));
    return {
      success: true,
      documents: docs
        .filter((doc) => doc.asset)
        .map((doc) => ({
          asset: doc.asset,
          textPreview: doc.content?.text?.slice(0, 5000) || '',
          chunks: doc.chunks.slice(0, 8),
          tables: doc.content?.tables?.slice(0, 3) || [],
        })),
    };
  }

  if (toolName === 'extract_document_tables') {
    const id = String(args?.id || '');
    const [asset, content] = await Promise.all([getDocumentAsset(id), getDocumentContent(id)]);
    if (!asset) return { success: false, error: '未找到资料' };
    return {
      success: true,
      asset,
      tables: content?.tables || [],
    };
  }

  if (toolName === 'generate_requirement_tasks') {
    const allAssets = await listDocumentAssets();
    const documentIds = Array.isArray(args?.documentIds) && args.documentIds.length
      ? args.documentIds.map(String)
      : allAssets.slice(0, 1).map((asset) => asset.id);
    const selectedAssets = allAssets.filter((asset) => documentIds.includes(asset.id));
    const chunksByDocument = await Promise.all(documentIds.map(getDocumentChunks));
    const fallbackResult = generateRequirementTaskResult(selectedAssets, chunksByDocument.flat());
    let taskResult = fallbackResult;
    try {
      taskResult = await generateRequirementTasksWithLLM(selectedAssets, chunksByDocument, fallbackResult);
    } catch (error) {
      console.warn('LLM 任务清单生成失败，使用本地兜底:', error);
    }
    const resultId = makeDocumentId('requirement_result');
    await upsertDocumentResult<RequirementTaskResult>({
      id: resultId,
      kind: 'requirement_tasks',
      title: '需求任务清单',
      documentIds,
      data: taskResult,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    broadcastDocumentCenterUpdated({ reason: 'requirement_tasks_created', resultId });
    return {
      success: true,
      resultId,
      result: taskResult,
    };
  }

  if (toolName === 'get_task_trace') {
    const runId = typeof args?.runId === 'string' ? args.runId : '';
    if (runId) {
      return { success: true, trace: getComputerUseTrace(runId) };
    }
    return { success: true, traces: listComputerUseTraces(args?.limit ?? 10) };
  }

  const tabId = await resolveBrowserContextTabId(contextTabId, {
    getTab: (id) => chrome.tabs.get(id),
    getCurrentActiveTab,
  });
  if (!tabId) {
    return { success: false, error: '无法获取活动标签页' };
  }

  const contextTab = await chrome.tabs.get(tabId).catch(() => undefined);
  const contentAccessError = getTabContentAccessError(contextTab);
  const tabLevelAction = toolName === 'browser_action'
    && ['open_tab', 'switch_tab', 'close_tab'].includes(String(args?.action || ''));
  if (contentAccessError && !tabLevelAction) {
    return { success: false, error: contentAccessError, tabId };
  }

  if (toolName === 'extract_page_structured_data') {
    const raw = await executeBrowserTool(tabId, 'extract_page_structured_data', {});
    const data: PageStructuredData = raw?.result || raw;
    const id = makeDocumentId('page');
    const now = Date.now();
    const text = [
      `# ${data.title}`,
      data.headings?.map((heading) => `## ${heading}`).join('\n') || '',
      data.fields?.map((field) => `${field.label}: ${field.value}`).join('\n') || '',
      data.tables?.map((table) => [
        `## ${table.title || 'Table'}`,
        table.headers.join('\t'),
        table.rows.map((row) => row.join('\t')).join('\n'),
      ].join('\n')).join('\n\n') || '',
      data.lists?.map((list) => [`## ${list.title || 'List'}`, ...list.items.map((item) => `- ${item}`)].join('\n')).join('\n\n') || '',
    ].filter(Boolean).join('\n\n');
    const asset: DocumentAsset = {
      id,
      sourceType: 'webpage',
      title: data.title || data.url,
      mimeType: 'text/html',
      createdAt: now,
      updatedAt: now,
      localParseStatus: 'parsed',
      nativeUploadStatus: 'skipped',
      ocrStatus: 'not_needed',
    };
    const content: DocumentContent = {
      assetId: id,
      text,
      localText: text,
      tables: data.tables,
      metadata: { url: data.url, capturedAt: data.capturedAt },
      updatedAt: now,
    };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);
    const resultId = makeDocumentId('page_result');
    await upsertDocumentResult<PageStructuredData>({
      id: resultId,
      kind: 'page_structured_data',
      title: data.title || '网页结构化数据',
      documentIds: [id],
      data,
      createdAt: now,
      updatedAt: now,
    });
    broadcastDocumentCenterUpdated({ reason: 'page_structured_data_created', assetId: id, resultId });
    return {
      success: true,
      asset,
      resultId,
      data,
    };
  }

  if (toolName === 'get_console_errors') {
    if (args?.useDebugger === true) {
      return await collectConsoleDiagnosticsWithFallback(tabId, {
        limit: args?.limit ?? 30,
        since: args?.since,
        durationMs: args?.durationMs ?? 3500,
        reload: args?.reload === true,
        includeContentFallback: args?.includeContentFallback !== false,
      });
    }

    return await executeBrowserTool(tabId, 'get_console_errors', {
      limit: args?.limit ?? 30,
      since: args?.since,
    });
  }

  if (toolName === 'get_current_page_info') {
    return await executeBrowserTool(tabId, 'get_page_info', {
      include_html: args?.include_html === true,
    });
  }

  if (toolName === 'observe_page') {
    return await executeBrowserTool(tabId, 'observe_page', {
      includeScreenshot: args?.includeScreenshot === true,
      limit: args?.limit ?? 80,
    });
  }

  if (toolName === 'get_search_results') {
    return await executeBrowserTool(tabId, 'get_search_results', {
      limit: args?.limit ?? 10,
    });
  }

  if (toolName === 'click_search_result') {
    return await executeBrowserTool(tabId, 'click_search_result', {
      index: args?.index ?? 1,
    });
  }

  if (toolName === 'query_page_elements') {
    return await executeBrowserTool(tabId, 'query_elements', {
      selector: args?.selector,
      text: args?.text,
      limit: args?.limit ?? 10,
    });
  }

  if (toolName === 'browser_action') {
    const action = args?.action;

    if (action === 'open_tab') {
      const url = String(args?.url || args?.value || args?.text || '').trim();
      if (!url) return { success: false, error: '打开新标签页需要提供 URL' };
      const tab = await chrome.tabs.create({ url, active: true, openerTabId: tabId });
      if (typeof tab.id !== 'number') return { success: false, error: '创建标签页失败：缺少标签页 ID' };
      const readyTab = await waitForBrowserUseTabReady(tab.id, Number(args?.timeoutMs || 30_000), new AbortController().signal);
      return { success: true, tabId: tab.id, url: readyTab.url || url, title: readyTab.title };
    }
    if (action === 'switch_tab') {
      const targetTabId = Number(args?.tabId || args?.value);
      if (!Number.isFinite(targetTabId)) return { success: false, error: '切换标签页需要 tabId' };
      const tab = await chrome.tabs.update(targetTabId, { active: true });
      return { success: true, tabId: tab.id, url: tab.url, title: tab.title };
    }
    if (action === 'close_tab') {
      const targetTabId = Number(args?.tabId || tabId);
      await chrome.tabs.remove(targetTabId);
      return { success: true, tabId: targetTabId };
    }
    if (action === 'go_back') {
      await chrome.tabs.goBack(tabId);
      return { success: true, tabId };
    }
    if (action === 'go_forward') {
      await chrome.tabs.goForward(tabId);
      return { success: true, tabId };
    }
    if (action === 'reload') {
      await chrome.tabs.reload(tabId);
      return { success: true, tabId };
    }

    if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'click_by_coordinate') {
      return await executeBrowserTool(tabId, action === 'click_by_coordinate' ? 'click_by_coordinate' : 'click_element', {
        ...(action === 'double_click' ? { clickCount: 2 } : {}),
        ...(action === 'right_click' ? { button: 'right' } : {}),
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text,
        x: args?.x,
        y: args?.y,
        waitForElement: args?.waitForElement,
        timeoutMs: args?.timeoutMs,
      });
    }

    if (action === 'type') {
      return await executeBrowserTool(tabId, 'type_text', {
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text || '',
        clear: args?.clear,
        delay: args?.delay,
      });
    }

    if (action === 'press_key') {
      return await executeBrowserTool(tabId, 'press_key', {
        elementId: args?.elementId,
        selector: args?.selector,
        key: args?.key,
      });
    }

    if (action === 'clear_input') {
      return await executeBrowserTool(tabId, 'clear_input', {
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text,
      });
    }

    if (action === 'focus') {
      return await executeBrowserTool(tabId, 'focus_element', {
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text,
      });
    }

    if (action === 'keyboard_shortcut') {
      return await executeBrowserTool(tabId, 'keyboard_shortcut', {
        elementId: args?.elementId,
        selector: args?.selector,
        key: args?.key || args?.value,
        keys: args?.keys,
      });
    }

    if (action === 'select_option') {
      return await executeBrowserTool(tabId, 'select_option', {
        elementId: args?.elementId,
        selector: args?.selector,
        value: args?.value,
        selectBy: args?.selectBy,
      });
    }

    if (action === 'check') {
      return await executeBrowserTool(tabId, 'check_element', {
        elementId: args?.elementId,
        selector: args?.selector,
        checked: args?.value !== 'false',
      });
    }

    if (action === 'hover') {
      return await executeBrowserTool(tabId, 'hover_element', {
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text,
        x: args?.x,
        y: args?.y,
      });
    }

    if (action === 'drag') {
      return await executeBrowserTool(tabId, 'drag_element', {
        elementId: args?.elementId,
        selector: args?.selector,
        x: args?.x,
        y: args?.y,
        toX: args?.toX,
        toY: args?.toY,
      });
    }

    if (action === 'scroll') {
      return await executeBrowserTool(tabId, 'scroll_page', {
        direction: args?.direction || 'down',
        pixels: args?.pixels,
      });
    }

    if (action === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(args?.timeoutMs || 1000))));
      return { success: true, message: '等待完成' };
    }

    if (action === 'wait_for_element') {
      return await executeBrowserTool(tabId, 'wait_for_element', {
        elementId: args?.elementId,
        selector: args?.selector,
        text: args?.text,
        role: args?.role,
        purpose: args?.purpose,
        timeout: args?.timeoutMs ?? 5000,
      });
    }

    if (action === 'upload_file') {
      return await executeBrowserTool(tabId, 'upload_file', {
        elementId: args?.elementId,
        selector: args?.selector,
        fileId: args?.fileId,
      });
    }

    if (action === 'download_file') {
      const page = await chrome.tabs.get(tabId).catch(() => null);
      return await performDownloadFileAction({
        runId: `tool_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        tabId,
        pageUrl: page?.url,
        action: {
          action: 'download_file',
          elementId: args?.elementId,
          selector: args?.selector,
          text: args?.text,
          timeoutMs: args?.timeoutMs,
          reason: args?.reason || '点击导出/下载按钮',
        },
        click: () => executeContentTool(tabId, 'click_element', {
          elementId: args?.elementId,
          selector: args?.selector,
          text: args?.text,
          timeoutMs: args?.timeoutMs,
        }),
      });
    }

    return { success: false, error: `不支持的浏览器动作: ${action}` };
  }

  return { success: false, error: `未实现的业务工具: ${toolName}` };
}

async function navigateTab(
  tabId: number,
  url: string,
  waitFor: 'complete' | 'domcontentloaded' | 'none',
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  await chrome.tabs.update(tabId, { url });

  if (waitFor === 'none') return;
  await waitForBrowserUseTabReady(tabId, timeoutMs, signal);
}

async function waitForBrowserUseTabReady(
  tabId: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<chrome.tabs.Tab> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;

  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('新标签页加载超时'));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('已停止'));
    };

    const onUpdated = async (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      cleanup();
      try {
        resolve(await chrome.tabs.get(tabId));
      } catch (error) {
        reject(error);
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId !== tabId) return;
      cleanup();
      reject(new Error('新标签页在加载完成前已关闭'));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
    };

    if (signal.aborted) {
      cleanup();
      reject(new Error('已停止'));
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status !== 'complete') return;
      cleanup();
      resolve(tab);
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function initModelGatewayEvents() {
  if (!modelGatewayEventsInitialized) {
    modelGatewayEventsInitialized = true;
    modelGateway.onMessage((msg: Message) => {
      chrome.runtime.sendMessage({
        type: 'SSE_MESSAGE',
        message: msg,
      }).catch((err) => {
        console.error('发送消息失败:', err);
      });
    });

    modelGateway.onStatusChange((status) => {
      chrome.runtime.sendMessage({
        type: 'SSE_STATUS_CHANGE',
        status,
      }).catch((err) => {
        console.error('状态变化失败:', err);
      });
    });

  }
}

// 监听钉钉授权回调
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 只处理URL变化且URL已加载完成的情况
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const url = new URL(tab.url);
      
      if (url.hostname === 'sso-server-dev.igancao.cn' && 
          url.pathname === '/auth/oauth2/authorize') {
        const code = url.searchParams.get('code');
        
        if (code) {
          // 发送code到sidePanel
          chrome.runtime.sendMessage({
            type: 'DINGTALK_AUTH_CODE',
            code: code,
          }).catch(() => {
            
          });
          
          dingTalkAuthTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
      }
    } catch (e) {
      
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncPageMonitorAlarms().catch((error) => console.warn('同步页面监控 alarm 失败:', error));
});

async function initializeTaskRuntime(): Promise<void> {
  await purgeRemovedLegacyData();
  await getTaskRuntimeService().recoverInterrupted();
}

initializeTaskRuntime().catch((error) => console.warn('初始化任务运行时失败:', error));

chrome.runtime.onStartup?.addListener(() => {
  syncPageMonitorAlarms().catch((error) => console.warn('启动时同步页面监控 alarm 失败:', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handlePageMonitorAlarm(alarm.name, { executeBrowserTool, runTask: (taskId) => getTaskRuntimeService().start(taskId) }).catch((error) => {
    console.warn('页面监控执行失败:', error);
  });
});

chrome.runtime.onMessage.addListener(createBackgroundMessageRouter({
  modelGateway,
  buildId: RUNTIME_BUILD_ID,
  isRuntimeVersionCurrent,
  runtimeMismatchMessage,
  automation: {
    startTask: (taskId) => getTaskRuntimeService().start(taskId),
    stopTask: (taskId) => getTaskRuntimeService().stop(taskId),
    retryTask: (taskId) => getTaskRuntimeService().retry(taskId),
    getAutomationRun,
    upsertPageMonitorAlarm,
    clearPageMonitorAlarm,
  },
  auth: {
    dingTalkAuthTabs,
    sidePanelOpenState,
    savePageAuthState,
    requestPageAuthSync,
  },
  modelChat: {
    requireBusinessAuth,
    initModelGatewayEvents,
    resolveContextTabId: (requestedTabId) => resolveBrowserContextTabId(requestedTabId, {
      getTab: (id) => chrome.tabs.get(id),
      getCurrentActiveTab,
    }),
  },
  pageTools: {
    requireBusinessAuth,
    getCurrentActiveTab,
    resolveContextTabId: (requestedTabId) => resolveBrowserContextTabId(requestedTabId, {
      getTab: (id) => chrome.tabs.get(id),
      getCurrentActiveTab,
    }),
    collectConsoleDiagnostics: collectConsoleDiagnosticsWithFallback,
    handleBusinessTool,
    executeBrowserTool,
  },
  confirmBrowserUseAction(message, sendResponse) {
    const key = `${String(message.runId || '')}:${Number(message.stepIndex || 0)}`;
    const resolver = computerUseConfirmations.get(key);
    if (resolver) {
      resolver(message.allowed === true);
      sendResponse({ success: true });
      return true;
    }
    sendResponse({ success: false, error: '确认请求已过期' });
    return true;
  },
}));

async function configureSidePanelOpenBehavior() {
  try {
    await chrome.sidePanel.setOptions({
      enabled: true,
      path: 'sidePanel.html',
    });
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    });
  } catch (err) {
    console.error('配置侧边栏打开行为失败:', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('初始化');
  await configureSidePanelOpenBehavior();
  await initModelGatewayEvents();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanelOpenBehavior();
  await initModelGatewayEvents();
});

// 点击扩展图标时打开侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  const windowId = tab.windowId;

  try {
    await chrome.sidePanel.open({ windowId });
    sidePanelOpenState.set(windowId, true);
  } catch (err) {
    console.error('打开侧边栏失败:', err);
  }
});
