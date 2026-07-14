import type { AutomationRun, AutomationRunKind } from '../../shared/automationTypes';
import { upsertAutomationRun } from '../../shared/automationRunStore';

function taskError(response: any, fallback: string): Error {
  const recovery = response?.recovery ? ` ${response.recovery}` : '';
  const error = new Error(`${response?.error || fallback}${recovery}`);
  (error as any).code = response?.code;
  (error as any).retryable = response?.retryable;
  return error;
}

export async function createAndRunChatTask(input: {
  kind: AutomationRunKind;
  title: string;
  goal?: string;
  metadata?: Record<string, unknown>;
}): Promise<AutomationRun> {
  const now = Date.now();
  const run = await upsertAutomationRun({
    id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    kind: input.kind,
    status: 'idle',
    goal: input.goal,
    source: 'chat',
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  });
  const response = await chrome.runtime.sendMessage({ type: 'RUN_AUTOMATION_TASK', taskId: run.id });
  if (!response?.success) throw taskError(response, '任务启动失败');
  return run;
}

export async function stopChatTask(taskId: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION_TASK', taskId });
  if (!response?.success) throw taskError(response, '停止任务失败');
}
