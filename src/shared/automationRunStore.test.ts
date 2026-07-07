import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRunStoreAdapter } from './automationRunStore';
import {
  AUTOMATION_RUNS_STORAGE_KEY,
  AUTOMATION_TASK_TEMPLATES,
  clearAutomationRuns,
  deleteAutomationRun,
  listAutomationRuns,
  makeAutomationRunFromTemplate,
  patchAutomationRun,
  upsertAutomationRun,
} from './automationRunStore';

function memoryAdapter(initial?: unknown): AutomationRunStoreAdapter {
  const store: Record<string, unknown> = {};
  if (initial !== undefined) store[AUTOMATION_RUNS_STORAGE_KEY] = initial;
  return {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(key) {
      delete store[key];
    },
  };
}

describe('automationRunStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a draft run from a template', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === 'table_export')!;

    const run = makeAutomationRunFromTemplate(template);

    expect(run.title).toBe('表格导出/下载');
    expect(run.kind).toBe('computer_use');
    expect(run.status).toBe('draft');
    expect(run.goal).toContain('导出');
    expect(run.metadata?.riskLevel).toBe('medium');
  });

  it('upserts, lists, patches and deletes run records', async () => {
    const adapter = memoryAdapter();
    const first = await upsertAutomationRun(
      {
        id: 'run-1',
        title: '页面诊断',
        kind: 'page_diagnosis',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
      },
      adapter,
    );
    await upsertAutomationRun(
      {
        id: 'run-2',
        title: '导出任务',
        kind: 'computer_use',
        status: 'running',
        goal: '打开页面并导出',
        createdAt: 2,
        updatedAt: 3,
      },
      adapter,
    );

    expect(first.createdAt).toBe(1);
    expect((await listAutomationRuns(adapter)).map((run) => run.id)).toEqual(['run-2', 'run-1']);

    await patchAutomationRun('run-2', { status: 'failed', error: '下载超时', updatedAt: 4 }, adapter);
    const patched = await listAutomationRuns(adapter);
    expect(patched[0]).toMatchObject({ id: 'run-2', status: 'failed', error: '下载超时' });

    await deleteAutomationRun('run-1', adapter);
    expect((await listAutomationRuns(adapter)).map((run) => run.id)).toEqual(['run-2']);

    await clearAutomationRuns(adapter);
    expect(await listAutomationRuns(adapter)).toEqual([]);
  });

  it('filters invalid storage records', async () => {
    const adapter = memoryAdapter([
      null,
      { id: 'bad' },
      { id: 'ok', title: 'OK', kind: 'workflow', status: 'success', createdAt: 1, updatedAt: 1 },
    ]);

    expect(await listAutomationRuns(adapter)).toHaveLength(1);
  });

  it('keeps trace snapshots and monitor metadata in run records', async () => {
    const adapter = memoryAdapter();

    await upsertAutomationRun(
      {
        id: 'run-monitor',
        title: '监控',
        kind: 'page_monitor',
        status: 'scheduled',
        createdAt: 1,
        updatedAt: 1,
        schedule: { enabled: true, intervalMinutes: 10 },
        metadata: {
          monitor: {
            url: 'https://example.com',
            intervalMinutes: 10,
            extractMode: 'page_text',
          },
        },
      },
      adapter,
    );
    await patchAutomationRun(
      'run-monitor',
      {
        metadata: {
          monitor: {
            url: 'https://example.com',
            intervalMinutes: 10,
            extractMode: 'page_text',
            lastSnapshot: {
              hash: 'abc',
              mode: 'page_text',
              title: 'Example',
              url: 'https://example.com',
              text: 'hello',
              capturedAt: 2,
            },
          },
          traceSnapshot: { runId: 'trace-1', entries: [] },
        },
        traceSummary: { traceRunId: 'trace-1', snapshotHash: 'abc' },
      },
      adapter,
    );

    const [run] = await listAutomationRuns(adapter);
    expect((run.metadata as any).monitor.lastSnapshot.hash).toBe('abc');
    expect((run.metadata as any).traceSnapshot.runId).toBe('trace-1');
    expect(run.traceSummary?.snapshotHash).toBe('abc');
  });
});
