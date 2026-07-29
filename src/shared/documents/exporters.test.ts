import { describe, expect, it } from 'vitest';
import { pageStructuredDataToRows, requirementTasksToMarkdown, requirementTasksToRows, tableToRows, toCsv } from './exporters';
import type { PageStructuredData, RequirementTaskResult } from './documentTypes';

describe('exporters', () => {
  it('escapes csv content and preserves Chinese text', () => {
    expect(toCsv([['字段', '值'], ['名称', '甘草,助手'], ['说明', '第一行\n第二行']]))
      .toBe('字段,值\n名称,"甘草,助手"\n说明,"第一行\n第二行"');
  });

  it('exports requirement tasks to markdown and rows', () => {
    const result: RequirementTaskResult = {
      documentIds: ['doc_1'],
      summary: '识别 1 个任务',
      modules: ['文件'],
      tasks: [{
        id: 'task_1',
        title: '支持文件解析',
        module: '文件',
        type: 'frontend',
        priority: 'P1',
        description: '用户需要上传文件并解析',
        acceptanceCriteria: ['上传后可问答'],
        dependencies: [],
        risks: ['大文件性能'],
        openQuestions: ['页数上限是多少'],
        sourceRefs: [],
      }],
      milestones: [],
      missingInfo: [],
      createdAt: 1,
    };

    expect(requirementTasksToMarkdown(result)).toContain('支持文件解析');
    expect(requirementTasksToRows(result)[1]).toContain('P1');
  });

  it('exports page fields and table rows', () => {
    const data: PageStructuredData = {
      url: 'https://example.com',
      title: '页面',
      capturedAt: 1,
      headings: [],
      fields: [{ label: '姓名', value: '张三', confidence: 0.9 }],
      tables: [],
      lists: [],
    };

    expect(pageStructuredDataToRows(data)[1]).toEqual(['姓名', '张三', '0.9', '']);
    expect(tableToRows({ headers: ['A'], rows: [['B']], rowCount: 1 })).toEqual([['A'], ['B']]);
  });
});
