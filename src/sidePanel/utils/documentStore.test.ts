import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentAsset, DocumentContent } from '../../shared/documentTypes';
import {
  deleteDocumentAsset,
  getDocumentAsset,
  getDocumentChunks,
  getDocumentContent,
  listDocumentAssets,
  migrateLegacyUploadedFiles,
  rebuildDocumentChunks,
  saveDocumentContent,
  searchDocuments,
  upsertDocumentAsset,
} from './documentStore';

function makeAsset(id: string): DocumentAsset {
  return {
    id,
    sourceType: 'file',
    title: `${id}.md`,
    mimeType: 'text/markdown',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    localParseStatus: 'parsed',
    nativeUploadStatus: 'skipped',
    ocrStatus: 'not_needed',
  };
}

describe('documentStore', () => {
  beforeEach(async () => {
    const assets = await listDocumentAssets();
    await Promise.all(assets.map((asset) => deleteDocumentAsset(asset.id)));
  });

  it('creates assets, contents and searchable chunks', async () => {
    const asset = makeAsset('store_doc_1');
    const content: DocumentContent = {
      assetId: asset.id,
      text: '# 文件\n需要支持 PDF 解析和 OCR。',
      updatedAt: Date.now(),
    };

    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);

    expect(await getDocumentAsset(asset.id)).toMatchObject({ title: 'store_doc_1.md' });
    expect(await getDocumentContent(asset.id)).toMatchObject({ assetId: asset.id });
    expect(await getDocumentChunks(asset.id)).toHaveLength(1);
    expect((await searchDocuments('PDF OCR', [asset.id], 3))[0].asset.id).toBe(asset.id);
  });

  it('deletes associated content and chunks', async () => {
    const asset = makeAsset('store_doc_2');
    const content: DocumentContent = { assetId: asset.id, text: '需要删除关联数据。', updatedAt: Date.now() };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);

    await deleteDocumentAsset(asset.id);

    expect(await getDocumentAsset(asset.id)).toBeNull();
    expect(await getDocumentContent(asset.id)).toBeNull();
    expect(await getDocumentChunks(asset.id)).toHaveLength(0);
  });

  it('migrates legacy uploaded files', async () => {
    await chrome.storage.local.set({
      uploadedFiles: [{
        id: 'legacy_doc',
        name: '旧文件.md',
        type: 'text/markdown',
        size: 12,
        uploadTime: 1,
        content: '需要支持旧文件迁移。',
        parsed: {
          status: 'parsed',
          kind: 'text',
          text: '需要支持旧文件迁移。',
        },
      }],
    });

    await migrateLegacyUploadedFiles();

    expect(await getDocumentAsset('legacy_doc')).toMatchObject({ title: '旧文件.md' });
    expect((await searchDocuments('旧文件迁移', ['legacy_doc'], 1))).toHaveLength(1);
  });
});
