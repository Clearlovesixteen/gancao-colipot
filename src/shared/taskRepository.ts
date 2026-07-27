import type {
  AutomationRun,
  AutomationRunKind,
  AutomationRunStatus,
} from './automationTypes';

export const TASK_REPOSITORY_DB_NAME = 'gancao_task_runtime';
export const TASK_REPOSITORY_DB_VERSION = 1;

const TASKS_STORE = 'tasks';
const DETAILS_STORE = 'taskDetails';
const META_STORE = 'meta';
const UPDATED_AT_INDEX = 'updatedAt';
const STATUS_INDEX = 'status';
const KIND_INDEX = 'kind';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const MAX_TASKS = 500;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DETAIL_BYTES = 1_500_000;
const ACTIVE_STATUSES = new Set<AutomationRunStatus>(['pending', 'running', 'waiting']);

export interface TaskDetailRecord {
  taskId: string;
  output?: unknown;
  trace?: unknown;
  updatedAt: number;
  sizeBytes: number;
}

export interface TaskRepositoryListOptions {
  offset?: number;
  limit?: number;
  status?: AutomationRunStatus | 'all';
  kind?: AutomationRunKind | 'all';
  keyword?: string;
}

export interface TaskRepositoryPage {
  items: AutomationRun[];
  total: number;
  offset: number;
  limit: number;
}

export interface TaskRepositoryHealth {
  success: boolean;
  dbName: string;
  version: number;
  stores: string[];
  taskCount: number;
  detailCount: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>, fallbackMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(fallbackMessage));
  });
}

function transactionDone(transaction: IDBTransaction, fallbackMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(fallbackMessage));
    transaction.onabort = () => reject(transaction.error || new Error(fallbackMessage));
  });
}

function openTaskDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TASK_REPOSITORY_DB_NAME, TASK_REPOSITORY_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TASKS_STORE)) {
        const store = database.createObjectStore(TASKS_STORE, { keyPath: 'id' });
        store.createIndex(UPDATED_AT_INDEX, 'updatedAt', { unique: false });
        store.createIndex(STATUS_INDEX, 'status', { unique: false });
        store.createIndex(KIND_INDEX, 'kind', { unique: false });
      }
      if (!database.objectStoreNames.contains(DETAILS_STORE)) {
        database.createObjectStore(DETAILS_STORE, { keyPath: 'taskId' });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('打开任务数据库失败'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('任务数据库升级被其他页面阻塞'));
    };
  });

  return databasePromise;
}

function metadataParts(metadata: AutomationRun['metadata']): {
  summaryMetadata?: Record<string, unknown>;
  outputSpecified: boolean;
  traceSpecified: boolean;
  output?: unknown;
  trace?: unknown;
} {
  if (!metadata) {
    return {
      outputSpecified: false,
      traceSpecified: false,
    };
  }

  const {
    taskOutput,
    traceSnapshot,
    ...summaryMetadata
  } = metadata;

  return {
    summaryMetadata,
    outputSpecified: Object.prototype.hasOwnProperty.call(metadata, 'taskOutput'),
    traceSpecified: Object.prototype.hasOwnProperty.call(metadata, 'traceSnapshot'),
    output: taskOutput,
    trace: traceSnapshot,
  };
}

function splitRun(run: AutomationRun): {
  summary: AutomationRun;
  detailPatch: Pick<TaskDetailRecord, 'output' | 'trace'>;
  outputSpecified: boolean;
  traceSpecified: boolean;
} {
  const parts = metadataParts(run.metadata);
  return {
    summary: {
      ...run,
      metadata: parts.summaryMetadata,
    },
    detailPatch: {
      output: parts.output,
      trace: parts.trace,
    },
    outputSpecified: parts.outputSpecified,
    traceSpecified: parts.traceSpecified,
  };
}

