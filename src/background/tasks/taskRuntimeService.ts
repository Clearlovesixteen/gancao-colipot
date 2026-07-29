import type { AutomationRun, AutomationRunStatus } from '../../shared/automation/automationTypes';
import { AppError, sanitizeForPersistence, toAppErrorPayload } from '../../shared/errors/appErrors';
import type { TaskExecutor, TaskResult } from './taskExecutorRegistry';
import { TaskExecutorRegistry } from './taskExecutorRegistry';

export type TaskRuntimeEvent =
  | {
      type: 'AUTOMATION_TASK_PROGRESS';
      taskId: string;
      kind: AutomationRun['kind'];
      stage: string;
      summary: string;
      data?: unknown;
    }
  | {
      type: 'AUTOMATION_TASK_FINISHED' | 'AUTOMATION_TASK_ERROR';
      taskId: string;
      kind: AutomationRun['kind'];
      result: TaskResult;
    };

export interface TaskRuntimeRepository {
  get(taskId: string): Promise<AutomationRun | null>;
  list(): Promise<AutomationRun[]>;
  patch(taskId: string, patch: Partial<Omit<AutomationRun, 'id' | 'createdAt'>>): Promise<AutomationRun | null>;
}

export interface TaskRuntimeServiceOptions {
  registry: TaskExecutorRegistry;
  repository: TaskRuntimeRepository;
  authorize(run: AutomationRun): Promise<void>;
  emit(event: TaskRuntimeEvent): void;
  getSecrets?(): Promise<string[]>;
}

interface ActiveTaskExecution {
  controller: AbortController;
  executor: TaskExecutor;
  run: AutomationRun;
  finalized: boolean;
}

export interface TaskRuntimeStartResult {
  success: boolean;
  runId?: string;
  code?: string;
  error?: string;
  recovery?: string;
  retryable?: boolean;
}

function runtimeStatusForResult(result: TaskResult): AutomationRunStatus {
  return result.status;
}

function isWaitingStage(stage: string): boolean {
  return /waiting|confirmation|等待|确认/i.test(stage);
}

export class TaskRuntimeService {
  private readonly active = new Map<string, ActiveTaskExecution>();

  constructor(private readonly options: TaskRuntimeServiceOptions) {}

  async start(taskId: string): Promise<TaskRuntimeStartResult> {
    const run = await this.options.repository.get(taskId);
    if (!run) return toAppErrorPayload(new AppError('VALIDATION_ERROR', '未找到自动化任务'));

    const previous = this.active.get(taskId);
    if (previous && !previous.finalized) {
      previous.controller.abort();
      previous.finalized = true;
      await previous.executor.stop?.(taskId);
    }

    await this.options.repository.patch(taskId, {
      status: 'pending',
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      resultSummary: undefined,
    });

    let executor: TaskExecutor;
    try {
      await this.options.authorize(run);
      executor = this.options.registry.get(run.kind);
      await executor.validate(run);
    } catch (error) {
      const result: TaskResult = {
        status: 'failed',
        summary: String((error as any)?.message || '任务校验失败'),
        error: String((error as any)?.message || '任务校验失败'),
      };
      await this.finalizeDetached(run, result);
      return toAppErrorPayload(error, '任务校验失败');
    }

    const controller = new AbortController();
    const execution: ActiveTaskExecution = {
      controller,
      executor,
      run,
      finalized: false,
    };
    this.active.set(taskId, execution);

    await this.options.repository.patch(taskId, {
      status: 'running',
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      resultSummary: undefined,
    });
    this.emitProgress(run, 'started', '任务已开始');

    void executor.run(run, {
      signal: controller.signal,
      progress: (stage, summary, data) => {
        if (execution.finalized) return;
        const nextStatus: AutomationRunStatus = isWaitingStage(stage) ? 'waiting' : 'running';
        void this.options.repository.patch(taskId, { status: nextStatus });
        this.emitProgress(run, stage, summary, data);
      },
    }).then(async (result) => {
      if (execution.finalized) return;
      execution.finalized = true;
      await this.finalizeDetached(run, result);
    }).catch(async (error: any) => {
      if (execution.finalized) return;
      execution.finalized = true;
      await this.finalizeDetached(run, {
        status: controller.signal.aborted ? 'stopped' : 'failed',
        summary: error?.message || '任务执行失败',
        error: error?.message || '任务执行失败',
      });
    }).finally(() => {
      if (this.active.get(taskId) === execution) this.active.delete(taskId);
    });

    return { success: true, runId: taskId };
  }

