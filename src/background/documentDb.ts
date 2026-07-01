import type {
  DocumentAsset,
  DocumentChunk,
  DocumentContent,
  DocumentResult,
  DocumentSearchMatch,
  DocumentTable,
  RequirementTask,
  RequirementTaskResult,
  SourceRef,
} from '../shared/documentTypes';

const DB_NAME = 'gancao_document_center';
const DB_VERSION = 1;
const ASSETS_STORE = 'assets';
const CONTENTS_STORE = 'assetContents';
const CHUNKS_STORE = 'chunks';
const RESULTS_STORE = 'results';
const RAW_FILES_STORE = 'rawFiles';
const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 180;
const TASK_KEYWORDS = ['需要', '支持', '实现', '新增', '优化', '修复', '允许', '提供', '用户可以', '系统应', '必须', '应该'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSETS_STORE)) {
        db.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CONTENTS_STORE)) {
        db.createObjectStore(CONTENTS_STORE, { keyPath: 'assetId' });
      }
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunks.createIndex('assetId', 'assetId', { unique: false });
      }
      if (!db.objectStoreNames.contains(RESULTS_STORE)) {
        const results = db.createObjectStore(RESULTS_STORE, { keyPath: 'id' });
        results.createIndex('kind', 'kind', { unique: false });
      }
      if (!db.objectStoreNames.contains(RAW_FILES_STORE)) {
        db.createObjectStore(RAW_FILES_STORE, { keyPath: 'assetId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开资料库失败'));
  });

  return dbPromise;
}

function runStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  runner: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = runner(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error || new Error('资料库操作失败'));
    }

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('资料库事务失败'));
  }));
}

function runTransaction(
  storeNames: string[],
  mode: IDBTransactionMode,
  runner: (stores: Record<string, IDBObjectStore>) => void
): Promise<void> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = storeNames.reduce((acc, name) => {
      acc[name] = tx.objectStore(name);
      return acc;
    }, {} as Record<string, IDBObjectStore>);

    runner(stores);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('资料库事务失败'));
  }));
}

function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return runStore<T[]>(storeName, 'readonly', (store) => store.getAll()).then((items) => items || []);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function extractKeywords(text: string): string[] {
  const words = Array.from(text.matchAll(/[\p{L}\p{N}_-]{2,}/gu))
    .map((match) => match[0].toLowerCase())
    .filter((word) => !/^\d+$/.test(word));
  return Array.from(new Set(words)).slice(0, 24);
}

