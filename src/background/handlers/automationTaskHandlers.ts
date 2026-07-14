import type { AutomationRun } from '../../shared/automationTypes';
import { toAppErrorPayload } from '../../shared/appErrors';

export type AutomationTaskHandlerDeps = {
  runAutomationTaskRecord: (taskId: string) => Promise<unknown>;
  getAutomationRun: (taskId: string) => Promise<AutomationRun | null>;
  patchAutomationRun: (taskId: string, patch: Partial<AutomationRun>) => Promise<unknown>;
  stopAutomationTask: (taskId: string, run: AutomationRun) => Promise<void> | void;
  runPageMonitorNow: (runId: string) => Promise<unknown>;
  upsertPageMonitorAlarm: (run: AutomationRun) => Promise<void>;
  clearPageMonitorAlarm: (runId: string) => Promise<void>;
};

type SendResponse = (response: unknown) => void;

export function handleAutomationTaskMessage(
  message: any,
  sendResponse: SendResponse,
  deps: AutomationTaskHandlerDeps,
): boolean {
  if (message.type === 'RUN_AUTOMATION_TASK') {
    (async () => {
      try {
        const taskId = String(message.taskId || '');
        if (!taskId) return sendResponse({ success: false, error: '缺少任务 ID' });
        sendResponse(await deps.runAutomationTaskRecord(taskId));
      } catch (error: any) {
        sendResponse(toAppErrorPayload(error, '启动任务失败'));
      }
    })();
    return true;
  }

  if (message.type === 'STOP_AUTOMATION_TASK') {
    (async () => {
      const taskId = String(message.taskId || '');
      const run = taskId ? await deps.getAutomationRun(taskId) : null;
      if (run) {
        await deps.stopAutomationTask(taskId, run);
        await deps.patchAutomationRun(taskId, { status: 'stopped', endedAt: Date.now(), resultSummary: '用户已停止任务' });
      }
      sendResponse({ success: Boolean(run) });
    })().catch((error: any) => sendResponse(toAppErrorPayload(error, '停止任务失败')));
    return true;
  }

  if (message.type === 'RUN_PAGE_MONITOR_NOW') {
    (async () => {
      try {
        const runId = String(message.runId || '');
        if (!runId) return sendResponse({ success: false, error: '缺少监控任务 ID' });
        sendResponse(await deps.runPageMonitorNow(runId));
      } catch (error: any) {
        sendResponse(toAppErrorPayload(error, '页面监控失败'));
      }
    })();
    return true;
  }

  if (message.type === 'UPSERT_PAGE_MONITOR_ALARM') {
    (async () => {
      try {
        const runId = String(message.runId || '');
        const run = runId ? await deps.getAutomationRun(runId) : null;
        if (!run) return sendResponse({ success: false, error: '未找到监控任务' });
        if (run.schedule?.enabled) await deps.upsertPageMonitorAlarm(run);
        else await deps.clearPageMonitorAlarm(run.id);
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse(toAppErrorPayload(error, '更新监控计划失败'));
      }
    })();
    return true;
  }

  return false;
}
