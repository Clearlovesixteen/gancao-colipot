import type { AutomationRun, AutomationRunStatus, AutomationTaskTemplate } from './automationTypes';
import {
  taskRepository,
  type TaskRepositoryListOptions,
  type TaskRepositoryPage,
} from '../tasks/taskRepository';

export const AUTOMATION_TASK_TEMPLATES: AutomationTaskTemplate[] = [
  {
    id: 'monitor_page_text',
    title: '页面变化监控',
    category: 'monitor',
    kind: 'page_monitor',
    description: '定期读取当前页面关键区域，对比文本、按钮状态或列表变化。',
    defaultGoal: '监控当前页面关键内容变化，有变化时提醒我',
    riskLevel: 'low',
    requiredContext: ['page', 'auth'],
    tags: ['监控', '变化'],
  },
  {
    id: 'table_export',
    title: '表格导出/下载',
    category: 'browser_use',
    kind: 'browser_use',
    description: '进入指定业务列表，点击真实导出按钮，并记录下载结果。',
    defaultGoal: '打开目标业务列表，点击导出，并等待下载完成',
    riskLevel: 'medium',
    requiredContext: ['page', 'auth'],
    tags: ['导出', '下载'],
  },
  {
    id: 'page_diagnosis',
    title: '页面诊断',
    category: 'diagnosis',
    kind: 'page_diagnosis',
    description: '采集页面结构、控制台错误、资源异常和登录/权限信号。',
    defaultGoal: '诊断当前页面的问题，并给出修复建议',
    riskLevel: 'low',
    requiredContext: ['page'],
    tags: ['诊断', '错误'],
  },
  {
    id: 'document_summary',
    title: '资料总结',
    category: 'document',
    kind: 'document_qa',
    description: '基于资料中心文档生成总结、字段、风险点和待办。',
    defaultGoal: '总结资料中心选中文档的核心内容、关键字段、风险点和待办',
    riskLevel: 'low',
    requiredContext: ['documents'],
    tags: ['资料', '总结'],
  },
  {
    id: 'file_download_check',
    title: '文件中心下载',
    category: 'browser_use',
    kind: 'browser_use',
    description: '打开文件中心，筛选文件并下载目标结果。',
    defaultGoal: '打开文件中心，按条件筛选文件，并下载第一条结果',
    riskLevel: 'medium',
    requiredContext: ['page', 'auth'],
    tags: ['文件中心', '下载'],
  },
  {
    id: 'ocr_document',
    title: 'PaddleOCR 识别',
    category: 'document',
    kind: 'ocr',
    description: '对资料中心中的图片或扫描 PDF 执行本地 OCR 并结构化入库。',
    defaultGoal: '识别所选资料的文字并写入资料中心',
    riskLevel: 'low',
    requiredContext: ['documents'],
    tags: ['OCR', '资料'],
  },
  {
    id: 'extract_page_data',
    title: '页面数据提取',
    category: 'extract',
    kind: 'extract',
    description: '提取当前页面的字段、列表或表格结构。',
    defaultGoal: '提取当前页面的结构化数据',
    riskLevel: 'low',
    requiredContext: ['page'],
    tags: ['提取', '表格'],
  },
  {
    id: 'run_workflow',
    title: '运行固定工作流',
    category: 'workflow',
    kind: 'workflow',
    description: '从已保存的自动化工作流中选择一项运行。',
    defaultGoal: '运行选定的自动化工作流',
    riskLevel: 'medium',
    requiredContext: ['auth'],
    tags: ['工作流'],
  },
];

export async function listAutomationRuns(options: TaskRepositoryListOptions = {}): Promise<AutomationRun[]> {
  return taskRepository.list(options);
}

export async function listAutomationRunsPage(options: TaskRepositoryListOptions = {}): Promise<TaskRepositoryPage> {
  return taskRepository.listPage(options);
}

export async function getAutomationRun(id: string): Promise<AutomationRun | null> {
  return taskRepository.get(id);
}

export async function upsertAutomationRun(
  input: Omit<AutomationRun, 'createdAt' | 'updatedAt'> & Partial<Pick<AutomationRun, 'createdAt' | 'updatedAt'>>,
): Promise<AutomationRun> {
  const now = Date.now();
  const existing = await taskRepository.get(input.id);
  const next: AutomationRun = {
    ...existing,
    ...input,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  return taskRepository.upsert(next);
}

export async function patchAutomationRun(
  id: string,
  patch: Partial<Omit<AutomationRun, 'id' | 'createdAt'>>,
): Promise<AutomationRun | null> {
  return taskRepository.patch(id, patch);
}

export async function deleteAutomationRun(id: string): Promise<void> {
  await taskRepository.delete(id);
}

export async function clearAutomationRuns(): Promise<void> {
  await taskRepository.clear();
}

export function makeAutomationRunFromTemplate(template: AutomationTaskTemplate): AutomationRun {
  const now = Date.now();
  return {
    id: `${now.toString(16)}-${Math.random().toString(16).slice(2)}`,
    title: template.title,
    kind: template.kind,
    status: 'draft',
    goal: template.defaultGoal,
    source: 'dashboard',
    templateId: template.id,
    tags: template.tags,
    createdAt: now,
    updatedAt: now,
    metadata: {
      category: template.category,
      riskLevel: template.riskLevel,
      requiredContext: template.requiredContext || [],
    },
  };
}

export function statusLabel(status: AutomationRunStatus): string {
  const labels: Record<AutomationRunStatus, string> = {
    draft: '草稿',
    idle: '待运行',
    scheduled: '已计划',
    pending: '准备中',
    running: '运行中',
    waiting: '等待中',
    success: '成功',
    partial: '部分成功',
    failed: '失败',
    stopped: '已停止',
  };
  return labels[status] || status;
}
