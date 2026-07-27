import { expect, test } from '@playwright/test';
import {
  attachHarnessFailure,
  closeExtensionHarness,
  configureFixtureModel,
  getBuiltExtensionBuildId,
  launchExtension,
  readDocumentAssetState,
  readMemoryFixture,
  rerunAutomationTask,
  runAutomationTask,
  seedDocumentAsset,
  seedMemoryFixture,
  sendRuntimeMessage,
  setMonitorFixtureValue,
  type ExtensionHarness,
} from './extensionHarness';

function createJpegPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const push = (value: string | Buffer) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'binary');
    chunks.push(chunk);
    length += chunk.length;
  };
  const addObject = (id: number, parts: Array<string | Buffer>) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    parts.forEach((part) => push(part));
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  addObject(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  addObject(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  addObject(3, [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  ]);
  addObject(4, [
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream',
  ]);
  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  addObject(5, [
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n`,
    content,
    'endstream',
  ]);

  const xrefOffset = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) {
    push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

test.describe('Non Browser Use extension task gate', () => {
  let harness: ExtensionHarness | null = null;

  test.afterEach(async ({}, testInfo) => {
    if (!harness) return;
    await attachHarnessFailure(harness, testInfo);
    await closeExtensionHarness(harness);
    harness = null;
  });

  test('configures a model, receives streaming chat, and stops an active stream', async () => {
    harness = await launchExtension();
    await configureFixtureModel(harness);

    const result = await harness.extensionPage.evaluate(async (buildId) => {
      const requestId = `e2e_stream_${Date.now()}`;
      const events: any[] = [];
      const listener = (message: any) => {
        if (message.type === 'SSE_MESSAGE' && message.message?.requestId === requestId) {
          events.push(message.message);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      const sendPromise = new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({
          type: 'SEND_MESSAGE',
          clientBuildId: buildId,
          requestId,
          messageHistory: [{ role: 'user', content: 'LONG_STREAM_TEST' }],
        }, resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const stop = await chrome.runtime.sendMessage({ type: 'STOP_AI_MESSAGE' });
      const send = await sendPromise;
      await new Promise((resolve) => setTimeout(resolve, 150));
      chrome.runtime.onMessage.removeListener(listener);
      return { events, stop, send };
    }, getBuiltExtensionBuildId());

    expect(result.events.some((event: any) => event.delivery === 'streaming')).toBe(true);
    expect(result.stop).toMatchObject({ success: true, cancelled: true });
    expect(result.send.cancelled).toBe(true);
    expect(result.events.some((event: any) => event.delivery === 'final')).toBe(false);
  });

  test('runs page diagnosis and persists the diagnosis context', async () => {
    harness = await launchExtension();
    await configureFixtureModel(harness);
    await harness.fixturePage.evaluate(() => {
      console.error('E2E_DIAGNOSIS_ERROR');
      Promise.reject(new Error('E2E_DIAGNOSIS_REJECTION')).catch(() => {});
    });

    const task = await runAutomationTask(harness, {
      kind: 'page_diagnosis',
      title: 'E2E 页面诊断',
      goal: '诊断当前页面错误',
    });

    expect(task.status).toBe('success');
    expect(task.resultSummary).toBe('页面诊断完成');
    expect(task.metadata.taskOutput.answer).toContain('问题摘要');
    expect(task.metadata.taskOutput.context).toMatchObject({
      url: expect.stringContaining('/business.html'),
      title: expect.any(String),
    });
  });

  test('uploads a local document asset and returns document QA sources', async () => {
    harness = await launchExtension();
    await configureFixtureModel(harness);
    const assetId = await seedDocumentAsset(harness, {
      title: '需求说明.md',
      mimeType: 'text/markdown',
      text: '# 验收标准\n甘草 Copilot 的资料回答必须保留来源引用，并显示页码与章节。',
      pageNumber: 2,
      sectionTitle: '验收标准',
      bytes: Array.from(new TextEncoder().encode('# 验收标准\n必须保留来源引用')),
    });

    const task = await runAutomationTask(harness, {
      kind: 'document_qa',
      title: 'E2E 资料问答',
      goal: '验收标准要求保留什么？',
      metadata: { question: '验收标准要求保留什么？', documentIds: [assetId] },
    });

    expect(task.status).toBe('success');
    expect(task.metadata.taskOutput.answer).toContain('资料要求保留来源引用');
    expect(task.metadata.taskOutput.sources).toEqual([
      expect.objectContaining({
        documentId: assetId,
        documentTitle: '需求说明.md',
        pageNumber: 2,
        sectionTitle: '验收标准',
        chunkId: `${assetId}_chunk_0`,
      }),
    ]);
  });

  test('runs PaddleOCR for an image and a scanned PDF', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'PaddleOCR extension runtime requires Chromium.');
    test.setTimeout(360_000);
    harness = await launchExtension();

    const renderPage = await harness.context.newPage();
    await renderPage.setViewportSize({ width: 1200, height: 500 });
    await renderPage.setContent(`
      <!doctype html><html><body style="margin:0;background:#fff">
        <div style="padding:80px;font:700 72px Arial;color:#000">OCR TEST 123</div>
      </body></html>
    `);
    const image = await renderPage.screenshot({ type: 'png' });
    const jpeg = await renderPage.screenshot({ type: 'jpeg', quality: 90 });
    const pdf = createJpegPdf(jpeg, 1200, 500);
    await renderPage.close();

    const imageAssetId = await seedDocumentAsset(harness, {
      title: 'ocr-test.png',
      mimeType: 'image/png',
      bytes: Array.from(image),
    });
    const imageTask = await runAutomationTask(harness, {
      kind: 'ocr',
      title: 'E2E 图片 OCR',
      metadata: { assetId: imageAssetId, maxPages: 1 },
    }, 240_000);
    expect(['success', 'partial']).toContain(imageTask.status);
    const imageState = await readDocumentAssetState(harness, imageAssetId);
    expect(imageState.content?.ocrText).toMatch(/OCR|TEST|123/i);

    const pdfAssetId = await seedDocumentAsset(harness, {
      title: 'ocr-scan.pdf',
      mimeType: 'application/pdf',
      bytes: Array.from(pdf),
    });
    const pdfTask = await runAutomationTask(harness, {
      kind: 'ocr',
      title: 'E2E 扫描 PDF OCR',
      metadata: { assetId: pdfAssetId, maxPages: 1 },
    }, 240_000);
    expect(['success', 'partial'], JSON.stringify(pdfTask)).toContain(pdfTask.status);
    const pdfState = await readDocumentAssetState(harness, pdfAssetId);
    expect(pdfState.content?.structuredOcr?.pageCount).toBeGreaterThanOrEqual(1);
    expect(pdfState.content?.ocrText).toMatch(/OCR|TEST|123/i);
  });

  test('detects page monitor changes and restores its alarm', async () => {
    harness = await launchExtension('/monitor.html');
    await setMonitorFixtureValue('库存正常');
    const taskId = `e2e_monitor_${Date.now()}`;
    const first = await runAutomationTask(harness, {
      id: taskId,
      kind: 'page_monitor',
      title: 'E2E 页面监控',
      schedule: { enabled: true, intervalMinutes: 1 },
      metadata: {
        monitor: {
          url: 'http://127.0.0.1:4173/monitor.html',
          intervalMinutes: 1,
          extractMode: 'page_text',
          rule: { type: 'changed' },
        },
      },
    });
    expect(['success', 'partial']).toContain(first.status);
    const firstHash = first.metadata.monitor.lastSnapshot.hash;

    const alarmResponse = await sendRuntimeMessage<any>(harness.extensionPage, {
      type: 'UPSERT_PAGE_MONITOR_ALARM',
      runId: taskId,
    });
    expect(alarmResponse.success).toBe(true);
    const alarm = await harness.extensionPage.evaluate((name) => chrome.alarms.get(name), `page-monitor:${taskId}`);
    expect(alarm?.name).toBe(`page-monitor:${taskId}`);

    await setMonitorFixtureValue('库存告警');
    const second = await rerunAutomationTask(harness, taskId);
    expect(['success', 'partial']).toContain(second.status);
    expect(second.metadata.monitor.lastSnapshot.hash).not.toBe(firstHash);
    expect(second.metadata.monitor.lastChangedAt).toBeTruthy();
  });

  test('runs a workflow, persists memory, and synchronizes page login/logout', async () => {
    harness = await launchExtension();
    const workflowTask = await runAutomationTask(harness, {
      kind: 'workflow',
      title: 'E2E Workflow',
      metadata: {
        workflow: {
          name: '打开并校验业务页',
          steps: [
            { id: 'navigate', type: 'navigate', url: 'http://127.0.0.1:4173/business.html', waitFor: 'complete' },
            { id: 'assert', type: 'assert', assertion: 'text_exists', text: '饮片管理' },
          ],
        },
      },
    });
    expect(workflowTask.status).toBe('success');
    expect(workflowTask.metadata.taskOutput.steps).toHaveLength(2);

    const memoryIds = await seedMemoryFixture(harness);
    await harness.extensionPage.reload();
    const memoryState = await readMemoryFixture(harness, memoryIds);
    expect(memoryState.session.title).toBe('E2E 历史会话');
    expect(memoryState.memory.content).toContain('测试仓');

    await harness.fixturePage.bringToFront();
    await harness.fixturePage.evaluate(() => {
      localStorage.setItem('authToken', 'e2e-page-token');
      localStorage.setItem('userInfo', JSON.stringify({ name: 'E2E 用户' }));
      document.body.setAttribute('data-auth-state', 'logged-in');
    });
    await expect.poll(async () => harness!.extensionPage.evaluate(async () => (
      chrome.storage.local.get(['user_auth', 'authSource', 'pageAuthHost'])
    )), { timeout: 5_000 }).toMatchObject({
      user_auth: true,
      authSource: 'page',
      pageAuthHost: '127.0.0.1',
    });

    await harness.fixturePage.evaluate(() => {
      localStorage.removeItem('authToken');
      localStorage.removeItem('userInfo');
      document.body.innerHTML = '<main><h1>请登录</h1><p>登录以继续</p></main>';
    });
    await expect.poll(async () => harness!.extensionPage.evaluate(async () => (
      chrome.storage.local.get(['user_auth', 'authSource'])
    )), { timeout: 6_000 }).toMatchObject({ user_auth: false });
  });
});
