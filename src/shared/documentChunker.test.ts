import { describe, expect, it } from 'vitest';
import { chunkDocument, scoreChunk } from './documentChunker';

describe('documentChunker', () => {
  it('chunks markdown sections and preserves page metadata', () => {
    const chunks = chunkDocument({
      assetId: 'doc_1',
      title: '需求文档',
      text: '# 总览\n需要支持文件上传。\n\n## Page 2\n系统应该支持 OCR 识别。',
      maxChars: 120,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[1].pageNumber).toBe(2);
    expect(chunks[1].sectionTitle).toBe('Page 2');
  });

  it('converts table rows into searchable chunks', () => {
    const chunks = chunkDocument({
      assetId: 'doc_table',
      title: '表格',
      tables: [{
        title: 'Sheet1',
        headers: ['模块', '需求'],
        rows: [['文件', '支持解析 Excel']],
        rowCount: 1,
      }],
    });

    expect(chunks[0].text).toContain('Sheet1');
    expect(scoreChunk('解析 Excel', chunks[0])).toBeGreaterThan(0);
  });

  it('keeps long chunks bounded', () => {
    const chunks = chunkDocument({
      assetId: 'doc_long',
      title: '长文档',
      text: '需求内容'.repeat(1200),
      maxChars: 500,
      overlapChars: 50,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.text.length))).toBeLessThanOrEqual(500);
  });
});
