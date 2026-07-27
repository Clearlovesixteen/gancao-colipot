import type { PageAuthSnapshot } from '../../shared/authBridge';

export function handleAuthBridgeMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
  deps: {
    dingTalkAuthTabs: Set<number>;
    sidePanelOpenState: Map<number, boolean>;
    savePageAuthState: (snapshot: PageAuthSnapshot, sourceUrl?: string) => Promise<any>;
    requestPageAuthSync: () => Promise<any>;
  },
): boolean {
  if (message.type === 'TRACK_DINGTALK_AUTH_TAB') {
    const tabId = Number(message.tabId);
    if (Number.isFinite(tabId)) deps.dingTalkAuthTabs.add(tabId);
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
        sendResponse(await deps.savePageAuthState(snapshot, sender.tab?.url));
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || '同步页面登录态失败' });
      }
    })();
    return true;
  }
  if (message.type === 'REQUEST_PAGE_AUTH_SYNC') {
    deps.requestPageAuthSync()
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error?.message || '请求页面登录态失败' }));
    return true;
  }
  if (message.type === 'SIDE_PANEL_OPENED') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.windowId) deps.sidePanelOpenState.set(tabs[0].windowId, true);
    });
    sendResponse({ success: true });
    return true;
  }
  return false;
}

