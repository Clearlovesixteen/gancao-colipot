import { GLMClient, Message } from '../sidePanel/utils/glm-client';
import { AutomationRunner } from './automation';
import { ComputerUseRunner } from './computerUseRunner';
import { runSearchEngineSkill } from './computerUseSkills/searchEngineSkill';
import { understandComputerUseIntent as understandComputerUseIntentCore } from './computerUseIntent';
import { createComputerUsePlan as createComputerUsePlanCore } from './computerUsePlanner';
import { parseComputerUseTask } from './computerUseTaskParser';
import { performDownloadFileAction } from './downloadManager';
import { getComputerUseTrace, listComputerUseTraces, recordComputerUseTraceEvent } from './computerUseTrace';
import type {
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
} from '../shared/automationTypes';
import { BUSINESS_TOOL_NAMES } from '../shared/businessTools';
import type { PageAuthSnapshot } from '../shared/authBridge';
import type { DocumentAsset, DocumentContent, PageStructuredData, RequirementTaskResult } from '../shared/documentTypes';
import {
  extractJsonObject,
  isAuthenticatedValue,
  normalizeRequirementTaskResult,
  UNAUTHENTICATED_RESPONSE,
} from './businessHelpers';
import {
  generateRequirementTaskResult,
  getDocumentAsset,
  getDocumentChunks,
  getDocumentContent,
  listDocumentAssets,
  makeDocumentId,
  migrateLegacyUploadedFiles,
  rebuildDocumentChunks,
  saveDocumentContent,
  searchDocuments,
  upsertDocumentAsset,
  upsertDocumentResult,
} from './documentDb';

let glmClient: GLMClient | null = null;

// 存储 sidePanel 的打开状态
const sidePanelOpenState = new Map<number, boolean>();

const automationRunners = new Map<string, AutomationRunner>();
const computerUseRunners = new Map<string, AbortController>();
const computerUseConfirmations = new Map<string, (allowed: boolean) => void>();

const dingTalkAuthTabs = new Set<number>();

const TRUSTED_AUTH_HOST_SUFFIXES = [
  'gancao.com',
  'igancao.cn',
  'localhost',
  '127.0.0.1',
];

const LLM_API_KEY = 'sk-9e78d63ce4ca08291b35c19caf1379892a8b9a40d3e856cc85def65d049c5b1f';
const LLM_BASE_URL = 'https://api.86gamestore.com/v1';
const LLM_MODEL_NAME = 'gpt-5.5';
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

async function planComputerUseAction(input: {
  goal: string;
  stepIndex: number;
  observation: BrowserObservation;
  history: Array<{ action?: ComputerUseAction; result?: unknown }>;
}): Promise<ComputerUseAction> {
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL_NAME,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            '你是浏览器 Computer Use 执行器，每次只输出一个 JSON 动作，不要输出 Markdown。',
            '可选 action: click,double_click,right_click,click_by_coordinate,type,clear_input,focus,keyboard_shortcut,press_key,select_option,check,hover,drag,scroll,wait,wait_for_element,upload_file,download_file,extract_table,finish。',
            '优先使用 observation.elements 中的 elementId；没有合适元素时才用 selector/text/x/y。',
            '如果用户目标明确要求导出/下载文件：先根据 menu_item/navigation_item 判断是否在目标页面；到达目标页面后优先点击 purpose=download_button 的真实导出/下载按钮，并使用 download_file 等待下载。',
            '如果用户目标只是读取列表/表格数据且未要求导出文件，到达目标页面后优先使用 extract_table 获取表格。',
            '如果页面信息不足、找不到目标菜单、疑似权限不足或表格无法提取，输出 finish 并在 summary 里说明缺少什么上下文。',
            '高风险动作如提交、删除、购买、支付、发送、保存、修改必须设置 highRisk:true 并说明 reason；用户明确要求导出/下载时，纯导出按钮不需要额外 highRisk。',
            '如果目标已经完成，输出 {"action":"finish","summary":"..."}。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            goal: input.goal,
            stepIndex: input.stepIndex,
            observation: slimObservationForPrompt(input.observation),
            history: input.history.slice(-6),
          }, null, 2),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Computer Use 规划失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Computer Use 规划结果不是 JSON');
  }

  const action = parsed as ComputerUseAction;
  if (!action.action) {
    throw new Error('Computer Use 规划结果缺少 action');
  }
  return action;
}

