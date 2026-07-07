import { describe, expect, it } from 'vitest';
import { collectPageContextHub } from './pageContextHub';

describe('collectPageContextHub', () => {
  it('collects page info, observations, signals and collection summaries', async () => {
    const toolCalls: string[] = [];
    const context = await collectPageContextHub({
      includeStructuredData: true,
      includeTables: true,
      collectConsoleErrors: async () => ({ errors: [{ source: 'console.error', message: 'boom' }] }),
      executeTool: async (toolName) => {
        toolCalls.push(toolName);
        if (toolName === 'get_current_page_info') {
          return { title: '文件中心', url: 'https://example.test/files', text: '暂无数据' };
        }
        if (toolName === 'observe_page') {
          return {
            success: true,
            title: '文件中心',
            url: 'https://example.test/files',
            viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
            scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
            elements: [],
            collections: [
              {
                id: 'files',
                type: 'file_list',
                title: '文件列表',
                items: [{ index: 1, text: '报表.xlsx', confidence: 0.8 }],
              },
            ],
            pageState: { kind: 'empty_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, hasEmptyState: true },
            capturedAt: Date.now(),
          };
        }
        if (toolName === 'extract_page_structured_data') {
          return { data: { headings: ['文件下载'], fields: [], tables: [{ title: '文件列表' }], lists: [] } };
        }
        if (toolName === 'extract_page_tables') {
          return { tables: [{ headers: ['文件名'] }] };
        }
        return {};
      },
    });

    expect(toolCalls).toEqual([
      'get_current_page_info',
      'observe_page',
      'extract_page_structured_data',
      'extract_page_tables',
    ]);
    expect(context.title).toBe('文件中心');
    expect(context.collections[0]).toMatchObject({ type: 'file_list', count: 1 });
    expect(context.signals.map((signal) => signal.type)).toEqual(['empty', 'console_error']);
    expect(context.tableCount).toBe(1);
  });
});
