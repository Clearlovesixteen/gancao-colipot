export function handleSelectedTextMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
): boolean {
  if (message.type !== 'SELECTED_TEXT') return false;
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  const openSidePanel = async () => {
    if (windowId) return chrome.sidePanel.open({ windowId });
    if (tabId) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId) return chrome.sidePanel.open({ windowId: tab.windowId });
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.windowId) return chrome.sidePanel.open({ windowId: tabs[0].windowId });
  };
  const sendToSidePanel = (delay: number) => setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'SELECTED_TEXT_RECEIVED', text: message.text }).catch(() => {
      if (delay < 500) sendToSidePanel(500);
    });
  }, delay);
  openSidePanel().finally(() => sendToSidePanel(300));
  sendResponse({ success: true });
  return true;
}

