import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../shared/automationTypes';
import { ensureOcrHost, runOcrTask, stopOcrTask } from './ocrJobService';

function createRun(metadata: Record<string, unknown> = {}): AutomationRun {
  return {
    id: 'ocr-task-1',
    kind: 'ocr',
    title: 'OCR test',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata,
  } as AutomationRun;
}

describe('ocrJobService', () => {
  const getContexts = vi.fn();
  const createDocument = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    getContexts.mockReset().mockResolvedValue([]);
    createDocument.mockReset().mockResolvedValue(undefined);
    sendMessage.mockReset().mockResolvedValue({ success: true, assetId: 'asset-1' });
    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts,
        sendMessage,
      },
      offscreen: {
        Reason: { DOM_PARSER: 'DOM_PARSER' },
        createDocument,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the offscreen OCR host only when it is missing', async () => {
    await ensureOcrHost();
    expect(createDocument).toHaveBeenCalledWith({
      url: 'ocrHost.html',
      reasons: ['DOM_PARSER'],
      justification: '在 SidePanel 关闭时继续执行本地 PaddleOCR 任务',
    });

    getContexts.mockResolvedValueOnce([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    createDocument.mockClear();
    await ensureOcrHost();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('runs OCR through the offscreen host without a SidePanel dependency', async () => {
    const result = await runOcrTask(createRun({ assetId: 'asset-1', maxPages: 8 }));

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'OCR_HOST_RUN',
      taskId: 'ocr-task-1',
      assetId: 'asset-1',
      maxPages: 8,
    });
    expect(result).toMatchObject({ status: 'success', summary: 'OCR 完成' });
  });

  it('preserves a stopped or partial OCR result', async () => {
    sendMessage.mockResolvedValueOnce({
      success: false,
      stopped: true,
      partial: true,
      error: 'OCR 已停止',
    });

    await expect(runOcrTask(createRun({ assetId: 'asset-1' }))).resolves.toMatchObject({
      status: 'stopped',
      summary: 'OCR 已停止',
    });
  });

  it('sends stop to the offscreen host', async () => {
    await stopOcrTask('ocr-task-1');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'OCR_HOST_STOP',
      taskId: 'ocr-task-1',
    });
  });
});
