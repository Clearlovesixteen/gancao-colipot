import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_TASK_TEMPLATES,
  clearAutomationRuns,
  deleteAutomationRun,
  getAutomationRun,
  listAutomationRuns,
  listAutomationRunsPage,
  makeAutomationRunFromTemplate,
  patchAutomationRun,
  upsertAutomationRun,
} from './automationRunStore';
import { resetTaskRepositoryForTests, taskRepository } from '../tasks/taskRepository';

describe('automationRunStore with TaskRepository', () => {
  beforeEach(async () => {
    await resetTaskRepositoryForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetTaskRepositoryForTests();
  });

  it('creates a draft run from a template', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === 'table_export')!;

    const run = makeAutomationRunFromTemplate(template);

    expect(run.title).toBe('表格导出/下载');
    expect(run.kind).toBe('browser_use');
    expect(run.status).toBe('draft');
    expect(run.goal).toContain('导出');
    expect(run.metadata?.riskLevel).toBe('medium');
  });

  it('upserts, paginates, patches and deletes task records', async () => {
    const now = Date.now();
    const first = await upsertAutomationRun({
      id: 'run-1',
      title: '页面诊断',
      kind: 'page_diagnosis',
      status: 'draft',
      createdAt: now - 2,
      updatedAt: now - 2,
    });
    await upsertAutomationRun({
      id: 'run-2',
      title: '导出任务',
      kind: 'browser_use',
      status: 'running',
      goal: '打开页面并导出',
      createdAt: now - 1,
      updatedAt: now - 1,
    });

    expect(first.createdAt).toBe(now - 2);
    expect((await listAutomationRuns()).map((run) => run.id)).toEqual(['run-2', 'run-1']);

    const filtered = await listAutomationRunsPage({
      status: 'running',
      kind: 'browser_use',
      keyword: '导出',
      offset: 0,
      limit: 1,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].id).toBe('run-2');

    await patchAutomationRun('run-2', { status: 'failed', error: '下载超时', updatedAt: now });
    expect(await getAutomationRun('run-2')).toMatchObject({
      id: 'run-2',
      status: 'failed',
      error: '下载超时',
    });

    await deleteAutomationRun('run-1');
    expect((await listAutomationRuns()).map((run) => run.id)).toEqual(['run-2']);

    await clearAutomationRuns();
    expect(await listAutomationRuns()).toEqual([]);
  });

  it('stores large output and trace separately from list summaries', async () => {
    const now = Date.now();
    await upsertAutomationRun({
      id: 'run-monitor',
      title: '监控',
      kind: 'page_monitor',
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
      schedule: { enabled: true, intervalMinutes: 10 },
      metadata: {
        monitor: {
          url: 'https://example.com',
          intervalMinutes: 10,
          extractMode: 'page_text',
        },
        taskOutput: { changed: true },
        traceSnapshot: { runId: 'trace-1', entries: [{ action: 'observe' }] },
      },
    });

    const [summary] = await listAutomationRuns();
    expect(summary.metadata?.monitor).toBeTruthy();
    expect(summary.metadata).not.toHaveProperty('taskOutput');
    expect(summary.metadata).not.toHaveProperty('traceSnapshot');

    const hydrated = await getAutomationRun('run-monitor');
    expect(hydrated?.metadata?.taskOutput).toEqual({ changed: true });
    expect((hydrated?.metadata as any).traceSnapshot.runId).toBe('trace-1');

    const health = await taskRepository.healthCheck();
    expect(health).toMatchObject({ success: true, taskCount: 1, detailCount: 1 });
    expect(health.stores).toEqual(expect.arrayContaining(['tasks', 'taskDetails', 'meta']));
  });

  it('preserves detail data when a summary-only patch is applied', async () => {
    const now = Date.now();
    await upsertAutomationRun({
      id: 'run-detail',
      title: '资料问答',
      kind: 'document_qa',
      status: 'running',
      createdAt: now - 1,
      updatedAt: now - 1,
      metadata: {
        taskOutput: { answer: '初始答案' },
        traceSnapshot: { entries: [1, 2] },
      },
    });

    await patchAutomationRun('run-detail', {
      status: 'success',
      resultSummary: '完成',
      metadata: { sourceCount: 2 },
      updatedAt: now,
    });

    const run = await getAutomationRun('run-detail');
    expect(run?.metadata).toMatchObject({
      sourceCount: 2,
      taskOutput: { answer: '初始答案' },
      traceSnapshot: { entries: [1, 2] },
    });
  });

  it('removes expired terminal tasks but retains active tasks', async () => {
    await upsertAutomationRun({
      id: 'old-failed',
      title: '旧失败任务',
      kind: 'extract',
      status: 'failed',
      createdAt: 1,
      updatedAt: 1,
    });
    await upsertAutomationRun({
      id: 'old-running',
      title: '旧运行任务',
      kind: 'extract',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    });

    await taskRepository.cleanup(40 * 24 * 60 * 60 * 1000);

    expect(await getAutomationRun('old-failed')).toBeNull();
    expect(await getAutomationRun('old-running')).not.toBeNull();
  });
});