async function callComputerUseJson(system: string, user: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COMPUTER_USE_LLM_TIMEOUT_MS);
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: LLM_MODEL_NAME,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user, null, 2) },
      ],
    }),
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`Computer Use LLM 请求失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Computer Use LLM 返回结果不是 JSON');
  }
  return parsed;
}

async function understandComputerUseIntentWithLLM(goal: string): Promise<ComputerUseIntent> {
  return await understandComputerUseIntentCore({
    goal,
    callLLM: ({ system, user }) => callComputerUseJson(system, user),
  });
}

async function createComputerUsePlanWithLLM(input: {
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  history: Array<{ action?: ComputerUseAction; result?: unknown; verification?: unknown; plan?: ComputerUsePlan }>;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}): Promise<ComputerUsePlan> {
  return await createComputerUsePlanCore({
    ...input,
    callLLM: ({ system, user }) => callComputerUseJson(system, user),
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

  const request = { type: 'READ_PAGE_AUTH_STATE' };

  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (error: any) {
    if (!error?.message?.includes('Could not establish connection')) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    return await chrome.tabs.sendMessage(tabId, request);
  }
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

  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_BROWSER_TOOL',
      toolName,
      arguments: args,
    });
  } catch (error: any) {
    if (!error?.message?.includes('Could not establish connection')) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    return await chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_BROWSER_TOOL',
      toolName,
      arguments: args,
    });
  }
}

async function runComputerUseOnTab(options: {
  tabId: number;
  goal: string;
  intent?: ComputerUseTaskIntent;
  runId?: string;
  maxSteps?: number;
  startUrl?: string;
  allowHighRisk?: boolean;
  externalSignal?: AbortSignal;
}): Promise<unknown> {
  const runId = options.runId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  options.externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  return await new Promise((resolve, reject) => {
    const emit = (msg: any) => {
      if (typeof msg?.runId === 'string' && msg.type?.startsWith?.('COMPUTER_USE_')) {
        recordComputerUseTraceEvent(msg);
      }
      chrome.runtime.sendMessage(msg).catch(() => {});
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
    const canUseSearchSkill = intent.actionType === 'search' && Boolean(intent.query && intent.startUrl);
    const runPromise = canUseSearchSkill
      ? runSearchEngineSkill({
        tabId: options.tabId,
        runId,
        goal: options.goal,
        intent,
        signal: controller.signal,
        navigate: navigateTab,
        executeBrowserTool,
        emit,
      })
      : new ComputerUseRunner({
        tabId: options.tabId,
        runId,
        goal: options.goal,
        maxSteps: Math.max(1, Math.min(Number(options.maxSteps || 8), 30)),
        startUrl: options.startUrl || intent.startUrl,
        allowHighRisk: options.allowHighRisk === true,
        signal: controller.signal,
        navigate: navigateTab,
        executeBrowserTool,
        executeDownloadAction: ({ action, pageUrl }) => performDownloadFileAction({
          runId,
          tabId: options.tabId,
          pageUrl,
          action,
          click: () => executeContentTool(options.tabId, 'click_element', action),
        }),
        understandIntent: ({ goal }) => understandComputerUseIntentWithLLM(goal),
        createPlan: createComputerUsePlanWithLLM,
        planNextAction: planComputerUseAction,
        confirmAction: waitForComputerUseConfirmation,
        emit,
      }).run();

    runPromise.finally(() => {
      options.externalSignal?.removeEventListener('abort', abortFromExternal);
      computerUseRunners.delete(runId);
    });
  });
}

async function getUploadedFiles(): Promise<any[]> {
  const result = await chrome.storage.local.get('uploadedFiles');
  return Array.isArray(result.uploadedFiles) ? result.uploadedFiles : [];
}

function summarizeUploadedFile(file: any, index: number) {
  const content = typeof file?.content === 'string' ? file.content : '';
  const isDataUrl = content.startsWith('data:');
  const parsed = file?.parsed;

  return {
    index,
    id: file?.id || null,
    name: file?.name || `file_${index}`,
    type: file?.type || 'unknown',
    size: file?.size || 0,
    uploadTime: file?.uploadTime || null,
    contentKind: parsed?.kind || (isDataUrl ? 'data-url' : 'text'),
    parseStatus: parsed?.status || 'legacy',
    nativeFileId: file?.nativeFile?.id || null,
    nativeFileStatus: file?.nativeFile?.status || null,
    warning: parsed?.warning,
    error: parsed?.error,
  };
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

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL_NAME,
      stream: false,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是研发需求拆解助手。只返回 JSON，不要 markdown。字段必须符合 RequirementTaskResult，tasks 必须包含 title/module/type/priority/description/acceptanceCriteria/dependencies/risks/openQuestions/sourceRefs。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            documents: assets.map((asset) => ({ id: asset.id, title: asset.title })),
            chunks: chunkContext,
            fallbackHint: fallback.summary,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`任务清单模型生成失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(String(content));
  return normalizeRequirementTaskResult(parsed, fallback, documentIds);
}

