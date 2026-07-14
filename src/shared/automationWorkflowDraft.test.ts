import { describe, expect, it } from 'vitest';
import { createWorkflowDraftFromComputerUseRun } from './automationWorkflowDraft';
import type { AutomationRun } from './automationTypes';

describe('automationWorkflowDraft', () => {
  it('creates a single computerTask workflow from a successful run', () => {
    const run: AutomationRun = {
      id: 'run-1',
      title: '导出库存预警',
      kind: 'computer_use',
      status: 'success',
      goal: '打开饮片管理中的库存预警列表，点击导出',
      createdAt: 1,
      updatedAt: 2,
      metadata: {
        maxSteps: 18,
        startUrl: 'https://example.com',
        allowHighRisk: false,
        workflowVariables: { warehouse: '杭州仓' },
      },
    };

    const draft = createWorkflowDraftFromComputerUseRun(run);

    expect(draft.name).toBe('导出库存预警 - 工作流草稿');
    expect(draft.workflow.steps).toEqual([{
      type: 'computerTask',
      goal: run.goal,
      maxSteps: 18,
      startUrl: 'https://example.com',
      allowHighRisk: false,
    }]);
    expect(draft.workflow.variables).toEqual({ warehouse: '杭州仓' });
  });

  it('infers empty defaults for placeholders in the goal', () => {
    const draft = createWorkflowDraftFromComputerUseRun({
      id: 'run-vars',
      title: '参数任务',
      kind: 'computer_use',
      status: 'success',
      goal: '查询 {{warehouse}} 中 {{operator}} 的记录',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(draft.workflow.variables).toEqual({ warehouse: '', operator: '' });
  });

  it('rejects non-computer-use runs', () => {
    expect(() => createWorkflowDraftFromComputerUseRun({
      id: 'run-2',
      title: '监控',
      kind: 'page_monitor',
      status: 'success',
      createdAt: 1,
      updatedAt: 2,
    })).toThrow('Computer Use');
  });
});
