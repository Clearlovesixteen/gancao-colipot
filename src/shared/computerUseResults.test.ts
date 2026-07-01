import { describe, expect, it } from 'vitest';
import { formatComputerUseTablesMessage, getLatestExtractedTablesFromSteps } from './computerUseResults';

describe('computerUseResults', () => {
  it('extracts the latest table result from computer use steps', () => {
    const summary = getLatestExtractedTablesFromSteps([
      { action: { action: 'click' }, result: { success: true } },
      {
        action: { action: 'extract_table' },
        result: {
          tables: [{
            title: '库存预警',
            headers: ['品名', '库存'],
            rows: [['甘草', '10'], ['黄芪', '3']],
            rowCount: 2,
          }],
        },
      },
    ]);

    expect(summary).toMatchObject({
      tableCount: 1,
      rowCount: 2,
    });
  });

  it('formats extracted tables for chat display', () => {
    const summary = getLatestExtractedTablesFromSteps([{
      action: { action: 'extract_table' },
      result: {
        tables: [{
          title: '库存预警',
          headers: ['品名', '库存'],
          rows: [['甘草', '10']],
          rowCount: 1,
          columnCount: 2,
        }],
      },
    }]);

    expect(summary).toBeTruthy();
    const message = formatComputerUseTablesMessage(summary!, '库存预警页面');
    expect(message).toContain('已提取列表数据');
    expect(message).toContain('字段：品名、库存');
    expect(message).toContain('甘草 | 10');
  });
});
