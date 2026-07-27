import { beforeEach, describe, expect, it } from 'vitest';
import { collectDocumentContextHub } from './documentContextHub';
import { rebuildDocumentChunks, saveDocumentContent, upsertDocumentAsset } from './documentRepository';

describe('collectDocumentContextHub', () => {
  beforeEach(async () => {
    const asset = {
      id: 'doc_context_1', sourceType: 'file' as const, title: '库存预警.xlsx', mimeType: 'application/vnd.ms-excel', size: 100,
      createdAt: 1, updatedAt: 1, localParseStatus: 'parsed' as const, nativeUploadStatus: 'skipped' as const, ocrStatus: 'not_needed' as const,
    };
    const content = { assetId: asset.id, text: '库存预警：艾叶炭低于安全库存。', localText: '库存预警：艾叶炭低于安全库存。', updatedAt: 1 };
    await upsertDocumentAsset(asset);
    await saveDocumentContent(content);
    await rebuildDocumentChunks(asset, content);
  });

  it('returns cited chunks for matching document questions', async () => {
    const result = await collectDocumentContextHub({ question: '哪个药材库存预警？', documentIds: ['doc_context_1'] });
    expect(result.matchedBySearch).toBe(true);
    expect(result.sources[0]).toMatchObject({ documentId: 'doc_context_1', documentTitle: '库存预警.xlsx' });
    expect(result.sources[0].chunkId).toBeTruthy();
  });
});

