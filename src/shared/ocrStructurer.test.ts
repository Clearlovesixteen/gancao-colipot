import { describe, expect, it } from 'vitest';
import { structureOcrText, structuredOcrToMarkdown } from './ocrStructurer';

describe('ocrStructurer', () => {
  it('extracts key-value fields from OCR text', () => {
    const result = structureOcrText({
      text: [
        '机构名称：甘草医生',
        '联系电话：13516099499',
        '地址：广州市天河区',
      ].join('\n'),
    });

    expect(result.documentType).toBe('form');
    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '机构名称', value: '甘草医生' }),
      expect.objectContaining({ key: '联系电话', value: '13516099499' }),
    ]));
  });

  it('extracts simple aligned tables', () => {
    const result = structureOcrText({
      text: [
        '品名  数量  金额',
        '甘草  10  120',
        '黄芪  5  80',
      ].join('\n'),
    });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      headers: ['品名', '数量', '金额'],
      rowCount: 2,
      columnCount: 3,
    });
  });

  it('keeps markdown readable for document QA context', () => {
    const result = structureOcrText({
      text: '合同编号：A-001\n甲方：测试公司',
      warnings: ['本地 OCR 置信度较低'],
    });
    const markdown = structuredOcrToMarkdown(result);

    expect(markdown).toContain('## 关键字段');
    expect(markdown).toContain('合同编号：A-001');
    expect(markdown).toContain('本地 OCR 置信度较低');
  });
});
