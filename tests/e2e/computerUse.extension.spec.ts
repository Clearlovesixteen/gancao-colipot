import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachHarnessFailure,
  closeExtensionHarness,
  launchExtension,
  runComputerUse,
  sendRuntimeMessage,
  type ExtensionHarness,
} from './extensionHarness';

test.describe('Computer Use V3.1 extension reliability', () => {
  let harness: ExtensionHarness | undefined;

  test.beforeEach(async () => {
    harness = await launchExtension();
  });

  test.afterEach(async ({}, testInfo) => {
    if (!harness) return;
    await attachHarnessFailure(harness, testInfo);
    await closeExtensionHarness(harness);
    harness = undefined;
  });

  test('selects the duplicate leaf under the requested parent and exports a real file', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const trace = await runComputerUse(harness, '打开饮片管理中的库存预警列表，点击导出');
    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
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

  test('keeps the download result across phases and opens the same file in file center', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const trace = await runComputerUse(
      harness,
      '打开饮片管理中的库存预警列表，点击导出，然后打开文件中心，等待1秒，然后点击刚刚下载的文件',
      24,
    );

    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
    await expect(harness.fixturePage.locator('#opened-file-name')).toHaveText('饮片管理-库存预警.xlsx');
    const finalRunState = [...(trace.entries || [])].reverse().find((entry: any) => entry.runState)?.runState;
    expect(finalRunState?.downloadResult?.filename).toContain('饮片管理-库存预警.xlsx');
    expect(finalRunState?.completedPhases.map((item: any) => item.phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
  });

  test('resumes the failed file phase without repeating navigation or export', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const goal = '打开饮片管理中的库存预警列表，点击导出，然后打开文件中心，等待1秒，然后点击刚刚下载的文件';
    await harness.fixturePage.goto('http://127.0.0.1:4173/business.html?hideRecent=1');
    await harness.fixturePage.bringToFront();

    const failedTrace = await runComputerUse(harness, goal, 24);
    expect(failedTrace.status).toBe('error');
    const checkpoint = [...(failedTrace.entries || [])]
      .reverse()
      .find((entry: any) => entry.resumeCheckpoint)
      ?.resumeCheckpoint;
    expect(checkpoint?.phaseIndex).toBe(4);
    expect(checkpoint?.runState?.downloadResult?.filename).toBe('饮片管理-库存预警.xlsx');
    expect(checkpoint?.runState?.completedPhases).toHaveLength(4);

    await harness.fixturePage.goto('http://127.0.0.1:4173/business.html');
    await harness.fixturePage.locator('#file-center-link').click();
    const resumedTrace = await runComputerUse(harness, goal, 8, checkpoint);

    expect(resumedTrace.status, JSON.stringify(resumedTrace, null, 2)).toBe('finished');
    await expect(harness.fixturePage.locator('#opened-file-name')).toHaveText('饮片管理-库存预警.xlsx');
    const actingPhases = (resumedTrace.entries || [])
      .filter((entry: any) => entry.state === 'acting')
      .map((entry: any) => entry.phaseType);
    expect(actingPhases).toEqual(['click_latest_download']);
    expect(JSON.stringify(resumedTrace)).toContain('正在从失败阶段继续');
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

  test('rejects stale side-panel code and exposes the current content build', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    const buildId = JSON.parse(
      readFileSync(resolve(process.cwd(), 'dist/build-info.json'), 'utf8'),
    ).buildId;

    const staleResponse = await sendRuntimeMessage<any>(harness.extensionPage, {
      type: 'RUN_AUTOMATION_TASK',
      clientBuildId: 'stale-side-panel-build',
      taskId: 'stale-browser-use-task',
    });
    expect(staleResponse).toMatchObject({
      success: false,
      code: 'EXTENSION_RUNTIME_MISMATCH',
      buildId,
    });

    await harness.fixturePage.bringToFront();
    const contentInfo = await harness.extensionPage.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) throw new Error('No active fixture tab');
      return await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_CONTENT_RUNTIME_INFO' });
    });
    expect(contentInfo).toMatchObject({ success: true, context: 'content', buildId });
  });

  test('follows a noopener result tab and verifies the requested ordinal', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.goto('http://127.0.0.1:4173/search.html');
    await harness.fixturePage.bringToFront();

    const trace = await runComputerUse(
      harness,
      '打开 http://127.0.0.1:4173/search.html，搜索贝爷，点击第3条搜索结果',
      12,
    );

    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
    const controlledTabId = [...(trace.entries || [])]
      .reverse()
      .find((entry: any) => entry.runState?.browserSession?.currentTabId)
      ?.runState?.browserSession?.currentTabId;
    const controlledPage = harness.context.pages().find((page) => page.url().includes('/search-result.html?index=3'));
    expect(controlledTabId).toBeTruthy();
    expect(controlledPage, JSON.stringify(trace, null, 2)).toBeTruthy();
    await expect(controlledPage!.locator('#result-marker')).toHaveText('已进入第 3 条结果');
    expect(JSON.stringify(trace)).toContain('Browser Use 已接管新标签页');
  });

  test('waits for delayed result DOM and ignores home-page hot topics', async () => {
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.goto('http://127.0.0.1:4173/search.html?delay=1200&targetDelay=1000');
    await harness.fixturePage.bringToFront();

    const trace = await runComputerUse(
      harness,
      '打开 http://127.0.0.1:4173/search.html?delay=1200&targetDelay=1000，搜索贝爷，点击第3条搜索结果',
      12,
    );

    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
    const controlledPage = harness.context.pages().find((page) => page.url().includes('/search-result.html?index=3'));
    expect(controlledPage, JSON.stringify(trace, null, 2)).toBeTruthy();
    await expect(controlledPage!.locator('#result-marker')).toHaveText('已进入第 3 条结果');
    const selectedPhase = [...(trace.entries || [])]
      .reverse()
      .flatMap((entry: any) => entry.runState?.completedPhases || [])
      .find((phase: any) => phase.phase?.type === 'select_collection_item');
    expect(selectedPhase?.summary).toContain('贝爷 搜索结果 3');
    expect(selectedPhase?.summary).not.toContain('LV六度状告国知局');
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

  test('live: searches Bing and verifies the third result after BFCache navigation', async () => {
    test.skip(process.env.RUN_LIVE_BROWSER_TEST !== '1', 'Set RUN_LIVE_BROWSER_TEST=1 to run live search verification.');
    if (!harness) throw new Error('Extension harness was not initialized.');
    await harness.fixturePage.goto('https://www.bing.com/');
    await harness.fixturePage.bringToFront();

    const trace = await runComputerUse(harness, '打开必应，搜索贝爷，点击第3条结果', 16);
    expect(trace.status, JSON.stringify(trace, null, 2)).toBe('finished');
    const serialized = JSON.stringify(trace);
    expect(serialized).toMatch(/select_collection_item|search_results/);
    expect(serialized).toMatch(/"ordinal":3|第3|第 3/);
    expect(harness.fixturePage.url()).not.toMatch(/bing\.com\/search\?/i);
  });
});