async function handleBusinessTool(toolName: string, args: any): Promise<any> {
  if (!BUSINESS_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const authError = await requireBusinessAuth();
  if (authError) return authError;

  await migrateLegacyUploadedFiles();

  if (toolName === 'list_uploaded_files') {
    const files = await getUploadedFiles();
    return {
      success: true,
      files: files.map(summarizeUploadedFile),
      count: files.length,
    };
  }

  if (toolName === 'read_uploaded_file') {
    const files = await getUploadedFiles();
    const requestedId = typeof args?.id === 'string' ? args.id : '';
    const requestedIndex = Number.isFinite(Number(args?.index)) ? Number(args.index) : -1;
    const requestedName = typeof args?.name === 'string' ? args.name : '';
    const file = requestedId
      ? files.find((item) => item?.id === requestedId)
      : requestedName
      ? files.find((item) => item?.name === requestedName)
      : files[requestedIndex];

    if (!file) {
      return { success: false, error: '未找到上传文件', files: files.map(summarizeUploadedFile) };
    }

    const content = typeof file.content === 'string' ? file.content : '';
    const isDataUrl = content.startsWith('data:');
    const maxTextLength = 20000;
    const parsed = file.parsed;

    if (parsed) {
      const parsedText = typeof parsed.text === 'string' ? parsed.text : '';
      return {
        success: parsed.status !== 'error',
        file: summarizeUploadedFile(file, files.indexOf(file)),
        parsed: {
          status: parsed.status,
          kind: parsed.kind,
          text: parsedText.slice(0, maxTextLength),
          sheets: parsed.sheets,
          metadata: parsed.metadata,
          nativeFile: file.nativeFile
            ? {
                id: file.nativeFile.id,
                name: file.nativeFile.name,
                type: file.nativeFile.type,
                size: file.nativeFile.size,
                status: file.nativeFile.status,
                purpose: file.nativeFile.purpose,
              }
            : undefined,
          warning: parsed.warning,
          error: parsed.error,
          truncated: parsedText.length > maxTextLength,
        },
      };
    }

    return {
      success: true,
      file: summarizeUploadedFile(file, files.indexOf(file)),
      content: isDataUrl ? content.slice(0, 500) : content.slice(0, maxTextLength),
      truncated: isDataUrl ? content.length > 500 : content.length > maxTextLength,
    };
  }

  if (toolName === 'create_business_workflow_draft') {
    const draft = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: String(args?.name || '未命名业务流程'),
      goal: String(args?.goal || ''),
      steps: Array.isArray(args?.steps) ? args.steps.map(String) : [],
      createdAt: Date.now(),
    };
    const result = await chrome.storage.local.get('businessWorkflowDrafts');
    const drafts = Array.isArray(result.businessWorkflowDrafts) ? result.businessWorkflowDrafts : [];
    drafts.unshift(draft);
    await chrome.storage.local.set({ businessWorkflowDrafts: drafts.slice(0, 50) });
    broadcastDocumentCenterUpdated({ reason: 'business_workflow_draft_created' });
    return { success: true, draft };
  }

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

  const tabId = await getCurrentActiveTab();
  if (!tabId) {
    return { success: false, error: '无法获取活动标签页' };
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

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('已停止'));
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal.removeEventListener('abort', onAbort);
    };

    if (signal.aborted) {
      cleanup();
      reject(new Error('已停止'));
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// 初始化 GLM 客户端
async function initGLMClient() {
  if (!glmClient) {
    glmClient = new GLMClient();

    glmClient.onMessage((msg: Message) => {
      chrome.runtime.sendMessage({
        type: 'SSE_MESSAGE',
        message: msg,
      }).catch((err) => {
        console.error('发送消息失败:', err);
      });
    });

    glmClient.onStatusChange((status) => {
      chrome.runtime.sendMessage({
        type: 'SSE_STATUS_CHANGE',
        status,
      }).catch((err) => {
        console.error('状态变化失败:', err);
      });
    });

    glmClient.connect();
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

// 监听 sidePanel , content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 截图功能
  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    (async () => {
      try {
        const { format = 'png', quality = 90, fullPage = false } = message;
        // 获取当前活动标签页
        const tabId = sender.tab?.id || await getCurrentActiveTab();
        if (!tabId) {
          sendResponse({ success: false, error: '无法获取活动标签页' });
          return;
        }
        
        const tab = await chrome.tabs.get(tabId);

        // 如果需要全页截图，这里暂时只返回可见区域，因为 chrome.tabs.captureVisibleTab 只能截可见区域
        // 全页截图通常需要 content script 配合滚动拼接，或者使用 debugger API
        // 这里我们先支持基本参数，如果 fullPage=true，未来可以扩展
        
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality
        });

        sendResponse({ success: true, dataUrl });
      } catch (err: any) {
        console.error('Screenshot failed:', err);
        sendResponse({ success: false, error: err?.message || '截图失败' });
      }
    })();
    return true;
  }

  if (message.type === 'TRACK_DINGTALK_AUTH_TAB') {
    const tabId = Number(message.tabId);
    if (Number.isFinite(tabId)) {
      dingTalkAuthTabs.add(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SYNC_PAGE_AUTH_STATE') {
    (async () => {
      try {
        const snapshot = message.snapshot as PageAuthSnapshot | undefined;
        if (!snapshot || typeof snapshot !== 'object') {
          sendResponse({ success: false, error: '无效的页面登录态数据' });
          return;
        }

        const result = await savePageAuthState(snapshot, sender.tab?.url);
        sendResponse(result);
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '同步页面登录态失败' });
      }
    })();
    return true;
  }

  if (message.type === 'REQUEST_PAGE_AUTH_SYNC') {
    (async () => {
      try {
        const result = await requestPageAuthSync();
        sendResponse(result);
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '请求页面登录态失败' });
      }
    })();
    return true;
  }

  //给sidePanel打标
  if (message.type === 'SIDE_PANEL_OPENED') {
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.windowId) {
        sidePanelOpenState.set(tabs[0].windowId, true);
      }
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'SEND_MESSAGE') {
    (async () => {
      try {
        const authError = await requireBusinessAuth();
        if (authError) {
          sendResponse(authError);
          return;
        }

        // 确保客户端已初始化
        await initGLMClient();
        
        if (!glmClient) {
          sendResponse({ success: false, error: 'GLM 客户端初始化失败' });
          return;
        }

        // 直接发送消息
        const messageHistory = message.messageHistory || [];
        const result = await glmClient.send(messageHistory, undefined, message.requestId);
        sendResponse({
          ...result,
          error: result.success ? undefined : result.error || glmClient.getLastError() || 'AI 请求失败',
        });
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || 'AI 请求失败' });
      }
    })();
    return true; 
  } else if (message.type === 'STOP_AI_MESSAGE') {
    initGLMClient();
    if (!glmClient) {
      sendResponse({ success: false, error: 'GLM 客户端未初始化' });
      return true;
    }
    sendResponse(glmClient.cancelCurrentRequest());
    return true;
  } else if (message.type === 'GET_STATUS') {
    initGLMClient();
    sendResponse({ 
      status: glmClient ? glmClient.getStatus() : 'disconnected' 
    });
  } else if (message.type === 'COLLECT_CONSOLE_ERRORS') {
    (async () => {
      try {
        const authError = await requireBusinessAuth();
        if (authError) {
          sendResponse(authError);
          return;
        }

        const tabId = await getCurrentActiveTab();
        if (!tabId) {
          sendResponse({ success: false, error: '无法获取活动标签页' });
          return;
        }

        const result = await collectConsoleDiagnosticsWithFallback(tabId, {
          limit: message.limit ?? 50,
          since: message.since,
          durationMs: message.durationMs ?? 3500,
          reload: message.reload === true,
          includeContentFallback: message.includeContentFallback !== false,
        });
        sendResponse(result);
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '控制台诊断失败' });
      }
    })();
    return true;
  } else if (message.type === 'GET_ACTIVE_TAB_ID') {
    // 获取当前活动标签页 ID
    getCurrentActiveTab().then((tabId) => {
      sendResponse({ tabId });
    }).catch((error) => {
      sendResponse({ tabId: null });
    });
    return true;
  } else if (message.type === 'RUN_COMPUTER_USE') {
    (async () => {
      try {
        const authError = await requireBusinessAuth();
        if (authError) {
          sendResponse(authError);
          return;
        }

        const goal = String(message.goal || '').trim();
        if (!goal) {
          sendResponse({ success: false, error: '缺少自动操作目标' });
          return;
        }

        const explicitStartUrl = typeof message.startUrl === 'string' ? message.startUrl.trim() : '';
        const intent = parseComputerUseTask(goal, explicitStartUrl);
        const startUrl = intent.startUrl || '';
        if (startUrl) {
          const startUrlAccessError = getTabContentAccessError({ url: startUrl } as chrome.tabs.Tab);
          if (startUrlAccessError) {
            sendResponse({ success: false, error: `起始页面不可自动操作：${startUrlAccessError}` });
            return;
          }
        }

        const tabId = await getCurrentActiveTab();
        if (!tabId) {
          sendResponse({ success: false, error: '无法获取活动标签页' });
          return;
        }

        if (!startUrl) {
          const tabCheck = await getCurrentAutomatableTab();
          if ('error' in tabCheck) {
            sendResponse({ success: false, error: tabCheck.error });
            return;
          }
        }

        const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sendResponse({ success: true, runId });
        runComputerUseOnTab({
          tabId,
          runId,
          goal,
          intent,
          maxSteps: message.maxSteps ?? 8,
          startUrl: startUrl || undefined,
          allowHighRisk: message.allowHighRisk === true,
        }).catch(() => {});
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '启动自动操作失败' });
      }
    })();
    return true;
  } else if (message.type === 'STOP_COMPUTER_USE') {
    const runId = String(message.runId || '');
    const controller = computerUseRunners.get(runId);
    if (controller) {
      controller.abort();
      computerUseRunners.delete(runId);
      sendResponse({ success: true });
      return true;
    }
    sendResponse({ success: false, error: '未找到正在运行的自动操作' });
    return true;
  } else if (message.type === 'CONFIRM_COMPUTER_USE_ACTION') {
    const key = `${String(message.runId || '')}:${Number(message.stepIndex || 0)}`;
    const resolver = computerUseConfirmations.get(key);
    if (resolver) {
      resolver(message.allowed === true);
      sendResponse({ success: true });
      return true;
    }
    sendResponse({ success: false, error: '确认请求已过期' });
    return true;
  } else if (message.type === 'EXECUTE_TOOL') {
    // 执行浏览器工具
    (async () => {
      try {
        const authError = await requireBusinessAuth();
        if (authError) {
          sendResponse(authError);
          return;
        }

        const businessResult = await handleBusinessTool(message.toolName, message.arguments || {});
        if (businessResult) {
          sendResponse(businessResult);
          return;
        }

        const tabId = await getCurrentActiveTab();
        if (!tabId) {
          sendResponse({ error: '无法获取活动标签页' });
          return;
        }

        try {
          const result = await executeBrowserTool(tabId, message.toolName, message.arguments);
          sendResponse({ success: true, result });
        } catch (error: any) {
          sendResponse({ success: false, error: error.message || '工具执行失败' });
        }
      } catch (error: any) {
        sendResponse({ 
          success: false, 
          error: error.message || '工具执行失败' 
        });
      }
    })();
    return true; // 保持消息通道打开
  } else if (message.type === 'RUN_AUTOMATION') {
    (async () => {
      try {
        const workflow = message.workflow as AutomationWorkflow;
        
        // 校验工作流有效性
        if (!workflow || typeof workflow !== 'object') {
          sendResponse({ success: false, error: '无效的工作流数据' });
          return;
        }
        
        if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
           sendResponse({ success: false, error: '工作流步骤为空' });
           return;
        }

        // 创建新标签页来运行任务
        // 我们先打开 about:blank，让 Runner 自己去 navigate
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        const tabId = tab.id;

        if (!tabId) {
          sendResponse({ success: false, error: '无法创建新标签页' });
          return;
        }

        const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const runner = new AutomationRunner({
          tabId,
          runId,
          workflow,
          navigate: navigateTab,
          executeBrowserTool,
          captureVisibleTab,
          runComputerUse: async (goal, options) => await runComputerUseOnTab({
            tabId: options.tabId,
            goal,
            maxSteps: options.maxSteps,
            startUrl: options.startUrl,
            allowHighRisk: options.allowHighRisk,
          }),
          emit: (msg) => {
            chrome.runtime.sendMessage(msg).catch(() => {});
          },
        });

        automationRunners.set(runId, runner);
        sendResponse({ success: true, runId });

        // 延迟启动，确保前端有足够时间接收 runId 并建立日志监听
        setTimeout(() => {
          runner
            .run()
            .finally(() => {
              automationRunners.delete(runId);
            });
        }, 200);
      } catch (err: any) {
        console.error('Automation failed:', err);
        sendResponse({ success: false, error: err?.message || '启动失败' });
      }
    })();
    return true;
  } else if (message.type === 'STOP_AUTOMATION') {
    const runId = String(message.runId || '');
    const runner = automationRunners.get(runId);
    if (runner) {
      runner.stop();
      automationRunners.delete(runId);
      sendResponse({ success: true });
      return true;
    }
    sendResponse({ success: false, error: '未找到运行中的任务' });
    return true;
  } else if (message.type === 'SELECTED_TEXT') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    
    const openSidePanel = () => {
      if (windowId) {
        return chrome.sidePanel.open({ windowId });
      } else if (tabId) {

        return chrome.tabs.get(tabId).then((tab) => {
          if (tab.windowId) {
            return chrome.sidePanel.open({ windowId: tab.windowId });
          }
        });
      } else {
        
        return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          if (tabs[0]?.windowId) {
            return chrome.sidePanel.open({ windowId: tabs[0].windowId });
          }
        });
      }
    };
    
    // 发送消息到 sidePanel 的函数
    const sendToSidePanel = () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'SELECTED_TEXT_RECEIVED',
          text: message.text,
        }).catch((err) => {
          setTimeout(() => {
            chrome.runtime.sendMessage({
              type: 'SELECTED_TEXT_RECEIVED',
              text: message.text,
            }).catch((retryErr) => {
              console.error('发送失败:', retryErr);
            });
          }, 500);
        });
      }, 300);
    };
    
    openSidePanel()
      .then(() => {
        sendToSidePanel();
      })
      .catch((err) => {
        console.error('打开失败:', err);
        
        sendToSidePanel();
      });
    
    sendResponse({ success: true });
    return true; // 保持消息通道打开
  }
  return true; 
});

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
  await initGLMClient();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanelOpenBehavior();
  await initGLMClient();
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