function hydrateRun(summary: AutomationRun, detail?: TaskDetailRecord | null): AutomationRun {
  if (!detail || (detail.output === undefined && detail.trace === undefined)) return summary;
  return {
    ...summary,
    metadata: {
      ...(summary.metadata || {}),
      ...(detail.output === undefined ? {} : { taskOutput: detail.output }),
      ...(detail.trace === undefined ? {} : { traceSnapshot: detail.trace }),
    },
  };
}

function serializedSize(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_DETAIL_BYTES + 1;
  }
}

function boundDetailValue(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      truncated: true,
      reason: `${label} 无法序列化`,
    };
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= MAX_DETAIL_BYTES) return value;
  return {
    truncated: true,
    reason: `${label} 超过单条 ${Math.round(MAX_DETAIL_BYTES / 1024)}KB 限制`,
    originalBytes: bytes,
    preview: serialized.slice(0, 120_000),
  };
}

function matchesFilters(run: AutomationRun, options: TaskRepositoryListOptions): boolean {
  if (options.status && options.status !== 'all' && run.status !== options.status) return false;
  if (options.kind && options.kind !== 'all' && run.kind !== options.kind) return false;
  const keyword = options.keyword?.trim().toLowerCase();
  if (!keyword) return true;
  return [run.title, run.goal, run.resultSummary, run.error, run.tags?.join(' ')]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(keyword));
}

async function deleteTaskRecords(taskIds: string[]): Promise<void> {
  if (!taskIds.length) return;
  const database = await openTaskDatabase();
  const transaction = database.transaction([TASKS_STORE, DETAILS_STORE], 'readwrite');
  const tasks = transaction.objectStore(TASKS_STORE);
  const details = transaction.objectStore(DETAILS_STORE);
  taskIds.forEach((taskId) => {
    tasks.delete(taskId);
    details.delete(taskId);
  });
  await transactionDone(transaction, '清理任务记录失败');
}

export class TaskRepository {
  async get(taskId: string): Promise<AutomationRun | null> {
    const database = await openTaskDatabase();
    const transaction = database.transaction([TASKS_STORE, DETAILS_STORE], 'readonly');
    const summaryRequest = transaction.objectStore(TASKS_STORE).get(taskId);
    const detailRequest = transaction.objectStore(DETAILS_STORE).get(taskId);
    const [summary, detail] = await Promise.all([
      requestResult<AutomationRun | undefined>(summaryRequest, '读取任务失败'),
      requestResult<TaskDetailRecord | undefined>(detailRequest, '读取任务详情失败'),
    ]);
    await transactionDone(transaction, '读取任务失败');
    return summary ? hydrateRun(summary, detail) : null;
  }

  async listPage(options: TaskRepositoryListOptions = {}): Promise<TaskRepositoryPage> {
    const database = await openTaskDatabase();
    const offset = Math.max(0, options.offset || 0);
    const limit = Math.max(1, Math.min(options.limit || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(TASKS_STORE, 'readonly');
      const index = transaction.objectStore(TASKS_STORE).index(UPDATED_AT_INDEX);
      const request = index.openCursor(null, 'prev');
      const items: AutomationRun[] = [];
      let total = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const run = cursor.value as AutomationRun;
        if (matchesFilters(run, options)) {
          if (total >= offset && items.length < limit) items.push(run);
          total += 1;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('读取任务列表失败'));
      transaction.oncomplete = () => resolve({ items, total, offset, limit });
      transaction.onerror = () => reject(transaction.error || new Error('读取任务列表失败'));
    });
  }

  async list(options: TaskRepositoryListOptions = {}): Promise<AutomationRun[]> {
    const page = await this.listPage({
      ...options,
      offset: 0,
      limit: Math.min(options.limit || MAX_TASKS, MAX_TASKS),
    });
    return page.items;
  }

