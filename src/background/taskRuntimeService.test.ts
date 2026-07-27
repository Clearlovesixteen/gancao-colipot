import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../shared/automationTypes';
import { TaskExecutorRegistry, type TaskExecutor, type TaskResult } from './taskExecutorRegistry';
import { TaskRuntimeService, type TaskRuntimeEvent } from './taskRuntimeService';

function makeRun(patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'task_1',
    title: '测试任务',
    kind: 'computer_use',
    status: 'idle',
    goal: '完成测试',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function makeHarness(executor: TaskExecutor, runs = [makeRun()]) {
  const records = new Map(runs.map((run) => [run.id, { ...run }]));
  const events: TaskRuntimeEvent[] = [];
  const registry = new TaskExecutorRegistry().register(executor);
  const service = new TaskRuntimeService({
    registry,
    repository: {
      async get(id) {
        return records.get(id) || null;
      },
      async list() {
        return [...records.values()];
      },
      async patch(id, patch) {
        const current = records.get(id);
        if (!current) return null;
        const next = { ...current, ...patch, updatedAt: Date.now() };
        records.set(id, next);
        return next;
      },
    },
    authorize: vi.fn(async () => undefined),
    emit: (event) => events.push(event),
    getSecrets: async () => ['secret-key'],
  });
  return { service, records, events };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TaskRuntimeService', () => {
  it('owns the complete task lifecycle and persists a sanitized result', async () => {
    const executor: TaskExecutor = {
      kind: 'computer_use',
      validate: vi.fn(async () => undefined),
      run: vi.fn(async (_run, context): Promise<TaskResult> => {
        context.progress('working', '正在执行');
        return {
          status: 'success',
          summary: '执行完成',
          output: { token: 'secret-key' },
        };
      }),
    };
    const { service, records, events } = makeHarness(executor);

    await expect(service.start('task_1')).resolves.toEqual({ success: true, runId: 'task_1' });
    await settle();

    expect(records.get('task_1')).toMatchObject({
      status: 'success',
      resultSummary: '执行完成',
      metadata: { taskOutput: { token: '[REDACTED]' } },
    });
    expect(events.map((event) => event.type)).toEqual([
      'AUTOMATION_TASK_PROGRESS',
      'AUTOMATION_TASK_PROGRESS',
      'AUTOMATION_TASK_FINISHED',
    ]);
  });

  it('marks waiting progress and stops an active executor exactly once', async () => {
    let resolveRun!: (result: TaskResult) => void;
    const stop = vi.fn(async () => undefined);
    const executor: TaskExecutor = {
      kind: 'computer_use',
      validate: async () => undefined,
      run: vi.fn(async (_run, context) => {
        context.progress('waiting_confirmation', '等待确认');
        return new Promise<TaskResult>((resolve) => {
          resolveRun = resolve;
        });
      }),
      stop,
    };
    const { service, records, events } = makeHarness(executor);

    await service.start('task_1');
    await settle();
    expect(records.get('task_1')?.status).toBe('waiting');

    await expect(service.stop('task_1')).resolves.toBe(true);
    resolveRun({ status: 'success', summary: '不应覆盖停止状态' });
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(records.get('task_1')).toMatchObject({ status: 'stopped', resultSummary: '用户已停止任务' });
    expect(events.filter((event) => event.type === 'AUTOMATION_TASK_ERROR')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'AUTOMATION_TASK_FINISHED')).toHaveLength(0);
  });

  it('fails validation through the same persistence and event path', async () => {
    const executor: TaskExecutor = {
      kind: 'computer_use',
      validate: vi.fn(async () => {
        throw new Error('任务缺少目标描述');
      }),
      run: vi.fn(),
    };
    const { service, records, events } = makeHarness(executor);

    const result = await service.start('task_1');

    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(records.get('task_1')).toMatchObject({ status: 'failed', error: '任务缺少目标描述' });
    expect(events.at(-1)?.type).toBe('AUTOMATION_TASK_ERROR');
  });

  it('safely closes pending, running, and waiting tasks after a service worker restart', async () => {
    const executor: TaskExecutor = {
      kind: 'computer_use',
      validate: async () => undefined,
      run: vi.fn(),
    };
    const { service, records } = makeHarness(executor, [
      makeRun({ id: 'pending', status: 'pending' }),
      makeRun({ id: 'running', status: 'running' }),
      makeRun({ id: 'waiting', status: 'waiting' }),
      makeRun({ id: 'done', status: 'success' }),
    ]);

    await expect(service.recoverInterrupted()).resolves.toBe(3);

    expect(records.get('pending')?.status).toBe('stopped');
    expect(records.get('running')?.status).toBe('stopped');
    expect(records.get('waiting')?.status).toBe('stopped');
    expect(records.get('done')?.status).toBe('success');
    expect(records.get('running')?.metadata).toMatchObject({
      interruption: { code: 'TASK_RUNTIME_RESTARTED' },
    });
  });
});
