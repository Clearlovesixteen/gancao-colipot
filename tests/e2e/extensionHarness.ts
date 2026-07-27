import { chromium, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function getBuiltExtensionBuildId(): string {
  const buildInfoPath = resolve(process.cwd(), 'dist/build-info.json');
  return JSON.parse(readFileSync(buildInfoPath, 'utf8')).buildId;
}

export type ExtensionHarness = {
  context: BrowserContext;
  extensionPage: Page;
  fixturePage: Page;
  userDataDir: string;
};

function extensionIdFromPath(extensionPath: string): string {
  return createHash('sha256')
    .update(extensionPath)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

export async function launchExtension(fixturePath = '/business.html'): Promise<ExtensionHarness> {
  const extensionPath = resolve(process.cwd(), 'dist');
  const userDataDir = mkdtempSync(join(tmpdir(), 'gancao-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.PW_BROWSER_CHANNEL || 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const existingWorker = context.serviceWorkers()[0];
  const extensionId = existingWorker
    ? new URL(existingWorker.url()).host
    : extensionIdFromPath(extensionPath);
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/sidePanel.html`);
  await extensionPage.evaluate(async () => {
    (window as any).__e2eTaskEvents = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (/^AUTOMATION_TASK_/.test(String(message?.type || ''))) {
        (window as any).__e2eTaskEvents.push(message);
      }
    });
    await chrome.storage.local.set({ user_auth: true, computerUseDeterministicMode: true });
  });
  const fixturePage = await context.newPage();
  await fixturePage.goto(`http://127.0.0.1:4173${fixturePath}`);
  await fixturePage.bringToFront();
  return { context, extensionPage, fixturePage, userDataDir };
}

export async function sendRuntimeMessage<T>(extensionPage: Page, payload: unknown): Promise<T> {
  return extensionPage.evaluate((message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError?.message;
      if (error) reject(new Error(error));
      else resolve(response);
    });
  }), payload) as Promise<T>;
}

export async function configureFixtureModel(harness: ExtensionHarness): Promise<void> {
  const response = await sendRuntimeMessage<any>(harness.extensionPage, {
    type: 'UPSERT_MODEL_PROFILE',
    profile: {
      id: 'e2e-fixture-model',
      name: 'E2E Fixture Model',
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:4173/v1',
      model: 'fixture-model',
      apiKey: 'fixture-key',
      active: true,
      capabilities: { streaming: true, tools: true, json: true, files: false },
    },
  });
  expect(response?.success, response?.error).toBe(true);
}

async function putAutomationTask(extensionPage: Page, run: Record<string, unknown>): Promise<void> {
  await extensionPage.evaluate(async (task) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_task_runtime', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('kind', 'kind', { unique: false });
        }
        if (!db.objectStoreNames.contains('taskDetails')) {
          db.createObjectStore('taskDetails', { keyPath: 'taskId' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('tasks', 'readwrite');
      transaction.objectStore('tasks').put(task);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, run);
}

async function readAutomationTask(extensionPage: Page, taskId: string): Promise<any> {
  return extensionPage.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_task_runtime', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction(['tasks', 'taskDetails'], 'readonly');
      const summaryRequest = transaction.objectStore('tasks').get(id);
      const detailRequest = transaction.objectStore('taskDetails').get(id);
      transaction.oncomplete = () => {
        const summary = summaryRequest.result;
        const detail = detailRequest.result;
        if (!summary) {
          resolve(null);
          return;
        }
        resolve({
          ...summary,
          metadata: {
            ...(summary.metadata || {}),
            ...(detail?.output === undefined ? {} : { taskOutput: detail.output }),
            ...(detail?.trace === undefined ? {} : { traceSnapshot: detail.trace }),
          },
        });
      };
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return result;
  }, taskId);
}

export async function runAutomationTask(
  harness: ExtensionHarness,
  input: {
    id?: string;
    kind: string;
    title: string;
    goal?: string;
    metadata?: Record<string, unknown>;
    workflowId?: string;
    schedule?: Record<string, unknown>;
  },
  timeout = 90_000,
): Promise<any> {
  const taskId = input.id || `e2e_${input.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await putAutomationTask(harness.extensionPage, {
    id: taskId,
    title: input.title,
    kind: input.kind,
    status: 'idle',
    goal: input.goal,
    source: 'system',
    workflowId: input.workflowId,
    schedule: input.schedule,
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  });

  const started = await sendRuntimeMessage<{ success: boolean; runId?: string; error?: string }>(harness.extensionPage, {
    type: 'RUN_AUTOMATION_TASK',
    clientBuildId: getBuiltExtensionBuildId(),
    taskId,
  });
  expect(started.success, started.error).toBe(true);

  const deadline = Date.now() + timeout;
  let latest: any = null;
  while (Date.now() < deadline) {
    latest = await readAutomationTask(harness.extensionPage, taskId);
    if (
      latest
      && (
        /success|partial|failed|stopped/.test(latest.status)
        || (latest.status === 'idle' && Boolean(latest.endedAt))
      )
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const assetId = String(input.metadata?.assetId || '');
  const assetState = assetId
    ? await readDocumentAssetState(harness, assetId).catch(() => null)
    : null;
  const events = await harness.extensionPage.evaluate((id) => (
    ((window as any).__e2eTaskEvents || []).filter((event: any) => event.taskId === id)
  ), taskId);
  throw new Error(`任务 ${taskId} 在 ${timeout}ms 内未结束：${JSON.stringify({
    latest,
    assetState,
    events,
  })}`);
}

export async function rerunAutomationTask(
  harness: ExtensionHarness,
  taskId: string,
  timeout = 90_000,
): Promise<any> {
  const previous = await readAutomationTask(harness.extensionPage, taskId);
  const previousEndedAt = Number(previous?.endedAt || 0);
  const started = await sendRuntimeMessage<{ success: boolean; error?: string }>(harness.extensionPage, {
    type: 'RUN_AUTOMATION_TASK',
    clientBuildId: getBuiltExtensionBuildId(),
    taskId,
  });
  expect(started.success, started.error).toBe(true);
  await expect.poll(async () => {
    const run = await readAutomationTask(harness.extensionPage, taskId);
    return Boolean(
      run
      && Number(run.endedAt || 0) > previousEndedAt
      && /success|partial|failed|stopped/.test(run.status),
    );
  }, { timeout }).toBe(true);
  return readAutomationTask(harness.extensionPage, taskId);
}

export async function seedDocumentAsset(
  harness: ExtensionHarness,
  input: {
    id?: string;
    title: string;
    mimeType: string;
    bytes?: number[];
    text?: string;
    pageNumber?: number;
    sectionTitle?: string;
  },
): Promise<string> {
  return harness.extensionPage.evaluate(async (payload) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_document_center', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assetContents')) db.createObjectStore('assetContents', { keyPath: 'assetId' });
        if (!db.objectStoreNames.contains('chunks')) {
          const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
          chunks.createIndex('assetId', 'assetId', { unique: false });
        }
        if (!db.objectStoreNames.contains('results')) {
          const results = db.createObjectStore('results', { keyPath: 'id' });
          results.createIndex('kind', 'kind', { unique: false });
        }
        if (!db.objectStoreNames.contains('rawFiles')) db.createObjectStore('rawFiles', { keyPath: 'assetId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const assetId = payload.id || `e2e_doc_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const stores = ['assets', 'assetContents', 'chunks', 'rawFiles'].filter((name) => database.objectStoreNames.contains(name));
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(stores, 'readwrite');
      transaction.objectStore('assets').put({
        id: assetId,
        sourceType: 'file',
        title: payload.title,
        mimeType: payload.mimeType,
        size: payload.bytes?.length || new TextEncoder().encode(payload.text || '').length,
        createdAt: now,
        updatedAt: now,
        localParseStatus: payload.text ? 'parsed' : 'pending',
        nativeUploadStatus: 'skipped',
        ocrStatus: payload.text ? 'not_needed' : 'pending',
      });
      if (payload.text) {
        transaction.objectStore('assetContents').put({
          assetId,
          text: payload.text,
          localText: payload.text,
          updatedAt: now,
        });
        transaction.objectStore('chunks').put({
          id: `${assetId}_chunk_0`,
          assetId,
          title: payload.title,
          text: payload.text,
          pageNumber: payload.pageNumber,
          sectionTitle: payload.sectionTitle,
          index: 0,
          keywords: ['验收', '来源', '甘草'],
          createdAt: now,
        });
      }
      if (payload.bytes) {
        transaction.objectStore('rawFiles').put({
          assetId,
          file: new Blob([new Uint8Array(payload.bytes)], { type: payload.mimeType }),
        });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return assetId;
  }, input);
}

