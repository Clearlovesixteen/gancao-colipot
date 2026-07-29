type BrowserTabContextDependencies = {
  getTab: (tabId: number) => Promise<{ id?: number }>;
  getCurrentActiveTab: () => Promise<number | null>;
};

export async function resolveBrowserContextTabId(
  requestedTabId: unknown,
  dependencies: BrowserTabContextDependencies,
): Promise<number | null> {
  const normalizedTabId = Number(requestedTabId);
  if (Number.isInteger(normalizedTabId) && normalizedTabId > 0) {
    try {
      const tab = await dependencies.getTab(normalizedTabId);
      if (tab?.id === normalizedTabId) return normalizedTabId;
    } catch {
      // The originating tab may have been closed while the model was responding.
    }
  }
  return dependencies.getCurrentActiveTab();
}
