import type { AutomationRun, PageMonitorMetadata } from '../shared/automationTypes';
import {
  getAutomationRun,
  listAutomationRuns,
  patchAutomationRun,
} from '../shared/automationRunStore';
import { comparePageMonitorSnapshots, createPageMonitorSnapshot } from '../shared/pageMonitor';

const ALARM_PREFIX = 'page-monitor:';

type PageMonitorDeps = {
  executeBrowserTool: (tabId: number, toolName: string, args: any) => Promise<any>;
};

function getMonitorMetadata(run: AutomationRun): PageMonitorMetadata | null {
  const monitor = (run.metadata as any)?.monitor as PageMonitorMetadata | undefined;
  if (!monitor?.url || !monitor.intervalMinutes || !monitor.extractMode) return null;
  return monitor;
}

function alarmName(runId: string): string {
  return `${ALARM_PREFIX}${runId}`;
}

function runIdFromAlarm(name: string): string | null {
  return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

async function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('页面加载超时'));
    }, timeoutMs);
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function unwrapToolResult(result: any): any {
  if (result?.success === true && result.result) return result.result;
  if (result?.result) return result.result;
  return result;
}

async function captureMonitorSnapshot(tabId: number, monitor: PageMonitorMetadata, deps: PageMonitorDeps) {
  const [pageInfoRaw, observeRaw, tablesRaw] = await Promise.all([
    deps.executeBrowserTool(tabId, 'get_page_info', { include_html: false }).catch((error) => ({ error })),
    deps.executeBrowserTool(tabId, 'observe_page', { limit: 180 }).catch((error) => ({ error })),
    monitor.extractMode === 'table_summary'
      ? deps.executeBrowserTool(tabId, 'extract_page_tables', {}).catch((error) => ({ error }))
      : Promise.resolve(null),
  ]);

  const pageInfo = unwrapToolResult(pageInfoRaw);
  const observation = unwrapToolResult(observeRaw);
  const tables = unwrapToolResult(tablesRaw);
  const error = pageInfo?.error || observation?.error || tables?.error;
  if (error) throw new Error(error?.message || String(error));

  return createPageMonitorSnapshot({
    mode: monitor.extractMode,
    title: pageInfo?.title || observation?.title,
    url: pageInfo?.url || observation?.url || monitor.url,
    text: pageInfo?.text || observation?.text || '',
    collections: observation?.collections?.map((collection: any) => ({
      type: collection.type,
      title: collection.title,
      count: Array.isArray(collection.items) ? collection.items.length : 0,
      preview: Array.isArray(collection.items) ? collection.items.slice(0, 8).map((item: any) => item.text).filter(Boolean) : [],
    })),
    tables: Array.isArray(tables?.tables) ? tables.tables : undefined,
    capturedAt: Date.now(),
  });
}

export async function runPageMonitorNow(runId: string, deps: PageMonitorDeps): Promise<{ success: boolean; changed?: boolean; error?: string }> {
  const run = await getAutomationRun(runId);
  if (!run) return { success: false, error: '未找到监控任务' };
  const monitor = getMonitorMetadata(run);
  if (!monitor) return { success: false, error: '监控配置不完整' };

  let tabId: number | undefined;
  try {
    await patchAutomationRun(run.id, {
      status: 'running',
      startedAt: Date.now(),
      error: undefined,
    });
    const tab = await chrome.tabs.create({ url: monitor.url, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error('无法创建监控标签页');
    await waitForTabComplete(tabId);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const nextSnapshot = await captureMonitorSnapshot(tabId, monitor, deps);
    const compare = comparePageMonitorSnapshots(monitor.lastSnapshot, nextSnapshot);
    const nextMonitor: PageMonitorMetadata = {
      ...monitor,
      lastSnapshot: nextSnapshot,
      lastCheckedAt: Date.now(),
      lastChangedAt: compare.changed ? Date.now() : monitor.lastChangedAt,
      lastRunError: undefined,
    };
    await patchAutomationRun(run.id, {
      status: compare.changed ? 'success' : 'idle',
      endedAt: Date.now(),
      resultSummary: compare.summary,
      error: undefined,
      traceSummary: {
        snapshotHash: nextSnapshot.hash,
        lastPageTitle: nextSnapshot.title,
        lastPageUrl: nextSnapshot.url,
      },
      metadata: {
        ...(run.metadata || {}),
        monitor: nextMonitor,
      },
    });
    return { success: true, changed: compare.changed };
  } catch (error: any) {
    const message = error?.message || '页面监控失败';
    await patchAutomationRun(run.id, {
      status: 'failed',
      endedAt: Date.now(),
      error: message,
      metadata: {
        ...(run.metadata || {}),
        monitor: {
          ...monitor,
          lastCheckedAt: Date.now(),
          lastRunError: message,
        },
      },
    });
    return { success: false, error: message };
  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }
}

export async function upsertPageMonitorAlarm(run: AutomationRun): Promise<void> {
  const monitor = getMonitorMetadata(run);
  const name = alarmName(run.id);
  await chrome.alarms.clear(name);
  if (!run.schedule?.enabled || !monitor) return;
  chrome.alarms.create(name, {
    periodInMinutes: Math.max(1, monitor.intervalMinutes),
    delayInMinutes: Math.max(1, Math.min(monitor.intervalMinutes, 5)),
  });
}

export async function clearPageMonitorAlarm(runId: string): Promise<void> {
  await chrome.alarms.clear(alarmName(runId));
}

export async function syncPageMonitorAlarms(): Promise<void> {
  const runs = await listAutomationRuns();
  await Promise.all(runs.filter((run) => run.kind === 'page_monitor').map(upsertPageMonitorAlarm));
}

export async function handlePageMonitorAlarm(name: string, deps: PageMonitorDeps): Promise<void> {
  const runId = runIdFromAlarm(name);
  if (!runId) return;
  await runPageMonitorNow(runId, deps);
}