export async function readDocumentAssetState(harness: ExtensionHarness, assetId: string): Promise<any> {
  return harness.extensionPage.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_document_center', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<any>((resolve, reject) => {
      const tx = database.transaction(['assets', 'assetContents'], 'readonly');
      const assetRequest = tx.objectStore('assets').get(id);
      const contentRequest = tx.objectStore('assetContents').get(id);
      tx.oncomplete = () => resolve({ asset: assetRequest.result, content: contentRequest.result });
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return result;
  }, assetId);
}

export async function seedMemoryFixture(harness: ExtensionHarness): Promise<{ sessionId: string; memoryId: string }> {
  return harness.extensionPage.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_user_memory', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('chatSessions')) db.createObjectStore('chatSessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chatMessages')) {
          const messages = db.createObjectStore('chatMessages', { keyPath: 'id' });
          messages.createIndex('sessionId', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('userMemories')) {
          const memories = db.createObjectStore('userMemories', { keyPath: 'id' });
          memories.createIndex('type', 'type', { unique: false });
          memories.createIndex('enabled', 'enabled', { unique: false });
        }
        if (!db.objectStoreNames.contains('memoryRecallLogs')) db.createObjectStore('memoryRecallLogs', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const sessionId = `e2e_session_${now}`;
    const memoryId = `e2e_memory_${now}`;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['chatSessions', 'chatMessages', 'userMemories'], 'readwrite');
      tx.objectStore('chatSessions').put({
        id: sessionId,
        title: 'E2E 历史会话',
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
        tags: ['e2e'],
      });
      tx.objectStore('chatMessages').put({
        id: `e2e_message_${now}`,
        sessionId,
        role: 'user',
        content: '请记住库存导出流程',
        timestamp: now,
      });
      tx.objectStore('userMemories').put({
        id: memoryId,
        type: 'workflow',
        title: '库存导出偏好',
        content: '库存导出默认选择测试仓',
        sourceSessionId: sessionId,
        confidence: 1,
        enabled: true,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return { sessionId, memoryId };
  });
}

