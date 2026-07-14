import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/automationTypes';
import { handleAutomationTaskMessage, type AutomationTaskHandlerDeps } from './automationTaskHandlers';

function deps(): AutomationTaskHandlerDeps {
  return {
    runAutomationTaskRecord: vi.fn(async (taskId) => ({ success: true, taskId })),
    getAutomationRun: vi.fn(async (taskId): Promise<AutomationRun> => ({
      id: taskId,
      title: '任务',
      kind: 'computer_use',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      metadata: { computerUseRunId: 'cu_1' },
    })),
    patchAutomationRun: vi.fn(async () => ({})),
    stopAutomationTask: vi.fn(),
    runPageMonitorNow: vi.fn(async () => ({ success: true })),
    upsertPageMonitorAlarm: vi.fn(async () => undefined),
    clearPageMonitorAlarm: vi.fn(async () => undefined),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('handleAutomationTaskMessage', () => {
  it('routes task runs and preserves the response contract', async () => {
    const handlerDeps = deps();
    const sendResponse = vi.fn();
    expect(handleAutomationTaskMessage({ type: 'RUN_AUTOMATION_TASK', taskId: 'task_1' }, sendResponse, handlerDeps)).toBe(true);
    await flush();
    expect(handlerDeps.runAutomationTaskRecord).toHaveBeenCalledWith('task_1');
    expect(sendResponse).toHaveBeenCalledWith({ success: true, taskId: 'task_1' });
  });

  it('stops the related Computer Use run before marking the task stopped', async () => {
    const handlerDeps = deps();
    const sendResponse = vi.fn();
    handleAutomationTaskMessage({ type: 'STOP_AUTOMATION_TASK', taskId: 'task_1' }, sendResponse, handlerDeps);
    await flush();
    expect(handlerDeps.stopAutomationTask).toHaveBeenCalledWith('task_1', expect.objectContaining({ id: 'task_1' }));
    expect(handlerDeps.patchAutomationRun).toHaveBeenCalledWith('task_1', expect.objectContaining({ status: 'stopped' }));
  });

  it('creates or clears page monitor alarms from the saved schedule', async () => {
    const handlerDeps = deps();
    (handlerDeps.getAutomationRun as any).mockResolvedValueOnce({
      id: 'monitor_1', title: '监控', kind: 'page_monitor', status: 'scheduled', createdAt: 1, updatedAt: 1,
      schedule: { enabled: true, intervalMinutes: 5 },
    });
    handleAutomationTaskMessage({ type: 'UPSERT_PAGE_MONITOR_ALARM', runId: 'monitor_1' }, vi.fn(), handlerDeps);
    await flush();
    expect(handlerDeps.upsertPageMonitorAlarm).toHaveBeenCalled();
  });
});
