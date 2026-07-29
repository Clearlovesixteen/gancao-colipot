
import { handleToolExecution, recordConsoleError } from './pageTools/tools';
import {
  isTrustedAuthUrl,
  pickPageAuthFromEntries,
  type PageAuthSnapshot,
  type PageAuthStorageSource,
  type PageStorageEntry,
} from '../shared/auth/authBridge';
import { RUNTIME_BUILD_ID } from 'virtual:gancao-content-runtime-version';
import {
  buildPageSelectionContext,
  locatePageSelection,
  PageSelectionToolbar,
  shouldIgnoreSelectionElement,
} from './selection/pageSelectionToolbar';

let lastAuthSignature = '';
let authSyncTimer: number | null = null;
const pageSelectionToolbar = new PageSelectionToolbar((message) => {
  chrome.runtime.sendMessage(message).catch((error) => {
    console.warn('[Content] 发送页面选区动作失败:', error);
  });
});

function normalizePageErrorPayload(payload: any): { message: string; stack?: string } {
  if (payload instanceof Error) {
    return { message: payload.message, stack: payload.stack };
  }
  if (typeof payload === 'string') {
    return { message: payload };
  }
  if (payload && typeof payload === 'object') {
    return {
      message: String(payload.message || payload.reason || payload.type || JSON.stringify(payload)),
      stack: payload.stack ? String(payload.stack) : undefined,
    };
  }
  return { message: String(payload || 'Unknown error') };
}

