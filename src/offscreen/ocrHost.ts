import { runOcr, getOcrErrorMessage } from '../sidePanel/utils/ocrEngine';
import { structureOcrText, structuredOcrToMarkdown } from '../shared/ocrStructurer';
import {
  getDocumentAsset,
  getDocumentContent,
  getRawFile,
  rebuildDocumentChunks,
  saveDocumentContent,
  upsertDocumentAsset,
} from '../shared/documentRepository';

const jobs = new Map<string, AbortController>();

async function executeOcrJob(message: any): Promise<any> {
  const taskId = String(message.taskId || '');
  const assetId = String(message.assetId || '');
  if (!taskId || !assetId) throw new Error('OCR 任务缺少 taskId 或 assetId');
  const [asset, rawFile, existing] = await Promise.all([
    getDocumentAsset(assetId),
    getRawFile(assetId),
    getDocumentContent(assetId),
  ]);
  if (!asset) throw new Error('未找到 OCR 资料');
  if (!rawFile) throw new Error('资料原始文件不存在，无法 OCR');

  const controller = new AbortController();
  jobs.set(taskId, controller);
  await upsertDocumentAsset({ ...asset, ocrStatus: 'running', updatedAt: Date.now(), error: undefined });
  try {
    const result = await runOcr(rawFile, asset.mimeType || rawFile.type || '', {
      maxPages: Number(message.maxPages || 20),
      signal: controller.signal,
      onProgress(progress) {
        chrome.runtime.sendMessage({
          type: 'AUTOMATION_TASK_PROGRESS',
          taskId,
          kind: 'ocr',
          stage: progress.status,
          summary: progress.pageNumber
            ? `正在识别第 ${progress.pageNumber}/${progress.pageCount || '?'} 页`
            : '正在初始化 PaddleOCR',
          data: progress,
        }).catch(() => {});
      },
    });
    const structuredOcr = structureOcrText({
      text: result.text,
      pages: result.pages,
      warnings: result.warnings,
    });
    const structuredMarkdown = structuredOcrToMarkdown(structuredOcr);
    const content = {
      assetId,
      ...(existing || {}),
      text: [existing?.localText, structuredMarkdown || result.text].filter(Boolean).join('\n\n'),
      ocrText: result.text,
      structuredOcr,
      tables: [
        ...(existing?.tables || []).filter((table) => !table.title?.startsWith('OCR 表格')),
        ...structuredOcr.tables,
      ],
      metadata: {
        ...(existing?.metadata || {}),
        ocrPages: result.pages,
        ocrQuality: result.quality,
        ocrWarnings: result.warnings,
      },
      updatedAt: Date.now(),
    };
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);
    await upsertDocumentAsset({
      ...asset,
      ocrStatus: result.text.trim() ? (result.warnings.length ? 'partial' : 'done') : 'error',
      updatedAt: Date.now(),
      error: result.text.trim() ? undefined : '未识别到文字',
    });
    return { success: true, partial: result.warnings.length > 0, assetId, result, structuredOcr };
  } catch (error: any) {
    const stopped = controller.signal.aborted || error?.name === 'AbortError';
    const errorMessage = stopped ? 'OCR 已停止' : getOcrErrorMessage(error);
    await upsertDocumentAsset({ ...asset, ocrStatus: stopped ? 'partial' : 'error', updatedAt: Date.now(), error: errorMessage });
    return { success: false, stopped, partial: stopped, assetId, error: errorMessage };
  } finally {
    jobs.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OCR_HOST_RUN') {
    executeOcrJob(message).then(sendResponse).catch((error) => sendResponse({ success: false, error: getOcrErrorMessage(error) }));
    return true;
  }
  if (message.type === 'OCR_HOST_STOP') {
    jobs.get(String(message.taskId || ''))?.abort();
    sendResponse({ success: true });
    return false;
  }
  return false;
});
