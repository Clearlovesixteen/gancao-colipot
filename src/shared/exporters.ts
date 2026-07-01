import * as XLSX from 'xlsx';
import type { DocumentTable, PageStructuredData, RequirementTaskResult } from './documentTypes';

function escapeCsvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

export function downloadTextFile(filename: string, content: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function requirementTasksToMarkdown(result: RequirementTaskResult): string {
  const lines = [
    '# 需求任务清单',
    '',
    '## 摘要',
    result.summary || '暂无摘要',
    '',
    '## 模块',
    ...(result.modules.length ? result.modules.map((item) => `- ${item}`) : ['- 未识别']),
    '',
    '## 任务',
  ];

  result.tasks.forEach((task, index) => {
    lines.push(
      '',
      `### ${index + 1}. ${task.title}`,
      '',
      `- 模块：${task.module || '未分类'}`,
      `- 类型：${task.type}`,
      `- 优先级：${task.priority}`,
      `- 描述：${task.description || ''}`,
      `- 依赖：${task.dependencies.join('；') || '无'}`,
      `- 风险：${task.risks.join('；') || '无'}`,
      `- 待确认：${task.openQuestions.join('；') || '无'}`,
      '- 验收标准：',
      ...(task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `  - ${item}`) : ['  - 未填写'])
    );
  });

  if (result.missingInfo.length) {
    lines.push('', '## 缺失信息', ...result.missingInfo.map((item) => `- ${item}`));
  }

  return lines.join('\n');
}

export function requirementTasksToRows(result: RequirementTaskResult): string[][] {
  return [
    ['模块', '任务标题', '类型', '优先级', '描述', '验收标准', '依赖', '风险', '待确认问题'],
    ...result.tasks.map((task) => [
      task.module,
      task.title,
      task.type,
      task.priority,
      task.description,
      task.acceptanceCriteria.join('\n'),
      task.dependencies.join('\n'),
      task.risks.join('\n'),
      task.openQuestions.join('\n'),
    ]),
  ];
}

export function pageStructuredDataToRows(data: PageStructuredData): string[][] {
  return [
    ['字段', '值', '置信度', '选择器'],
    ...data.fields.map((field) => [
      field.label,
      field.value,
      String(field.confidence),
      field.selector || '',
    ]),
  ];
}

export function tableToRows(table: DocumentTable): string[][] {
  return [
    table.headers,
    ...table.rows,
  ].filter((row) => row.length > 0);
}

export function downloadWorkbook(filename: string, sheets: Array<{ name: string; rows: unknown[][] }>): void {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet, index) => {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, (sheet.name || `Sheet${index + 1}`).slice(0, 31));
  });
  XLSX.writeFile(workbook, filename);
}
