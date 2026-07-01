import { describe, expect, it } from 'vitest';
import { generateRequirementTaskResult } from './requirementAnalyzer';
import type { DocumentAsset, DocumentChunk } from './documentTypes';

describe('requirementAnalyzer', () => {
  it('generates tasks with source refs and missing info', () => {
    const asset: DocumentAsset = {
      id: 'doc_1',
      sourceType: 'file',
      title: '需求.md',
      mimeType: 'text/markdown',
      createdAt: 1,
      updatedAt: 1,
      localParseStatus: 'parsed',
      nativeUploadStatus: 'skipped',
      ocrStatus: 'not_needed',
    };
    const chunk: DocumentChunk = {
      id: 'chunk_1',
      assetId: asset.id,
      title: asset.title,
      text: '系统必须支持登录态同步。\n用户可以导出任务清单。',
      index: 0,
      keywords: ['登录态', '导出'],
      createdAt: 1,
    };

    const result = generateRequirementTaskResult([asset], [chunk]);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].sourceRefs[0].documentTitle).toBe('需求.md');
    expect(result.missingInfo.length).toBeGreaterThan(0);
  });
});
