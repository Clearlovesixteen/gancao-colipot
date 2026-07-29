export type GatewayConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export function shouldStopTypingForGatewayStatus(status: GatewayConnectionStatus): boolean {
  return status === 'error' || status === 'disconnected';
}

export async function getActiveBrowserTabId(): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tabs[0]?.id === 'number' ? tabs[0].id : undefined;
  } catch {
    return undefined;
  }
}