export async function readMemoryFixture(
  harness: ExtensionHarness,
  ids: { sessionId: string; memoryId: string },
): Promise<any> {
  return harness.extensionPage.evaluate(async (input) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gancao_user_memory', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<any>((resolve, reject) => {
      const tx = database.transaction(['chatSessions', 'userMemories'], 'readonly');
      const sessionRequest = tx.objectStore('chatSessions').get(input.sessionId);
      const memoryRequest = tx.objectStore('userMemories').get(input.memoryId);
      tx.oncomplete = () => resolve({ session: sessionRequest.result, memory: memoryRequest.result });
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return result;
  }, ids);
}

export async function setMonitorFixtureValue(value: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:4173/monitor/set?value=${encodeURIComponent(value)}`);
  if (!response.ok) throw new Error(`Failed to update monitor fixture: ${response.status}`);
}

export async function runComputerUse(harness: ExtensionHarness, goal: string, maxSteps = 16, resumeCheckpoint?: unknown): Promise<any> {
  await harness.fixturePage.bringToFront();
  const taskId = `e2e_browser_use_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await putAutomationTask(harness.extensionPage, {
    id: taskId,
    title: `Browser Use E2E：${goal.slice(0, 40)}`,
    kind: 'browser_use',
    status: 'idle',
    goal,
    source: 'system',
    metadata: { maxSteps, resumeCheckpoint },
    createdAt: now,
    updatedAt: now,
  });

  const started = await sendRuntimeMessage<{ success: boolean; runId?: string; error?: string }>(harness.extensionPage, {
    type: 'RUN_AUTOMATION_TASK',
    clientBuildId: getBuiltExtensionBuildId(),
    taskId,
  });
  expect(started.success, started.error).toBe(true);
  expect(started.runId).toBe(taskId);

  try {
    await expect.poll(async () => {
      return (await readAutomationTask(harness.extensionPage, taskId))?.status;
    }, { timeout: Number(process.env.BROWSER_USE_E2E_TIMEOUT || 90_000) }).toMatch(/success|partial|failed|stopped/);
  } catch (error) {
    const latest = await readAutomationTask(harness.extensionPage, taskId);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLatest Browser Use task:\n${JSON.stringify(latest, null, 2)}`);
  }

  const run = await readAutomationTask(harness.extensionPage, taskId);
  if (run?.metadata?.traceSnapshot) return run.metadata.traceSnapshot;

  const internalRunId = run?.metadata?.computerUseRunId;
  if (!internalRunId) return null;
  const response = await sendRuntimeMessage<any>(harness.extensionPage, {
    type: 'EXECUTE_TOOL',
    toolName: 'get_task_trace',
    arguments: { runId: internalRunId },
  });
  return response?.result?.trace || response?.trace || response?.result;
}

export async function attachHarnessFailure(harness: ExtensionHarness, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const currentUrl = harness.fixturePage.url();
  const pageSummary = await harness.fixturePage.locator('body').innerText().catch(() => '');
  await testInfo.attach('page-state.json', {
    body: JSON.stringify({ currentUrl, pageSummary: pageSummary.slice(0, 8_000) }, null, 2),
    contentType: 'application/json',
  });
}

export async function closeExtensionHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close();
  rmSync(harness.userDataDir, { recursive: true, force: true });
}