  async upsert(run: AutomationRun): Promise<AutomationRun> {
    const database = await openTaskDatabase();
    const transaction = database.transaction([TASKS_STORE, DETAILS_STORE], 'readwrite');
    const taskStore = transaction.objectStore(TASKS_STORE);
    const detailStore = transaction.objectStore(DETAILS_STORE);
    const existingDetail = await requestResult<TaskDetailRecord | undefined>(
      detailStore.get(run.id),
      '读取任务详情失败',
    );
    const split = splitRun(run);
    const output = split.outputSpecified
      ? boundDetailValue(split.detailPatch.output, '任务输出')
      : existingDetail?.output;
    const trace = split.traceSpecified
      ? boundDetailValue(split.detailPatch.trace, '任务 trace')
      : existingDetail?.trace;

    taskStore.put(split.summary);
    if (output !== undefined || trace !== undefined) {
      const detail: TaskDetailRecord = {
        taskId: run.id,
        output,
        trace,
        updatedAt: run.updatedAt,
        sizeBytes: serializedSize(output) + serializedSize(trace),
      };
      detailStore.put(detail);
    } else {
      detailStore.delete(run.id);
    }

    await transactionDone(transaction, '保存任务失败');
    await this.cleanup();
    return hydrateRun(split.summary, output !== undefined || trace !== undefined
      ? {
          taskId: run.id,
          output,
          trace,
          updatedAt: run.updatedAt,
          sizeBytes: serializedSize(output) + serializedSize(trace),
        }
      : null);
  }

  async patch(
    taskId: string,
    patch: Partial<Omit<AutomationRun, 'id' | 'createdAt'>>,
  ): Promise<AutomationRun | null> {
    const existing = await this.get(taskId);
    if (!existing) return null;
    const next: AutomationRun = {
      ...existing,
      ...patch,
      id: taskId,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    return this.upsert(next);
  }

  async delete(taskId: string): Promise<void> {
    await deleteTaskRecords([taskId]);
  }

  async clear(): Promise<void> {
    const database = await openTaskDatabase();
    const transaction = database.transaction([TASKS_STORE, DETAILS_STORE, META_STORE], 'readwrite');
    transaction.objectStore(TASKS_STORE).clear();
    transaction.objectStore(DETAILS_STORE).clear();
    transaction.objectStore(META_STORE).clear();
    await transactionDone(transaction, '清空任务数据库失败');
  }

  async cleanup(now = Date.now()): Promise<void> {
    const page = await this.listPage({ offset: 0, limit: MAX_TASKS });
    const expired = page.items
      .filter((run) => !ACTIVE_STATUSES.has(run.status) && now - run.updatedAt > RETENTION_MS)
      .map((run) => run.id);

    if (page.total > MAX_TASKS) {
      const overflowPage = await this.listPage({
        offset: MAX_TASKS,
        limit: Math.min(page.total - MAX_TASKS, MAX_PAGE_SIZE),
      });
      overflowPage.items
        .filter((run) => !ACTIVE_STATUSES.has(run.status))
        .forEach((run) => expired.push(run.id));
    }

    await deleteTaskRecords([...new Set(expired)]);
  }

  async healthCheck(): Promise<TaskRepositoryHealth> {
    const database = await openTaskDatabase();
    const transaction = database.transaction([TASKS_STORE, DETAILS_STORE], 'readonly');
    const [taskCount, detailCount] = await Promise.all([
      requestResult(transaction.objectStore(TASKS_STORE).count(), '统计任务失败'),
      requestResult(transaction.objectStore(DETAILS_STORE).count(), '统计任务详情失败'),
    ]);
    await transactionDone(transaction, '检查任务数据库失败');
    return {
      success: true,
      dbName: TASK_REPOSITORY_DB_NAME,
      version: database.version,
      stores: Array.from(database.objectStoreNames),
      taskCount,
      detailCount,
    };
  }
}

export const taskRepository = new TaskRepository();

export async function resetTaskRepositoryForTests(): Promise<void> {
  if (databasePromise) {
    const database = await databasePromise.catch(() => null);
    database?.close();
    databasePromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(TASK_REPOSITORY_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('重置任务数据库失败'));
    request.onblocked = () => reject(new Error('重置任务数据库被阻塞'));
  });
}
