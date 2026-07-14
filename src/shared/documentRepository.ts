import type {
  DocumentAsset,
  DocumentChunk,
  DocumentContent,
  DocumentResult,
  DocumentSearchMatch,
} from './documentTypes';
import { chunkDocument, scoreChunk } from './documentChunker';
export { generateRequirementTaskResult } from './requirementAnalyzer';

const DB_NAME = 'gancao_document_center';
const DB_VERSION = 1;
const ASSETS_STORE = 'assets';
const CONTENTS_STORE = 'assetContents';
const CHUNKS_STORE = 'chunks';
const RESULTS_STORE = 'results';
const RAW_FILES_STORE = 'rawFiles';

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

export async function listDocumentResults(kind?: string): Promise<DocumentResult[]> {
  const results = await getAllFromStore<DocumentResult>(RESULTS_STORE);
  return results
    .filter((result) => !kind || result.kind === kind)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDocumentAsset(assetId: string): Promise<void> {
  await runTransaction([ASSETS_STORE, CONTENTS_STORE, CHUNKS_STORE, RAW_FILES_STORE], 'readwrite', (stores) => {
    stores[ASSETS_STORE].delete(assetId);
    stores[CONTENTS_STORE].delete(assetId);
    stores[RAW_FILES_STORE].delete(assetId);
    const request = stores[CHUNKS_STORE].index('assetId').openCursor(IDBKeyRange.only(assetId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export interface DocumentRepositoryHealth {
  success: boolean;
  dbName: string;
  version: number;
  stores: string[];
  missingStores: string[];
  assetCount: number;
}

export async function checkDocumentRepositoryHealth(): Promise<DocumentRepositoryHealth> {
  const db = await openDatabase();
  const stores = Array.from(db.objectStoreNames);
  const required = [ASSETS_STORE, CONTENTS_STORE, CHUNKS_STORE, RESULTS_STORE, RAW_FILES_STORE];
  const missingStores = required.filter((store) => !stores.includes(store));
  return {
    success: db.version === DB_VERSION && missingStores.length === 0,
    dbName: db.name,
    version: db.version,
    stores,
    missingStores,
    assetCount: (await listDocumentAssets()).length,
  };
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
