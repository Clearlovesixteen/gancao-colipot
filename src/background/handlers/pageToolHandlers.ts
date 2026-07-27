export function handlePageToolMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
  deps: {
    requireBusinessAuth: () => Promise<any | null>;
    getCurrentActiveTab: () => Promise<number | null>;
    resolveContextTabId: (requestedTabId?: number) => Promise<number | null>;
    collectConsoleDiagnostics: (tabId: number, args: any) => Promise<any>;
    handleBusinessTool: (toolName: string, args: any, contextTabId?: number) => Promise<any>;
    executeBrowserTool: (tabId: number, toolName: string, args: any) => Promise<any>;
  },
): boolean {
  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    (async () => {
      try {
        const tabId = sender.tab?.id || await deps.getCurrentActiveTab();
        if (!tabId) {
          sendResponse({ success: false, error: '无法获取活动标签页' });
          return;
        }
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: message.format || 'png',
          quality: message.quality ?? 90,
        });
        sendResponse({ success: true, dataUrl });
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '截图失败' });
      }
    })();
    return true;
  }
  if (message.type === 'COLLECT_CONSOLE_ERRORS') {
    (async () => {
      try {
        const authError = await deps.requireBusinessAuth();
        if (authError) return sendResponse(authError);
        const tabId = await deps.getCurrentActiveTab();
        if (!tabId) return sendResponse({ success: false, error: '无法获取活动标签页' });
        sendResponse(await deps.collectConsoleDiagnostics(tabId, {
          limit: message.limit ?? 50,
          since: message.since,
          durationMs: message.durationMs ?? 3500,
          reload: message.reload === true,
          includeContentFallback: message.includeContentFallback !== false,
        }));
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '控制台诊断失败' });
      }
    })();
    return true;
  }
  if (message.type === 'GET_ACTIVE_TAB_ID') {
    deps.getCurrentActiveTab().then((tabId) => sendResponse({ tabId })).catch(() => sendResponse({ tabId: null }));
    return true;
  }
  if (message.type === 'EXECUTE_TOOL') {
    (async () => {
      try {
        const authError = await deps.requireBusinessAuth();
        if (authError) return sendResponse(authError);
        const contextTabId = await deps.resolveContextTabId(message.tabId);
        const businessResult = await deps.handleBusinessTool(message.toolName, message.arguments || {}, contextTabId || undefined);
        if (businessResult) return sendResponse(businessResult);
        if (!contextTabId) return sendResponse({ success: false, error: '无法获取活动标签页' });
        try {
          const result = await deps.executeBrowserTool(contextTabId, message.toolName, message.arguments);
          sendResponse({ success: true, result });
        } catch (error: any) {
          sendResponse({ success: false, error: error?.message || '工具执行失败' });
        }
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '工具执行失败' });
      }
    })();
    return true;
  }
  return false;
}

