import type { AutomationRun, AutomationWorkflow } from './automationTypes';

export function createWorkflowDraftFromComputerUseRun(run: AutomationRun): { name: string; workflow: AutomationWorkflow } {
  if (run.kind !== 'computer_use') {
    throw new Error('只有 Computer Use 任务可以保存为工作流草稿');
  }
  const goal = String(run.goal || '').trim();
  if (!goal) {
    throw new Error('任务缺少目标描述');
  }
  const name = `${run.title} - 工作流草稿`;
  return {
    name,
    workflow: {
      name,
      variables: {},
      steps: [{
        type: 'computerTask',
        goal,
        maxSteps: Number(run.metadata?.maxSteps || 12),
        startUrl: typeof run.metadata?.startUrl === 'string' ? run.metadata.startUrl : undefined,
        allowHighRisk: run.metadata?.allowHighRisk === true,
      }],
    },
  };
}