function getPageNumber(section: string): number | undefined {
  const match = section.match(/^##\s*Page\s+(\d+)/im);
  return match ? Number(match[1]) : undefined;
}

function getSectionTitle(section: string): string | undefined {
  const match = section.match(/^#{1,4}\s+(.+)$/m);
  return match?.[1]?.trim();
}

function splitLongSection(section: string, maxChars: number, overlapChars: number): string[] {
  if (section.length <= maxChars) return [section];

  const chunks: string[] = [];
  let start = 0;
  while (start < section.length) {
    const end = Math.min(section.length, start + maxChars);
    chunks.push(section.slice(start, end).trim());
    if (end >= section.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks.filter(Boolean);
}

function tableToText(table: DocumentTable, index: number): string {
  const title = table.title || `Table ${index + 1}`;
  const header = table.headers.length ? table.headers.join('\t') : '';
  const rows = table.rows.map((row) => row.join('\t')).join('\n');
  return [`## ${title}`, header, rows].filter(Boolean).join('\n');
}

function chunkDocument(input: {
  assetId: string;
  title: string;
  text?: string;
  tables?: DocumentTable[];
  maxChars?: number;
  overlapChars?: number;
}): DocumentChunk[] {
  const maxChars = input.maxChars || DEFAULT_MAX_CHARS;
  const overlapChars = input.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const now = Date.now();
  const chunks: DocumentChunk[] = [];
  const parts: string[] = [];
  const text = normalizeText(input.text || '');

  if (text) parts.push(...text.split(/\n(?=#{1,4}\s+)/g));
  if (input.tables?.length) parts.push(...input.tables.map(tableToText));

  const sections = parts.length ? parts : text ? [text] : [];
  sections.forEach((section) => {
    splitLongSection(section.trim(), maxChars, overlapChars).forEach((chunkText) => {
      if (!chunkText) return;
      const index = chunks.length;
      chunks.push({
        id: `${input.assetId}_chunk_${index}_${Math.random().toString(36).slice(2, 8)}`,
        assetId: input.assetId,
        title: input.title,
        text: chunkText,
        pageNumber: getPageNumber(section),
        sectionTitle: getSectionTitle(section),
        index,
        keywords: extractKeywords(chunkText),
        createdAt: now,
      });
    });
  });

  return chunks;
}

function scoreChunk(query: string, chunk: DocumentChunk): number {
  const terms = extractKeywords(query);
  if (terms.length === 0) return 0;

  const haystack = `${chunk.sectionTitle || ''}\n${chunk.text}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (haystack.includes(term)) score += term.length > 3 ? 3 : 1;
    if (chunk.keywords.includes(term)) score += 2;
    return score;
  }, 0);
}

export function makeDocumentId(prefix = 'doc'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function upsertDocumentAsset(asset: DocumentAsset): Promise<void> {
  await runStore(ASSETS_STORE, 'readwrite', (store) => store.put(asset));
}

export async function getDocumentAsset(id: string): Promise<DocumentAsset | null> {
  const asset = await runStore<DocumentAsset>(ASSETS_STORE, 'readonly', (store) => store.get(id));
  return asset || null;
}

export async function listDocumentAssets(): Promise<DocumentAsset[]> {
  const assets = await getAllFromStore<DocumentAsset>(ASSETS_STORE);
  return assets.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveRawFile(assetId: string, file: Blob): Promise<void> {
  await runStore(RAW_FILES_STORE, 'readwrite', (store) => store.put({ assetId, file }));
}

export async function getRawFile(assetId: string): Promise<Blob | null> {
  const record = await runStore<{ assetId: string; file: Blob }>(RAW_FILES_STORE, 'readonly', (store) => store.get(assetId));
  return record?.file || null;
}

export async function saveDocumentContent(content: DocumentContent): Promise<void> {
  await runStore(CONTENTS_STORE, 'readwrite', (store) => store.put(content));
}

export async function getDocumentContent(assetId: string): Promise<DocumentContent | null> {
  const content = await runStore<DocumentContent>(CONTENTS_STORE, 'readonly', (store) => store.get(assetId));
  return content || null;
}

export async function replaceDocumentChunks(assetId: string, chunks: DocumentChunk[]): Promise<void> {
  await runTransaction([CHUNKS_STORE], 'readwrite', (stores) => {
    const store = stores[CHUNKS_STORE];
    const request = store.index('assetId').openCursor(IDBKeyRange.only(assetId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        chunks.forEach((chunk) => store.put(chunk));
      }
    };
  });
}

export async function rebuildDocumentChunks(asset: DocumentAsset, content: DocumentContent): Promise<DocumentChunk[]> {
  const chunks = chunkDocument({
    assetId: asset.id,
    title: asset.title,
    text: content.text,
    tables: content.tables,
  });
  await replaceDocumentChunks(asset.id, chunks);
  return chunks;
}

export async function getDocumentChunks(assetId: string): Promise<DocumentChunk[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const request = tx.objectStore(CHUNKS_STORE).index('assetId').getAll(assetId);
    request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.index - b.index));
    request.onerror = () => reject(request.error || new Error('读取分块失败'));
  });
}

export async function searchDocuments(query: string, assetIds?: string[], limit = 8): Promise<DocumentSearchMatch[]> {
  const [assets, chunks] = await Promise.all([
    listDocumentAssets(),
    getAllFromStore<DocumentChunk>(CHUNKS_STORE),
  ]);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const filter = assetIds?.length ? new Set(assetIds) : null;

  return chunks
    .filter((chunk) => !filter || filter.has(chunk.assetId))
    .map((chunk) => ({ chunk, asset: assetMap.get(chunk.assetId), score: scoreChunk(query, chunk) }))
    .filter((match): match is DocumentSearchMatch => !!match.asset && match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function upsertDocumentResult<T>(result: DocumentResult<T>): Promise<void> {
  await runStore(RESULTS_STORE, 'readwrite', (store) => store.put(result));
}

export async function migrateLegacyUploadedFiles(): Promise<void> {
  if (!chrome?.storage?.local) return;
  const result = await chrome.storage.local.get('uploadedFiles');
  const uploadedFiles = Array.isArray(result.uploadedFiles) ? result.uploadedFiles : [];
  if (uploadedFiles.length === 0) return;

  const existingAssets = await listDocumentAssets();
  const existingIds = new Set(existingAssets.map((asset) => asset.id));

  for (const file of uploadedFiles) {
    if (!file?.id || existingIds.has(file.id)) continue;
    const now = file.uploadTime || Date.now();
    const parsed = file.parsed || {};
    const asset: DocumentAsset = {
      id: file.id,
      sourceType: 'file',
      title: file.name || file.id,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: now,
      updatedAt: now,
      localParseStatus: parsed.status || 'parsed',
      nativeUploadStatus: file.nativeFile?.id ? 'uploaded' : 'skipped',
      ocrStatus: parsed.warning?.includes('OCR') ? 'pending' : 'not_needed',
      nativeFileId: file.nativeFile?.id,
      error: parsed.error,
    };
    const content: DocumentContent = {
      assetId: asset.id,
      text: parsed.text || file.content || '',
      localText: parsed.text || file.content || '',
      tables: parsed.sheets?.map((sheet: any) => ({
        title: sheet.name,
        headers: sheet.headers || [],
        rows: sheet.rows || [],
        rowCount: sheet.rowCount || 0,
        columnCount: sheet.columnCount || 0,
      })),
      metadata: parsed.metadata,
      updatedAt: now,
    };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);
  }
}

function makeId(prefix = 'task'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLine(line: string): string {
  return line.replace(/^[-*•\d.、\s]+/, '').trim();
}

function inferType(text: string): RequirementTask['type'] {
  if (/页面|按钮|前端|交互|弹窗|输入框|展示|UI|列表/.test(text)) return 'frontend';
  if (/接口|服务|后端|数据库|权限|token|登录|存储|同步/.test(text)) return 'backend';
  if (/测试|验收|校验|用例|验证/.test(text)) return 'test';
  if (/设计|视觉|样式|原型/.test(text)) return 'design';
  if (/部署|运维|日志|监控|定时/.test(text)) return 'ops';
  if (/需求|规则|流程|业务/.test(text)) return 'product';
  return 'unknown';
}

function inferPriority(text: string): RequirementTask['priority'] {
  if (/必须|阻塞|核心|登录|支付|安全|P0/i.test(text)) return 'P0';
  if (/重要|应该|主要|默认|P1/i.test(text)) return 'P1';
  if (/可以|建议|优化|后续|P2/i.test(text)) return 'P2';
  return 'P2';
}

function inferModule(text: string): string {
  const match = text.match(/(登录|文件|OCR|网页|任务|导出|自动化|权限|表格|用户|订单|患者|合同|报表)/);
  return match?.[1] || '未分类';
}

function makeSourceRef(asset: DocumentAsset, chunk: DocumentChunk, line: string): SourceRef {
  return {
    documentId: asset.id,
    documentTitle: asset.title,
    chunkId: chunk.id,
    pageNumber: chunk.pageNumber,
    sectionTitle: chunk.sectionTitle,
    excerpt: line.slice(0, 180),
  };
}

export function generateRequirementTaskResult(
  assets: DocumentAsset[],
  chunks: DocumentChunk[]
): RequirementTaskResult {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const tasks: RequirementTask[] = [];
  const seen = new Set<string>();

  chunks.forEach((chunk) => {
    const asset = assetMap.get(chunk.assetId);
    if (!asset) return;

    const lines = chunk.text
      .split(/\n|。|；|;/)
      .map(normalizeLine)
      .filter((line) => line.length >= 8 && line.length <= 220);

    lines.forEach((line) => {
      if (!TASK_KEYWORDS.some((keyword) => line.includes(keyword))) return;
      const key = line.slice(0, 60);
      if (seen.has(key)) return;
      seen.add(key);

      tasks.push({
        id: makeId(),
        title: line.length > 32 ? `${line.slice(0, 32)}...` : line,
        module: inferModule(line),
        type: inferType(line),
        priority: inferPriority(line),
        description: line,
        acceptanceCriteria: [`完成并验证：${line}`],
        dependencies: [],
        risks: [],
        openQuestions: /可能|待定|确认|是否/.test(line) ? [line] : [],
        sourceRefs: [makeSourceRef(asset, chunk, line)],
      });
    });
  });

  const modules = Array.from(new Set(tasks.map((task) => task.module))).filter(Boolean);
  const documentIds = Array.from(new Set(chunks.map((chunk) => chunk.assetId)));

  return {
    documentIds,
    summary: tasks.length
      ? `共识别 ${tasks.length} 个候选任务，覆盖 ${modules.length || 1} 个模块。`
      : '未识别到明确任务，请补充更具体的需求描述或使用 AI 对话继续拆解。',
    modules,
    tasks,
    milestones: modules.map((module) => `${module} 模块完成需求澄清、开发、测试验收`),
    missingInfo: tasks.length ? ['请确认任务优先级、负责人、排期和接口约束。'] : ['缺少明确的需求动作、验收标准或业务规则。'],
    createdAt: Date.now(),
  };
}
