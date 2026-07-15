import { describe, expect, it, vi } from 'vitest';
import { BrowserUseSession, type BrowserUseTabInfo } from './browserUseSession';
import { executeBrowserUseTabAction, type BrowserUseTabActionDeps } from './browserUseTabActions';

function setup() {
  let tabs: BrowserUseTabInfo[] = [
    { id: 1, active: true, title: '工作台', url: 'https://work.test' },
    { id: 2, active: false, title: '文件中心', url: 'https://files.test' },
  ];
  const session = new BrowserUseSession({ initialTabId: 1, listTabs: async () => tabs });
  const deps: BrowserUseTabActionDeps = {
    createTab: vi.fn(async ({ url, openerTabId }) => {
      const tab = { id: 3, active: true, url, openerTabId };
      tabs = tabs.map((item) => ({ ...item, active: false })).concat(tab);
      return tab;
    }),
    activateTab: vi.fn(async (tabId) => { tabs = tabs.map((tab) => ({ ...tab, active: tab.id === tabId })); }),
    closeTab: vi.fn(async (tabId) => { tabs = tabs.filter((tab) => tab.id !== tabId); }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  };
  return { session, deps };
}

describe('browserUseTabActions', () => {
  it('opens and takes control of a new tab', async () => {
    const { session, deps } = setup();
    await session.initialize();
    const result = await executeBrowserUseTabAction({
      action: { action: 'open_tab', url: 'https://example.test' },
      session,
      deps,
    });
    expect(result.tabId).toBe(3);
    expect(session.getCurrentTabId()).toBe(3);
  });

  it('switches by a unique title and rejects ambiguous targets', async () => {
    const { session, deps } = setup();
    await session.initialize();
    await executeBrowserUseTabAction({ action: { action: 'switch_tab', text: '文件中心' }, session, deps });
    expect(session.getCurrentTabId()).toBe(2);
    await expect(executeBrowserUseTabAction({ action: { action: 'switch_tab', text: '中心或不存在' }, session, deps }))
      .rejects.toThrow('无法唯一定位');
  });

  it('closes the current tab and recovers control', async () => {
    const { session, deps } = setup();
    await session.initialize();
    const result = await executeBrowserUseTabAction({ action: { action: 'close_tab' }, session, deps });
    expect(result.tabId).toBe(2);
    expect(session.getCurrentTabId()).toBe(2);
  });
});
