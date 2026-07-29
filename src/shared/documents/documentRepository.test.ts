import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentAsset, DocumentContent } from './documentTypes';
import {
  deleteDocumentAsset,
  getDocumentAsset,
  getDocumentChunks,
  getDocumentContent,
  listDocumentAssets,
  rebuildDocumentChunks,
  saveDocumentContent,
  searchDocuments,
  upsertDocumentAsset,
} from './documentRepository';

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

describe('documentRepository', () => {
  beforeEach(async () => {
    const assets = await listDocumentAssets();
    await Promise.all(assets.map((asset) => deleteDocumentAsset(asset.id)));
  });

  it('creates assets, contents and searchable chunks', async () => {
    const asset = makeAsset('repository_doc_1');
    const content: DocumentContent = {
      assetId: asset.id,
      text: '# 文件\n需要支持 PDF 解析和 OCR。',
      updatedAt: Date.now(),
    };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);

    expect(await getDocumentAsset(asset.id)).toMatchObject({ title: 'repository_doc_1.md' });
    expect(await getDocumentContent(asset.id)).toMatchObject({ assetId: asset.id });
    expect(await getDocumentChunks(asset.id)).toHaveLength(1);
    expect((await searchDocuments('PDF OCR', [asset.id], 3))[0].asset.id).toBe(asset.id);
  });

  it('deletes associated content and chunks', async () => {
    const asset = makeAsset('repository_doc_2');
    const content: DocumentContent = { assetId: asset.id, text: '需要删除关联数据。', updatedAt: Date.now() };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);
    await deleteDocumentAsset(asset.id);

    expect(await getDocumentAsset(asset.id)).toBeNull();
    expect(await getDocumentContent(asset.id)).toBeNull();
    expect(await getDocumentChunks(asset.id)).toHaveLength(0);
  });
});
