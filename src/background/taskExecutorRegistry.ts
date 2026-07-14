import type { AutomationRun, AutomationRunKind } from '../shared/automationTypes';

export type TaskResultStatus = 'success' | 'partial' | 'failed' | 'stopped';

export interface TaskResult {
  status: TaskResultStatus;
  summary: string;
  output?: unknown;
  trace?: unknown;
  error?: string;
}

export interface TaskExecutionContext {
  signal: AbortSignal;
  progress(stage: string, message: string, data?: unknown): void;
}

export interface TaskExecutor {
  kind: AutomationRunKind;
  validate(run: AutomationRun): Promise<void>;
  run(run: AutomationRun, context: TaskExecutionContext): Promise<TaskResult>;
  stop?(runId: string): Promise<void> | void;
}

export class TaskExecutorRegistry {
  private executors = new Map<AutomationRunKind, TaskExecutor>();

  register(executor: TaskExecutor): this {
    if (this.executors.has(executor.kind)) throw new Error(`任务执行器已注册：${executor.kind}`);
    this.executors.set(executor.kind, executor);
    return this;
  }

  get(kind: AutomationRunKind): TaskExecutor {
    const executor = this.executors.get(kind);
    if (!executor) throw new Error(`当前任务类型暂不支持运行：${kind}`);
    return executor;
  }

  listKinds(): AutomationRunKind[] {
    return [...this.executors.keys()];
  }
}
