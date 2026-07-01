import type { ComputerUseAction, ComputerUseDownloadResult } from '../shared/automationTypes';
import type { DocumentAsset, DocumentContent, DocumentTable } from '../shared/documentTypes';
import { parseUploadedFile } from '../shared/fileParser';
import {
  makeDocumentId,
  rebuildDocumentChunks,
  saveDocumentContent,
  saveRawFile,
  upsertDocumentAsset,
} from './documentDb';

type DownloadActionInput = {
  runId: string;
  tabId: number;
  pageUrl?: string;
  action: ComputerUseAction;
  click: () => Promise<unknown>;
};

type DownloadWatcher = {
  wait: Promise<chrome.downloads.DownloadItem>;
  cancel: () => void;
};

function basename(filename?: string): string {
  const name = String(filename || '').split(/[\\/]/).filter(Boolean).pop();
  return name || `download_${Date.now()}`;
}

function extensionMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

function sheetsToTables(sheets: Awaited<ReturnType<typeof parseUploadedFile>>['sheets']): DocumentTable[] | undefined {
  if (!sheets?.length) return undefined;
  return sheets.map((sheet) => ({
    title: sheet.name,
    headers: (sheet.headers || []).map(String),
    rows: sheet.rows.map((row) => row.map((cell) => String(cell ?? ''))),
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
  }));
}

function createDownloadWatcher(startedAt: number, timeoutMs: number): DownloadWatcher {
  let done = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onChanged.removeListener(onChanged);
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
  };

  const isRecentDownload = (item: chrome.downloads.DownloadItem): boolean => {
    const startTime = item.startTime ? Date.parse(item.startTime) : Date.now();
    return startTime >= startedAt - 1500;
  };

  const resolveItem = async (
    id: number,
    resolve: (item: chrome.downloads.DownloadItem) => void,
    reject: (error: Error) => void
  ) => {
    try {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !isRecentDownload(item)) return;
      if (item.state === 'complete') {
        done = true;
        cleanup();
        resolve(item);
      } else if (item.state === 'interrupted') {
        done = true;
        cleanup();
        reject(new Error(item.error || '下载被中断'));
      }
    } catch (error: any) {
      done = true;
      cleanup();
      reject(new Error(error?.message || '读取下载状态失败'));
    }
  };

  let onCreated: (item: chrome.downloads.DownloadItem) => void = () => {};
  let onChanged: (delta: chrome.downloads.DownloadDelta) => void = () => {};

  const wait = new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
    onCreated = (item) => {
      if (done || !isRecentDownload(item)) return;
      if (item.state === 'complete') {
        done = true;
        cleanup();
        resolve(item);
      }
    };

    onChanged = (delta) => {
      if (done || !delta.id || !delta.state?.current) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        resolveItem(delta.id, resolve, reject);
      }
    };

    timeoutId = setTimeout(() => {
      done = true;
      cleanup();
      reject(new Error('等待下载完成超时'));
    }, timeoutMs);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  });

  return {
    wait,
    cancel: () => {
      done = true;
      cleanup();
    },
  };
}

async function fetchDownloadedBlob(item: chrome.downloads.DownloadItem): Promise<Blob> {
  const url = item.finalUrl || item.url;
  if (!url) throw new Error('下载记录缺少 URL');
  if (/^blob:/i.test(url)) throw new Error('浏览器不允许扩展直接读取页面 blob: 下载内容');
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`重新获取下载文件失败: HTTP ${response.status}`);
  return await response.blob();
}

async function saveDownloadedFileToDocuments(input: {
  item: chrome.downloads.DownloadItem;
  runId: string;
  tabId: number;
  pageUrl?: string;
}): Promise<Pick<ComputerUseDownloadResult, 'assetId' | 'assetTitle' | 'localParseStatus' | 'parseError' | 'savedToDocumentCenter'>> {
  const title = basename(input.item.filename);
  const blob = await fetchDownloadedBlob(input.item);
  const mimeType = input.item.mime || blob.type || extensionMime(title);
  const file = new File([blob], title, { type: mimeType });
  const parsed = await parseUploadedFile(file);
  const now = Date.now();
  const assetId = makeDocumentId('download');
  const tables = sheetsToTables(parsed.sheets);
  const asset: DocumentAsset = {
    id: assetId,
    sourceType: 'file',
    title,
    mimeType,
    size: file.size,
    createdAt: now,
    updatedAt: now,
    localParseStatus: parsed.status,
    nativeUploadStatus: 'skipped',
    ocrStatus: parsed.warning?.includes('OCR') ? 'pending' : 'not_needed',
    error: parsed.error,
  };
  const content: DocumentContent = {
    assetId,
    text: parsed.text || '',
    localText: parsed.text || '',
    tables,
    metadata: {
      ...parsed.metadata,
      warning: parsed.warning,
      error: parsed.error,
      download: {
        downloadId: input.item.id,
        url: input.item.url,
        finalUrl: input.item.finalUrl,
        pageUrl: input.pageUrl,
        tabId: input.tabId,
        capturedByRunId: input.runId,
        danger: input.item.danger,
      },
    },
    updatedAt: now,
  };

  await upsertDocumentAsset(asset);
  await saveRawFile(assetId, file);
  await saveDocumentContent(content);
  await rebuildDocumentChunks(asset, content);

  return {
    assetId,
    assetTitle: title,
    localParseStatus: parsed.status,
    parseError: parsed.error || parsed.warning,
    savedToDocumentCenter: true,
  };
}

export async function performDownloadFileAction(input: DownloadActionInput): Promise<ComputerUseDownloadResult> {
  if (!chrome?.downloads) {
    throw new Error('当前扩展环境不支持 downloads API');
  }

  const startedAt = Date.now();
  const timeoutMs = Math.max(3000, Math.min(Number(input.action.timeoutMs || 30000), 120000));
  const watcher = createDownloadWatcher(startedAt, timeoutMs);

  try {
    await input.click();
  } catch (error) {
    watcher.cancel();
    throw error;
  }

  let item: chrome.downloads.DownloadItem;
  try {
    item = await watcher.wait;
  } catch (error: any) {
    return {
      success: false,
      status: error?.message?.includes('超时') ? 'timeout' : 'failed',
      message: error?.message || '下载失败',
      error: error?.message || '下载失败',
      needsManualImport: true,
    };
  }

  const baseResult: ComputerUseDownloadResult = {
    success: true,
    status: 'completed',
    message: `已触发下载：${basename(item.filename)}`,
    downloadId: item.id,
    filename: basename(item.filename),
    url: item.url,
    finalUrl: item.finalUrl,
    mimeType: item.mime,
    size: item.fileSize || item.totalBytes,
    state: item.state,
    danger: item.danger,
    savedToDocumentCenter: false,
  };

  try {
    const saved = await saveDownloadedFileToDocuments({
      item,
      runId: input.runId,
      tabId: input.tabId,
      pageUrl: input.pageUrl,
    });
    return {
      ...baseResult,
      ...saved,
      message: `已导出文件：${baseResult.filename}，并保存到资料中心。`,
    };
  } catch (error: any) {
    return {
      ...baseResult,
      status: 'partial',
      message: `已触发下载：${baseResult.filename}，但无法自动读取文件内容，请从下载目录手动添加。`,
      error: error?.message || '文件已下载但入库失败',
      needsManualImport: true,
    };
  }
}
