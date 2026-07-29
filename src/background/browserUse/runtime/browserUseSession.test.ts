import { describe, expect, it } from 'vitest';
import { BrowserUseSession, type BrowserUseTabInfo } from './browserUseSession';

describe('BrowserUseSession', () => {
  it('follows a new tab opened by the controlled tab', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true, url: 'https://search.test' }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [
      { id: 1, active: false, url: 'https://search.test' },
      { id: 2, openerTabId: 1, active: true, url: 'https://result.test' },
    ];

    const result = await session.syncAfterAction();

    expect(result).toMatchObject({ switched: true, previousTabId: 1, currentTabId: 2 });
    expect(result.snapshot.tabs.find((tab) => tab.tabId === 2)?.current).toBe(true);
  });

  it('does not take over an unrelated new tab', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [{ id: 1, active: true }, { id: 9, openerTabId: 8, active: false }];

    const result = await session.syncAfterAction();

    expect(result.currentTabId).toBe(1);
    expect(result.switched).toBe(false);
  });

  it('follows a unique active noopener tab created by the controlled action', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true, url: 'https://search.test?q=beiye' }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [
      { id: 1, active: false, url: 'https://search.test?q=beiye' },
      { id: 2, active: true, url: 'https://result.test/article', title: '目标结果' },
    ];

    const result = await session.syncAfterAction({ allowActiveNewTab: true });

    expect(result).toMatchObject({ switched: true, previousTabId: 1, currentTabId: 2 });
  });

  it('follows a noopener tab by expected URL even when it is not active', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true, url: 'https://search.test?q=beiye' }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [
      { id: 1, active: true, url: 'https://search.test?q=beiye' },
      { id: 2, active: false, url: 'https://result.test/article?from=search' },
      { id: 9, active: false, url: 'https://unrelated.test/' },
    ];

    const result = await session.syncAfterAction({ expectedUrl: 'https://result.test/article' });

    expect(result.currentTabId).toBe(2);
  });

  it('does not take over when multiple unrelated new active tabs are ambiguous', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [
      { id: 1, active: false },
      { id: 2, active: true, url: 'https://one.test/' },
      { id: 3, active: true, url: 'https://two.test/' },
    ];

    const result = await session.syncAfterAction();

    expect(result.currentTabId).toBe(1);
  });

  it('recovers to an active tab when the controlled tab closes', async () => {
    let tabs: BrowserUseTabInfo[] = [{ id: 1, active: true }, { id: 2, openerTabId: 1 }];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();
    tabs = [{ id: 2, active: true }];

    expect((await session.syncAfterAction()).currentTabId).toBe(2);
  });

  it('switches to an existing tab explicitly', async () => {
    const tabs: BrowserUseTabInfo[] = [
      { id: 1, active: true, title: '工作台' },
      { id: 2, active: false, title: '文件中心' },
    ];
    const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
    await session.initialize();

    const snapshot = await session.selectTab(2);

    expect(snapshot.currentTabId).toBe(2);
    expect(snapshot.tabs.find((tab) => tab.tabId === 2)?.current).toBe(true);
  });
});
