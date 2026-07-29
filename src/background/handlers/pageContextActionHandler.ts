import {
  normalizePageContextActionMessage,
  PENDING_PAGE_CONTEXT_ACTION_KEY,
  type PageContextActionReceivedMessage,
} from '../../shared/context/pageContextActions';

async function openSenderSidePanel(sender: chrome.runtime.MessageSender): Promise<void> {
  const senderWindowId = sender.tab?.windowId;
  if (senderWindowId) {
    await chrome.sidePanel.open({ windowId: senderWindowId });
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.windowId) await chrome.sidePanel.open({ windowId: tabs[0].windowId });
}

async function relayPageContextAction(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const normalized = normalizePageContextActionMessage(message);
  if (!normalized) throw new Error('页面选区动作格式无效');
  const received: PageContextActionReceivedMessage = {
    ...normalized,
    type: 'PAGE_CONTEXT_ACTION_RECEIVED',
    receivedAt: Date.now(),
  };
  await chrome.storage.session.set({ [PENDING_PAGE_CONTEXT_ACTION_KEY]: received });
  try {
    await openSenderSidePanel(sender);
  } catch (error) {
    // Chrome may reject open() when this message no longer counts as a direct
    // user gesture, or when the panel is already open. Keep relaying because
    // the persisted action is still consumable by the current/new Chat.
    console.warn('[PageContextAction] Failed to open side panel:', error);
  }
  setTimeout(() => {
    chrome.runtime.sendMessage(received).catch(() => {});
  }, 120);
}

export function handlePageContextActionMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
): boolean {
  if (message.type !== 'PAGE_CONTEXT_ACTION') return false;
  relayPageContextAction(message, sender)
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
}
