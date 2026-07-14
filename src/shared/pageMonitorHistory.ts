import type { PageMonitorCheckRecord } from './automationTypes';

const STORAGE_KEY = 'pageMonitorCheckHistory';
const MAX_RECORDS = 500;

async function readAll(): Promise<PageMonitorCheckRecord[]> {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

export async function appendPageMonitorCheck(
  record: Omit<PageMonitorCheckRecord, 'id'> & Partial<Pick<PageMonitorCheckRecord, 'id'>>,
): Promise<PageMonitorCheckRecord> {
  const next: PageMonitorCheckRecord = {
    ...record,
    id: record.id || `monitor_check_${record.checkedAt}_${Math.random().toString(36).slice(2, 8)}`,
  };
  const records = await readAll();
  await chrome.storage.local.set({
    [STORAGE_KEY]: [next, ...records].slice(0, MAX_RECORDS),
  });
  return next;
}

export async function listPageMonitorChecks(monitorRunId: string, limit = 50): Promise<PageMonitorCheckRecord[]> {
  return (await readAll())
    .filter((record) => record.monitorRunId === monitorRunId)
    .sort((a, b) => b.checkedAt - a.checkedAt)
    .slice(0, limit);
}

export async function deletePageMonitorChecks(monitorRunId: string): Promise<void> {
  const records = await readAll();
  await chrome.storage.local.set({
    [STORAGE_KEY]: records.filter((record) => record.monitorRunId !== monitorRunId),
  });
}