function installPageConsoleBridge(): void {
  const flag = '__gancaoConsoleBridgeInstalled';
  const globalWindow = window as unknown as Record<string, boolean>;
  if (globalWindow[flag]) return;
  globalWindow[flag] = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'gancao-console-bridge' || data.type !== 'console-error') return;
    recordConsoleError({
      source: 'console.error',
      level: 'error',
      message: String(data.message || ''),
      stack: data.stack ? String(data.stack) : undefined,
      timestamp: Number(data.timestamp || Date.now()),
    });
  });

  window.addEventListener('error', (event) => {
    const target = event.target as HTMLElement | Window | null;
    if (target && target !== window && 'tagName' in target) {
      const element = target as HTMLElement;
      const resourceUrl = element instanceof HTMLLinkElement
        ? element.href
        : element instanceof HTMLScriptElement || element instanceof HTMLImageElement
          ? element.src
          : '';
      recordConsoleError({
        source: 'resource',
        level: 'error',
        message: `资源加载失败: ${resourceUrl || element.tagName.toLowerCase()}`,
        resourceUrl,
        tagName: element.tagName.toLowerCase(),
      });
      return;
    }

    recordConsoleError({
      source: 'window.error',
      level: 'error',
      message: event.message || '页面脚本错误',
      stack: event.error?.stack,
      line: event.lineno,
      column: event.colno,
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const normalized = normalizePageErrorPayload(event.reason);
    recordConsoleError({
      source: 'unhandledrejection',
      level: 'error',
      message: normalized.message,
      stack: normalized.stack,
    });
  });

  const injectBridgeScript = (attempt = 0): void => {
    const root = document.documentElement || document.head || document.body;
    if (!root) {
      if (attempt < 20) {
        window.setTimeout(() => injectBridgeScript(attempt + 1), 25);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('gancao-console-bridge.js');
    script.onload = () => script.remove();
    script.onerror = () => {
      recordConsoleError({
        source: 'window.error',
        level: 'error',
        message: '控制台桥接脚本加载失败',
      });
      script.remove();
    };
    try {
      root.appendChild(script);
    } catch (error) {
      recordConsoleError({
        source: 'window.error',
        level: 'error',
        message: `控制台桥接注入失败: ${error instanceof Error ? error.message : String(error)}`,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  };

  injectBridgeScript();
}

document.addEventListener('mouseup', (e) => {
  if (pageSelectionToolbar.contains(e.target)) return;
  window.setTimeout(() => {
    const selection = window.getSelection();
    const anchorElement = selection?.anchorNode instanceof HTMLElement
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    if (!selection || selection.isCollapsed || shouldIgnoreSelectionElement(anchorElement || null)) {
      pageSelectionToolbar.hide();
      return;
    }
    const context = buildPageSelectionContext(selection);
    if (context) pageSelectionToolbar.show(context);
    else pageSelectionToolbar.hide();
  }, 0);
});

document.addEventListener('mousedown', (e) => {
  if (!pageSelectionToolbar.contains(e.target)) pageSelectionToolbar.hide();
}, true);

document.addEventListener('scroll', () => {
  pageSelectionToolbar.hide();
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') pageSelectionToolbar.hide();
}, true);

function collectStorageEntries(): PageStorageEntry[] {
  const entries: PageStorageEntry[] = [];

  const collect = (storage: Storage, source: PageAuthStorageSource) => {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;

      const value = storage.getItem(key);
      if (value == null) continue;

      entries.push({ source, key, value });
    }
  };

  try {
    collect(window.localStorage, 'localStorage');
  } catch (error) {
    console.warn('[Content] 读取 localStorage 失败:', error);
  }

  try {
    collect(window.sessionStorage, 'sessionStorage');
  } catch (error) {
    console.warn('[Content] 读取 sessionStorage 失败:', error);
  }

  return entries;
}

function buildAuthSignature(snapshot: PageAuthSnapshot): string {
  return [
    snapshot.host,
    snapshot.tokenSource || '',
    snapshot.tokenKey || '',
    snapshot.token || '',
    snapshot.userInfoSource || '',
    snapshot.userInfoKey || '',
    snapshot.pageLooksLoggedOut ? 'logged-out-ui' : '',
    (snapshot.logoutSignals || []).join(','),
  ].join('|');
}

function detectLogoutSignals(): string[] {
  const text = (document.body?.innerText || '').slice(0, 5000);
  const signals: string[] = [];

  const patterns: Array<[RegExp, string]> = [
    [/钉钉扫码登录/, '钉钉扫码登录'],
    [/扫码登录/, '扫码登录'],
    [/请登录/, '请登录'],
    [/登录以继续/, '登录以继续'],
    [/二维码已过期/, '二维码已过期'],
    [/使用钉钉.*扫描|钉钉.*扫描二维码|钉钉.*扫码/, '钉钉扫码提示'],
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) {
      signals.push(label);
    }
  }

  return Array.from(new Set(signals));
}

function sendPageAuthState(reason: string, force = false): PageAuthSnapshot | null {
  if (!isTrustedAuthUrl(window.location.href)) {
    return null;
  }

  const snapshot = pickPageAuthFromEntries(collectStorageEntries(), window.location.href);
  const logoutSignals = detectLogoutSignals();
  snapshot.logoutSignals = logoutSignals;
  snapshot.pageLooksLoggedOut = !snapshot.token && logoutSignals.length > 0;

  const signature = buildAuthSignature(snapshot);

  if (!force && signature === lastAuthSignature) {
    return snapshot;
  }
  lastAuthSignature = signature;

  chrome.runtime.sendMessage({
    type: 'SYNC_PAGE_AUTH_STATE',
    reason,
    snapshot,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Content] 同步页面登录态失败:', chrome.runtime.lastError.message);
    }
  });

  return snapshot;
}

function startAuthBridge(): void {
  const bridgeFlag = '__gancaoAuthBridgeStarted';
  const globalWindow = window as unknown as Record<string, boolean>;
  if (globalWindow[bridgeFlag]) {
    return;
  }
  globalWindow[bridgeFlag] = true;

  if (!isTrustedAuthUrl(window.location.href)) {
    return;
  }

  const scheduleAuthSync = (reason: string, delay = 200): void => {
    if (authSyncTimer != null) {
      window.clearTimeout(authSyncTimer);
    }
    authSyncTimer = window.setTimeout(() => {
      authSyncTimer = null;
      sendPageAuthState(reason);
    }, delay);
  };

  setTimeout(() => sendPageAuthState('content-loaded'), 300);

  window.addEventListener('pageshow', () => {
    scheduleAuthSync('pageshow', 50);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleAuthSync('visibilitychange', 50);
    }
  });

  window.addEventListener('storage', () => {
    scheduleAuthSync('storage-event', 50);
  });

  window.addEventListener('popstate', () => {
    scheduleAuthSync('route-popstate', 100);
  });

  window.addEventListener('hashchange', () => {
    scheduleAuthSync('route-hashchange', 100);
  });

  const observer = new MutationObserver(() => {
    scheduleAuthSync('dom-mutated', 350);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  window.setInterval(() => {
    sendPageAuthState('poll');
  }, 2000);
}

installPageConsoleBridge();
startAuthBridge();

// 监听工具执行请求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CONTENT_RUNTIME_INFO') {
    sendResponse({
      success: true,
      buildId: RUNTIME_BUILD_ID,
      context: 'content',
      url: window.location.href,
    });
    return true;
  }

  if (message.type === 'EXECUTE_BROWSER_TOOL') {
    handleToolExecution(message.toolName, message.arguments)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => {
        console.error('[Content] 工具执行失败:', error);
        sendResponse({ success: false, error: error.message || '工具执行失败' });
      });
    return true; // 保持消息通道打开
  }

  if (message.type === 'READ_PAGE_AUTH_STATE') {
    const snapshot = sendPageAuthState('requested', true);
    sendResponse({
      success: Boolean(snapshot),
      snapshot,
      hasToken: Boolean(snapshot?.token),
      error: snapshot ? undefined : '当前页面不在可信登录态同步域名内',
    });
    return true;
  }

  if (message.type === 'LOCATE_PAGE_SELECTION') {
    sendResponse({ success: locatePageSelection(message.context) });
    return true;
  }
});
