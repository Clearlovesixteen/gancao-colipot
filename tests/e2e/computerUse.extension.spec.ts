import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ExtensionHarness = {
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

async function launchExtension(fixturePath = '/business.html'): Promise<ExtensionHarness> {
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

async function sendRuntimeMessage<T>(extensionPage: Page, payload: unknown): Promise<T> {
  return extensionPage.evaluate((message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError?.message;
      if (error) reject(new Error(error));
      else resolve(response);
    });
  }), payload) as Promise<T>;
}

async function runComputerUse(harness: ExtensionHarness, goal: string, maxSteps = 16): Promise<any> {
  await harness.fixturePage.bringToFront();
  const started = await sendRuntimeMessage<{ success: boolean; runId?: string; error?: string }>(harness.extensionPage, {
    type: 'RUN_COMPUTER_USE',
    goal,
    maxSteps,
  });
  expect(started.success, started.error).toBe(true);
  expect(started.runId).toBeTruthy();

  await expect.poll(async () => {
    const response = await sendRuntimeMessage<any>(harness.extensionPage, {
      type: 'EXECUTE_TOOL',
      toolName: 'get_task_trace',
      arguments: { runId: started.runId },
    });
    return response?.result?.trace?.status || response?.trace?.status || response?.result?.status;
  }, { timeout: 90_000 }).toMatch(/finished|error/);

  const response = await sendRuntimeMessage<any>(harness.extensionPage, {
    type: 'EXECUTE_TOOL',
    toolName: 'get_task_trace',
    arguments: { runId: started.runId },
  });
  return response?.result?.trace || response?.trace || response?.result;
}

test.describe('Computer Use V3.1 extension reliability', () => {
  let harness: ExtensionHarness | undefined;

  test.beforeEach(async () => {
    harness = await launchExtension();
  });

  test.afterEach(async ({}, testInfo) => {
    if (!harness) return;
    if (testInfo.status !== testInfo.expectedStatus) {
      const currentUrl = harness.fixturePage.url();
      const pageSummary = await harness.fixturePage.locator('body').innerText().catch(() => '');
      await testInfo.attach('page-state.json', {
        body: JSON.stringify({ currentUrl, pageSummary: pageSummary.slice(0, 8_000) }, null, 2),
        contentType: 'application/json',
      });
    }
    await harness.context.close();
    rmSync(harness.userDataDir, { recursive: true, force: true });
    harness = undefined;
  });

  test('selects the duplicate leaf under the requested parent and exports a real file', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const trace = await runComputerUse(harness, '打开饮片管理中的库存预警列表，点击导出');
    expect(trace.status).toBe('finished');
    await expect(harness.fixturePage.locator('#route-label')).toHaveText('饮片管理 / 库存预警');
    expect(JSON.stringify(trace)).toContain('download_button');
    expect(JSON.stringify(trace)).not.toContain('颗粒剂管理-库存预警.xlsx');
  });

  test('fills filters, searches and downloads the first table row action', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.locator('#file-center-link').click();
    const trace = await runComputerUse(
      harness,
      '子系统选择智慧药房WMS仓储，再输入用户花名：秋枫，再点击查询，下载第一条数据',
      20,
    );
    expect(trace.status).toBe('finished');
    await expect(harness.fixturePage.locator('#subsystem')).toHaveValue('智慧药房WMS仓储');
    await expect(harness.fixturePage.locator('#user-alias')).toHaveValue('秋枫');
    await expect(harness.fixturePage.locator('#file-rows tr')).toHaveCount(2);
    const finalRunState = [...(trace.entries || [])].reverse().find((entry: any) => entry.runState)?.runState;
    const downloadUrl = finalRunState?.downloadResult?.finalUrl || finalRunState?.downloadResult?.url || '';
    expect(decodeURIComponent(downloadUrl)).toContain('库存预警-秋枫-001.xlsx');
    expect(decodeURIComponent(downloadUrl)).not.toContain('库存预警-秋枫-002.xlsx');
  });

  test('fails with phase evidence when the target page has no export action', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.goto('http://127.0.0.1:4173/business.html?noExport=1');
    await harness.fixturePage.bringToFront();
    const trace = await runComputerUse(harness, '打开饮片管理中的库存预警列表，点击导出');
    expect(trace.status).toBe('error');
    const serialized = JSON.stringify(trace);
    expect(serialized).toContain('download_file');
    expect(serialized).toMatch(/未找到|导出|下载/);
  });

  test('model connection test always returns a structured runtime response', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const response = await sendRuntimeMessage<any>(harness.extensionPage, {
      type: 'TEST_MODEL_PROFILE',
      profile: {
        name: 'E2E OpenAI Compatible',
        provider: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:4173/v1',
        model: 'fixture-model',
        apiKey: 'fixture-key',
        capabilities: { streaming: true, tools: true, json: true, files: false },
      },
    });
    expect(response).toEqual({ success: true });
  });

  test('live: searches Baidu and opens the fifth natural result', async () => {
    test.skip(process.env.RUN_LIVE_BROWSER_TEST !== '1', 'Set RUN_LIVE_BROWSER_TEST=1 to run live search verification.');
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.goto('https://www.baidu.com/');
    await harness.fixturePage.bringToFront();

    const trace = await runComputerUse(harness, '打开百度，搜索贝爷，点击第5条结果', 16);
    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
    const serialized = JSON.stringify(trace);
    expect(serialized).toMatch(/select_collection_item|search_results/);
    expect(serialized).toMatch(/"ordinal":5|第5|第 5/);
    expect(harness.fixturePage.url()).not.toMatch(/[?&](wd|word)=/i);
  });
});
