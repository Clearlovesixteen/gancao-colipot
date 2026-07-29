import type { BrowserUseSessionSnapshot, BrowserUseTabSnapshot } from '../../../shared/automation/automationTypes';

export type BrowserUseTabInfo = {
  id: number;
  windowId?: number;
  openerTabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
};

export type BrowserUseSessionDeps = {
  initialTabId: number;
  listTabs: () => Promise<BrowserUseTabInfo[]>;
  now?: () => number;
};

export type BrowserUseSessionSyncHint = {
  expectedUrl?: string;
  allowActiveNewTab?: boolean;
};

export class BrowserUseSession {
  private currentTabId: number;
  private readonly knownTabIds = new Set<number>();
  private tabs: BrowserUseTabSnapshot[] = [];
  private readonly startedAt: number;
  private updatedAt: number;

  constructor(private readonly deps: BrowserUseSessionDeps) {
    this.currentTabId = deps.initialTabId;
    this.startedAt = (deps.now || Date.now)();
    this.updatedAt = this.startedAt;
    this.knownTabIds.add(deps.initialTabId);
  }

  async initialize(): Promise<BrowserUseSessionSnapshot> {
    await this.refresh(false);
    return this.snapshot();
  }

  getCurrentTabId(): number {
    return this.currentTabId;
  }

  async selectTab(tabId: number): Promise<BrowserUseSessionSnapshot> {
    const listed = await this.deps.listTabs();
    if (!listed.some((tab) => tab.id === tabId)) {
      throw new Error(`无法接管标签页 ${tabId}：标签页不存在或不在当前窗口`);
    }
    this.currentTabId = tabId;
    this.knownTabIds.add(tabId);
    await this.refresh(false);
    return this.snapshot();
  }

  async syncAfterAction(hint: BrowserUseSessionSyncHint = {}): Promise<{ switched: boolean; previousTabId: number; currentTabId: number; snapshot: BrowserUseSessionSnapshot }> {
    const previousTabId = this.currentTabId;
    await this.refresh(true, hint);
    return {
      switched: previousTabId !== this.currentTabId,
      previousTabId,
      currentTabId: this.currentTabId,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): BrowserUseSessionSnapshot {
    return {
      initialTabId: this.deps.initialTabId,
      currentTabId: this.currentTabId,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      tabs: this.tabs.map((tab) => ({ ...tab })),
    };
  }

  private async refresh(followNewChild: boolean, hint: BrowserUseSessionSyncHint = {}): Promise<void> {
    const listed = (await this.deps.listTabs()).filter((tab) => Number.isFinite(tab.id));
    const newTabs = listed.filter((tab) => !this.knownTabIds.has(tab.id));
    if (followNewChild) {
      const directChildren = newTabs
        .filter((tab) => tab.openerTabId === this.currentTabId)
        .sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id);
      const expectedUrl = normalizeComparableUrl(hint.expectedUrl);
      const expectedMatches = expectedUrl
        ? newTabs
          .filter((tab) => urlMatchesExpectation(tab.url, expectedUrl))
          .sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id)
        : [];
      const activeNewTabs = hint.allowActiveNewTab === false
        ? []
        : newTabs.filter((tab) => tab.active).sort((a, b) => b.id - a.id);
      const nextTab = directChildren[0]
        || (expectedMatches.length === 1 ? expectedMatches[0] : undefined)
        || (activeNewTabs.length === 1 ? activeNewTabs[0] : undefined);
      if (nextTab) this.currentTabId = nextTab.id;
    }

    if (!listed.some((tab) => tab.id === this.currentTabId)) {
      const fallback = listed.find((tab) => tab.active)
        || listed.find((tab) => this.knownTabIds.has(tab.id))
        || listed[0];
      if (fallback) this.currentTabId = fallback.id;
    }

    for (const tab of listed) this.knownTabIds.add(tab.id);
    this.tabs = listed.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      openerTabId: tab.openerTabId,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      current: tab.id === this.currentTabId,
    }));
    this.updatedAt = (this.deps.now || Date.now)();
  }
}

function normalizeComparableUrl(value?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value.trim();
  }
}

function urlMatchesExpectation(actualValue: string | undefined, expectedValue: string): boolean {
  if (!actualValue || !expectedValue) return false;
  const actual = normalizeComparableUrl(actualValue);
  if (actual === expectedValue || actual.startsWith(expectedValue) || expectedValue.startsWith(actual)) return true;
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expectedValue);
    return actualUrl.origin === expectedUrl.origin
      && (actualUrl.pathname === expectedUrl.pathname
        || actualUrl.pathname.startsWith(expectedUrl.pathname)
        || expectedUrl.pathname.startsWith(actualUrl.pathname));
  } catch {
    return false;
  }
}
