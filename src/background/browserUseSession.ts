import type { BrowserUseSessionSnapshot, BrowserUseTabSnapshot } from '../shared/automationTypes';

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

  async syncAfterAction(): Promise<{ switched: boolean; previousTabId: number; currentTabId: number; snapshot: BrowserUseSessionSnapshot }> {
    const previousTabId = this.currentTabId;
    await this.refresh(true);
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

  private async refresh(followNewChild: boolean): Promise<void> {
    const listed = (await this.deps.listTabs()).filter((tab) => Number.isFinite(tab.id));
    const newTabs = listed.filter((tab) => !this.knownTabIds.has(tab.id));
    if (followNewChild) {
      const directChildren = newTabs
        .filter((tab) => tab.openerTabId === this.currentTabId)
        .sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id);
      if (directChildren[0]) this.currentTabId = directChildren[0].id;
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
