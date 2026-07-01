
import { handleToolExecution, recordConsoleError } from './tools';
import {
  isTrustedAuthUrl,
  pickPageAuthFromEntries,
  type PageAuthSnapshot,
  type PageAuthStorageSource,
  type PageStorageEntry,
} from '../shared/authBridge';

let selectionButton: HTMLDivElement | null = null;
let lastAuthSignature = '';
let authSyncTimer: number | null = null;

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

function getSelectedText(): string {
  const selection = window.getSelection();
  return selection ? selection.toString().trim() : '';
}

//注入 BTN
function createSelectionButton(x: number, y: number): void {

  removeSelectionButton();

  const selectedText = getSelectedText();
  if (!selectedText) {
    return;
  }

  // 创建按钮容器
  const button = document.createElement('div');
  button.id = 'gancao-selection-button';
  button.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y - 50}px;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  `;
  
  button.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
    <span>发送到 AI</span>
  `;

  // 添加点击事件 - 直接在 button 上添加，并阻止所有冒泡
  button.addEventListener('click', (e) => {
    console.log(e,'12312')
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
   
    const currentSelectedText = getSelectedText() || selectedText;
    
    if (currentSelectedText.trim()) {
      handleSendSelection(currentSelectedText);
    }
    removeSelectionButton();
  }, true); // 使用捕获阶段，确保优先处理


  button.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // 添加悬停效果
  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-2px) scale(1.05)';
    button.style.boxShadow = '0 6px 16px rgba(99, 102, 241, 0.5)';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0) scale(1)';
    button.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.4)';
  });

  document.body.appendChild(button);
  selectionButton = button;
}

// 移除浮动按钮
function removeSelectionButton(): void {
  if (selectionButton) {
    selectionButton.remove();
    selectionButton = null;
  }
}

// 发送选中的文本到侧边栏
function handleSendSelection(text: string): void {
  console.log('handleSendSelection', text);
  if (!text.trim()) {
    return;
  }
  
  //background 转发消息
  chrome.runtime.sendMessage({
    type: 'SELECTED_TEXT',
    text: text.trim(),
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('发送失败:', chrome.runtime.lastError);
    }
  });
}

// 监听鼠标抬起事件，检测文本选择
document.addEventListener('mouseup', (e) => {
  // 延迟一下，确保选择已完成
  setTimeout(() => {
    const selectedText = getSelectedText();
    
    if (selectedText && selectedText.length > 0) {
      // 获取选中文本的位置
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        // 计算按钮位置（在选中文本的上方居中）
        const x = rect.left + rect.width / 2;
        const y = rect.top + window.scrollY;
        
        createSelectionButton(x, y);
      }
    } else {
      removeSelectionButton();
    }
  }, 10);
});

document.addEventListener('mousedown', (e) => {
  if (selectionButton) {
    const target = e.target as HTMLElement;
    
    if (!selectionButton.contains(target) && target.id !== 'gancao-selection-button') {
      removeSelectionButton();
    }
  }
}, true); 

document.addEventListener('scroll', () => {
  removeSelectionButton();
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
});
