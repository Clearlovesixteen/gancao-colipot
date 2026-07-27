import type { AutomationRun, AutomationRunKind } from './automationTypes';
import { upsertAutomationRun } from './automationRunStore';
import { RUNTIME_BUILD_ID } from './runtimeVersion';

function taskError(response: any, fallback: string): Error {
  const recovery = response?.recovery ? ` ${response.recovery}` : '';
  const error = new Error(`${response?.error || fallback}${recovery}`);
  (error as any).code = response?.code;
  (error as any).retryable = response?.retryable;
  return error;
}

export async function createAndRunAutomationTask(input: {
  id?: string;
  kind: AutomationRunKind;
  title: string;
  goal?: string;
  source: AutomationRun['source'];
  workflowId?: string;
  metadata?: Record<string, unknown>;
}): Promise<AutomationRun> {
  const now = Date.now();
  const run = await upsertAutomationRun({
    id: input.id || createAutomationTaskId(),
    title: input.title,
    kind: input.kind,
    status: 'idle',
    goal: input.goal,
    source: input.source,
    workflowId: input.workflowId,
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  });
  await runAutomationTask(run.id);
  return run;
}

export function createAutomationTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function runAutomationTask(taskId: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: 'RUN_AUTOMATION_TASK',
    taskId,
    clientBuildId: RUNTIME_BUILD_ID,
  });
  if (!response?.success) throw taskError(response, '任务启动失败');
}

export async function stopAutomationTask(taskId: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: 'STOP_AUTOMATION_TASK',
    taskId,
    clientBuildId: RUNTIME_BUILD_ID,
  });
  if (!response?.success) throw taskError(response, '停止任务失败');
}

export async function retryAutomationTask(taskId: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: 'RETRY_AUTOMATION_TASK',
    taskId,
    clientBuildId: RUNTIME_BUILD_ID,
  });
  if (!response?.success) throw taskError(response, '重试任务失败');
}

export function createAndRunChatTask(input: {
  id?: string;
  kind: AutomationRunKind;
  title: string;
  goal?: string;
  metadata?: Record<string, unknown>;
}): Promise<AutomationRun> {
  return createAndRunAutomationTask({ ...input, source: 'chat' });
}
