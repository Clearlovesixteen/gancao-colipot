import type { AutomationRun } from '../shared/automationTypes';
import type { TaskResult } from './taskExecutorRegistry';

const OFFSCREEN_URL = 'ocrHost.html';

async function ensureOcrHost(): Promise<void> {
  if (!chrome.offscreen) throw new Error('当前 Chrome 版本不支持 Offscreen Document');
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] })
    : [];
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: '在 SidePanel 关闭时继续执行本地 PaddleOCR 任务',
    });
  } catch (error: any) {
    if (!/Only a single offscreen document|already exists/i.test(String(error?.message || error))) throw error;
  }
}

export async function runOcrTask(run: AutomationRun): Promise<TaskResult> {
  const assetId = String(run.metadata?.assetId || '');
  if (!assetId) return { status: 'failed', summary: 'OCR 任务缺少资料 ID', error: 'OCR 任务缺少资料 ID' };
  await ensureOcrHost();
  const response = await chrome.runtime.sendMessage({
    type: 'OCR_HOST_RUN',
    taskId: run.id,
    assetId,
    maxPages: Number(run.metadata?.maxPages || 20),
  });
  if (response?.success) {
    return {
      status: response.partial ? 'partial' : 'success',
      summary: response.partial ? 'OCR 完成，部分页面或文本需要人工核对' : 'OCR 完成',
      output: response,
    };
  }
  return {
    status: response?.stopped ? 'stopped' : response?.partial ? 'partial' : 'failed',
    summary: response?.error || 'OCR 失败',
    error: response?.error,
    output: response,
  };
}

export async function stopOcrTask(taskId: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'OCR_HOST_STOP', taskId }).catch(() => {});
}
