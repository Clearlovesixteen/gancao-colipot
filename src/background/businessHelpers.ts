import type { RequirementTaskResult } from '../shared/documentTypes';

export const UNAUTHENTICATED_RESPONSE = {
  success: false,
  code: 'UNAUTHENTICATED',
  error: '未登录，请先登录后再使用 AI 和业务能力。',
};

export function isAuthenticatedValue(value: unknown): boolean {
  return value === true;
}

export function extractJsonObject(text: string): any | null {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function normalizeRequirementTaskResult(
  raw: any,
  fallback: RequirementTaskResult,
  documentIds: string[]
): RequirementTaskResult {
  if (!raw || typeof raw !== 'object') return fallback;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return {
    documentIds,
    summary: String(raw.summary || fallback.summary),
    modules: Array.isArray(raw.modules) ? raw.modules.map(String) : fallback.modules,
    tasks: tasks.map((task: any, index: number) => ({
      id: String(task.id || `task_${Date.now()}_${index}`),
      title: String(task.title || `任务 ${index + 1}`),
      module: String(task.module || '未分类'),
      type: ['frontend', 'backend', 'test', 'product', 'design', 'ops', 'unknown'].includes(task.type) ? task.type : 'unknown',
      priority: ['P0', 'P1', 'P2', 'P3'].includes(task.priority) ? task.priority : 'P2',
      description: String(task.description || task.title || ''),
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.map(String) : [],
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      risks: Array.isArray(task.risks) ? task.risks.map(String) : [],
      openQuestions: Array.isArray(task.openQuestions) ? task.openQuestions.map(String) : [],
      sourceRefs: Array.isArray(task.sourceRefs) ? task.sourceRefs : [],
    })),
    milestones: Array.isArray(raw.milestones) ? raw.milestones.map(String) : fallback.milestones,
    missingInfo: Array.isArray(raw.missingInfo) ? raw.missingInfo.map(String) : fallback.missingInfo,
    createdAt: Date.now(),
  };
}
