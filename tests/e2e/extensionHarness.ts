import { chromium, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function getBuiltExtensionBuildId(): string {
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

export async function runAutomationTask(
  harness: ExtensionHarness,
  input: {
    kind: string;
    title: string;
    goal?: string;
    metadata?: Record<string, unknown>;
    workflowId?: string;
    schedule?: Record<string, unknown>;
  },
  timeout = 90_000,
): Promise<any> {
  const taskId = `e2e_${input.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await harness.extensionPage.evaluate(async ({ taskId: id, task }) => {
    const stored = await chrome.storage.local.get('automationRuns');
    const runs = Array.isArray(stored.automationRuns) ? stored.automationRuns : [];
    const now = Date.now();
    await chrome.storage.local.set({
      automationRuns: [{
        id,
        title: task.title,
        kind: task.kind,
        status: 'idle',
        goal: task.goal,
        source: 'system',
        workflowId: task.workflowId,
        schedule: task.schedule,
        metadata: task.metadata || {},
        createdAt: now,
        updatedAt: now,
      }, ...runs.filter((run: any) => run?.id !== id)],
    });
  }, { taskId, task: input });

  const started = await sendRuntimeMessage<{ success: boolean; runId?: string; error?: string }>(harness.extensionPage, {
    type: 'RUN_AUTOMATION_TASK',
    clientBuildId: getBuiltExtensionBuildId(),
    taskId,
  });
  expect(started.success, started.error).toBe(true);

  await expect.poll(async () => {
    return harness.extensionPage.evaluate(async (id) => {
      const stored = await chrome.storage.local.get('automationRuns');
      const run = (stored.automationRuns || []).find((item: any) => item?.id === id);
      if (!run) return false;
      return /success|partial|failed|stopped/.test(run.status) || (run.status === 'idle' && Boolean(run.endedAt));
    }, taskId);
  }, { timeout }).toBe(true);

  return harness.extensionPage.evaluate(async (id) => {
    const stored = await chrome.storage.local.get('automationRuns');
    return (stored.automationRuns || []).find((item: any) => item?.id === id) || null;
  }, taskId);
}

export async function runComputerUse(harness: ExtensionHarness, goal: string, maxSteps = 16, resumeCheckpoint?: unknown): Promise<any> {
  await harness.fixturePage.bringToFront();
  const taskId = `e2e_browser_use_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await harness.extensionPage.evaluate(async ({ taskId: id, taskGoal, taskMaxSteps, checkpoint }) => {
    const stored = await chrome.storage.local.get('automationRuns');
    const runs = Array.isArray(stored.automationRuns) ? stored.automationRuns : [];
    const now = Date.now();
    await chrome.storage.local.set({
      automationRuns: [{
        id,
        title: `Browser Use E2E：${taskGoal.slice(0, 40)}`,
        kind: 'computer_use',
        status: 'idle',
        goal: taskGoal,
        source: 'system',
        metadata: { maxSteps: taskMaxSteps, resumeCheckpoint: checkpoint },
        createdAt: now,
        updatedAt: now,
      }, ...runs.filter((run: any) => run?.id !== id)],
    });
  }, { taskId, taskGoal: goal, taskMaxSteps: maxSteps, checkpoint: resumeCheckpoint });

  const started = await sendRuntimeMessage<{ success: boolean; runId?: string; error?: string }>(harness.extensionPage, {
    type: 'RUN_AUTOMATION_TASK',
    clientBuildId: getBuiltExtensionBuildId(),
    taskId,
  });
  expect(started.success, started.error).toBe(true);
  expect(started.runId).toBe(taskId);

  try {
    await expect.poll(async () => {
      return await harness.extensionPage.evaluate(async (id) => {
        const stored = await chrome.storage.local.get('automationRuns');
        const run = (stored.automationRuns || []).find((item: any) => item?.id === id);
        return run?.status;
      }, taskId);
    }, { timeout: Number(process.env.BROWSER_USE_E2E_TIMEOUT || 90_000) }).toMatch(/success|partial|failed|stopped/);
  } catch (error) {
    const latest = await harness.extensionPage.evaluate(async (id) => {
      const stored = await chrome.storage.local.get('automationRuns');
      return (stored.automationRuns || []).find((item: any) => item?.id === id) || null;
    }, taskId);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLatest Browser Use task:\n${JSON.stringify(latest, null, 2)}`);
  }

  const run = await harness.extensionPage.evaluate(async (id) => {
    const stored = await chrome.storage.local.get('automationRuns');
    return (stored.automationRuns || []).find((item: any) => item?.id === id) || null;
  }, taskId);
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
