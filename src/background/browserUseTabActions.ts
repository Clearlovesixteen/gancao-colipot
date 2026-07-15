import type { ComputerUseAction } from '../shared/automationTypes';
import type { BrowserUseSession, BrowserUseTabInfo } from './browserUseSession';

export type BrowserUseTabActionDeps = {
  createTab: (input: { url: string; active: boolean; openerTabId: number }) => Promise<BrowserUseTabInfo>;
  activateTab: (tabId: number) => Promise<void>;
  closeTab: (tabId: number) => Promise<void>;
  goBack: (tabId: number) => Promise<void>;
  goForward: (tabId: number) => Promise<void>;
  reload: (tabId: number) => Promise<void>;
};

function targetTabId(action: ComputerUseAction, session: BrowserUseSession): number | undefined {
  if (Number.isFinite(action.tabId)) return Number(action.tabId);
  const numericValue = Number(action.value);
  if (Number.isFinite(numericValue) && numericValue > 0) return numericValue;
  const query = String(action.text || action.value || '').trim().toLowerCase();
  if (!query) return undefined;
  const matches = session.snapshot().tabs.filter((tab) => (
    String(tab.title || '').toLowerCase().includes(query)
    || String(tab.url || '').toLowerCase().includes(query)
  ));
  return matches.length === 1 ? matches[0].tabId : undefined;
}

export async function executeBrowserUseTabAction(input: {
  action: ComputerUseAction;
  session: BrowserUseSession;
  deps: BrowserUseTabActionDeps;
}): Promise<{ success: true; tabId: number; message: string }> {
  const { action, session, deps } = input;
  const currentTabId = session.getCurrentTabId();

  if (action.action === 'open_tab') {
    const url = String(action.url || action.value || action.text || '').trim();
    if (!url) throw new Error('打开新标签页需要提供 URL');
    const tab = await deps.createTab({ url, active: true, openerTabId: currentTabId });
    if (!Number.isFinite(tab.id)) throw new Error('浏览器没有返回新标签页 ID');
    await session.selectTab(tab.id);
    return { success: true, tabId: tab.id, message: `已打开新标签页：${url}` };
  }

  if (action.action === 'switch_tab') {
    const tabId = targetTabId(action, session);
    if (!tabId) throw new Error(`无法唯一定位要切换的标签页：${action.text || action.value || '未提供目标'}`);
    await deps.activateTab(tabId);
    await session.selectTab(tabId);
    return { success: true, tabId, message: `已切换到标签页 ${tabId}` };
  }

  if (action.action === 'close_tab') {
    const tabId = targetTabId(action, session) || currentTabId;
    await deps.closeTab(tabId);
    const synced = await session.syncAfterAction();
    return { success: true, tabId: synced.currentTabId, message: `已关闭标签页 ${tabId}` };
  }

  if (action.action === 'go_back') {
    await deps.goBack(currentTabId);
    return { success: true, tabId: currentTabId, message: '已后退' };
  }
  if (action.action === 'go_forward') {
    await deps.goForward(currentTabId);
    return { success: true, tabId: currentTabId, message: '已前进' };
  }
  if (action.action === 'reload') {
    await deps.reload(currentTabId);
    return { success: true, tabId: currentTabId, message: '已刷新页面' };
  }

  throw new Error(`不是浏览器标签页动作：${action.action}`);
}
