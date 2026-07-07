export type CopilotCommandId =
  | 'computer_use'
  | 'page_diagnosis'
  | 'document_qa'
  | 'document_status'
  | 'ocr'
  | 'page_summary'
  | 'extract_table'
  | 'task_list';

export type CopilotCommandCategory =
  | 'automation'
  | 'diagnosis'
  | 'documents'
  | 'extract'
  | 'writing';

export type CopilotCommandContext =
  | 'page'
  | 'documents'
  | 'files'
  | 'auth';

export type CopilotCommandRenderer =
  | 'computer_use_task'
  | 'diagnosis_result'
  | 'ocr_result'
  | 'document_answer'
  | 'tool_result'
  | 'text';

export interface CopilotCommand {
  id: CopilotCommandId;
  title: string;
  category: CopilotCommandCategory;
  description: string;
  inputPlaceholder?: string;
  promptTemplate?: string;
  requiredContext: CopilotCommandContext[];
  renderer: CopilotCommandRenderer;
  riskLevel: 'low' | 'medium' | 'high';
  quick?: boolean;
}

export const COPILOT_COMMANDS: CopilotCommand[] = [
  {
    id: 'computer_use',
    title: '自动操作',
    category: 'automation',
    description: '基于当前页面执行浏览器自动操作，并展示完整任务 trace。',
    inputPlaceholder: '请自动操作：',
    requiredContext: ['page', 'auth'],
    renderer: 'computer_use_task',
    riskLevel: 'medium',
    quick: true,
  },
  {
    id: 'page_diagnosis',
    title: '页面诊断',
    category: 'diagnosis',
    description: '采集页面结构、控制台错误和页面状态，让 AI 输出诊断建议。',
    requiredContext: ['page', 'auth'],
    renderer: 'diagnosis_result',
    riskLevel: 'low',
    quick: true,
  },
  {
    id: 'document_qa',
    title: '问资料',
    category: 'documents',
    description: '检索资料中心内容，并带来源回答问题。',
    inputPlaceholder: '请基于资料中心回答：',
    requiredContext: ['documents', 'auth'],
    renderer: 'document_answer',
    riskLevel: 'low',
    quick: true,
  },
  {
    id: 'document_status',
    title: '资料状态',
    category: 'documents',
    description: '查看资料中心文件、解析、OCR 与入库状态。',
    requiredContext: ['documents', 'auth'],
    renderer: 'tool_result',
    riskLevel: 'low',
    quick: true,
  },
  {
    id: 'ocr',
    title: 'OCR',
    category: 'documents',
    description: '对图片或扫描文件执行 OCR，并生成结构化资料。',
    requiredContext: ['files', 'auth'],
    renderer: 'ocr_result',
    riskLevel: 'low',
  },
  {
    id: 'page_summary',
    title: '页面总结',
    category: 'writing',
    description: '基于当前页面上下文生成摘要、关键字段和待办。',
    promptTemplate: '请总结当前页面，输出核心内容、关键字段、风险点和待办。',
    requiredContext: ['page', 'auth'],
    renderer: 'text',
    riskLevel: 'low',
  },
  {
    id: 'extract_table',
    title: '表格提取',
    category: 'extract',
    description: '提取当前页面可见表格或列表数据。',
    requiredContext: ['page', 'auth'],
    renderer: 'tool_result',
    riskLevel: 'low',
  },
  {
    id: 'task_list',
    title: '任务清单',
    category: 'writing',
    description: '把页面或资料内容整理成可执行任务清单。',
    promptTemplate: '请基于当前上下文生成任务清单，按优先级列出负责人、截止时间和风险。',
    requiredContext: ['page', 'documents', 'auth'],
    renderer: 'text',
    riskLevel: 'low',
  },
];

export function getQuickCommands(): CopilotCommand[] {
  return COPILOT_COMMANDS.filter((command) => command.quick);
}

export function getCommandById(commandId: CopilotCommandId): CopilotCommand | undefined {
  return COPILOT_COMMANDS.find((command) => command.id === commandId);
}

export function recommendCommands(input: {
  hasAttachedFiles?: boolean;
  hasDocuments?: boolean;
  pageHasErrors?: boolean;
  pageHasTables?: boolean;
}): CopilotCommand[] {
  const ids = new Set<CopilotCommandId>();
  if (input.pageHasErrors) ids.add('page_diagnosis');
  if (input.hasAttachedFiles) ids.add('ocr');
  if (input.hasDocuments) ids.add('document_qa');
  if (input.pageHasTables) ids.add('extract_table');
  ids.add('computer_use');
  ids.add('page_diagnosis');

  return Array.from(ids)
    .map((id) => getCommandById(id))
    .filter((command): command is CopilotCommand => Boolean(command));
}