  async stop(taskId: string, summary = '用户已停止任务'): Promise<boolean> {
    const run = await this.options.repository.get(taskId);
    if (!run) return false;

    const execution = this.active.get(taskId);
    if (execution && !execution.finalized) {
      execution.finalized = true;
      execution.controller.abort();
      await execution.executor.stop?.(taskId);
      this.active.delete(taskId);
    } else {
      await this.options.registry.get(run.kind).stop?.(taskId);
    }

    await this.finalizeDetached(run, {
      status: 'stopped',
      summary,
      error: summary,
    });
    return true;
  }

  async retry(taskId: string): Promise<TaskRuntimeStartResult> {
    const run = await this.options.repository.get(taskId);
    if (!run) return toAppErrorPayload(new AppError('VALIDATION_ERROR', '未找到自动化任务'));
    if (this.active.has(taskId)) await this.stop(taskId, '任务已停止，准备重试');
    await this.options.repository.patch(taskId, {
      status: 'pending',
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      resultSummary: undefined,
    });
    return this.start(taskId);
  }

  async recoverInterrupted(): Promise<number> {
    const runs = await this.options.repository.list();
    const interrupted = runs.filter((run) => run.status === 'running' || run.status === 'waiting' || run.status === 'pending');
    await Promise.all(interrupted.map(async (run) => {
      const result: TaskResult = {
        status: 'stopped',
        summary: '扩展后台已重启，任务已安全停止',
        error: '扩展后台已重启',
        output: {
          interruption: {
            code: 'TASK_RUNTIME_RESTARTED',
            at: Date.now(),
            recovery: '请从任务中心重新执行该任务。',
          },
        },
      };
      await this.finalizeDetached(run, result, {
        interruption: (result.output as any).interruption,
      });
    }));
    return interrupted.length;
  }

  isRunning(taskId: string): boolean {
    const execution = this.active.get(taskId);
    return Boolean(execution && !execution.finalized);
  }

  private emitProgress(run: AutomationRun, stage: string, summary: string, data?: unknown): void {
    this.options.emit({
      type: 'AUTOMATION_TASK_PROGRESS',
      taskId: run.id,
      kind: run.kind,
      stage,
      summary,
      data,
    });
  }

  private async finalizeDetached(
    run: AutomationRun,
    result: TaskResult,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<void> {
    const secrets = await this.options.getSecrets?.() || [];
    const safeResult = sanitizeForPersistence(result, secrets);
    const trace: any = safeResult.trace;
    const latest = await this.options.repository.get(run.id);
    await this.options.repository.patch(run.id, {
      status: runtimeStatusForResult(safeResult),
      endedAt: Date.now(),
      resultSummary: safeResult.summary,
      error: safeResult.error,
      traceSummary: trace?.traceSummary || latest?.traceSummary || run.traceSummary,
      metadata: {
        ...(latest?.metadata || run.metadata || {}),
        ...metadataPatch,
        ...(trace?.computerUseRunId ? { computerUseRunId: trace.computerUseRunId } : {}),
        ...(trace?.traceSnapshot ? { traceSnapshot: trace.traceSnapshot } : {}),
        ...(safeResult.output === undefined ? {} : { taskOutput: safeResult.output }),
      },
    });

    this.options.emit({
      type: safeResult.status === 'success' || safeResult.status === 'partial'
        ? 'AUTOMATION_TASK_FINISHED'
        : 'AUTOMATION_TASK_ERROR',
      taskId: run.id,
      kind: run.kind,
      result: safeResult,
    });
  }
}
