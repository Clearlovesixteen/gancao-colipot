import { describe, expect, it } from 'vitest';
import type { ComputerUseRunState, ComputerUseTaskPlan } from '../../../shared/automation/automationTypes';
import { createComputerUseResumeCheckpoint } from './computerUseCheckpoint';

const taskPlan: ComputerUseTaskPlan = {
  rawGoal: '导出列表后打开文件中心',
  summary: '导航 -> 导出 -> 文件中心',
  phases: [
    { id: 'navigate', type: 'navigate_to_page', goal: '进入目标列表', navigationPath: ['业务管理', '目标列表'] },
    { id: 'download', type: 'download_file', goal: '导出列表' },
    { id: 'file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
  ],
};

function runState(): ComputerUseRunState {
  return {
    currentPhaseIndex: 2,
    completedPhases: [
      { phase: taskPlan.phases[0], success: true, summary: '已进入目标列表' },
      { phase: taskPlan.phases[1], success: true, summary: '已下载业务列表.xlsx' },
    ],
    downloadResult: {
      success: true,
      status: 'completed',
      message: '下载完成',
      downloadId: 42,
      filename: '业务列表.xlsx',
    },
    warnings: [],
  };
}

describe('createComputerUseResumeCheckpoint', () => {
  it('keeps completed phases and the download result for the unfinished phase', () => {
    const state = runState();
    const checkpoint = createComputerUseResumeCheckpoint({
      goal: taskPlan.rawGoal,
      taskPlan,
      runState: state,
      phaseIndex: 2,
      lastPageUrl: 'https://example.test/list',
      createdAt: 123,
    });

    expect(checkpoint?.phaseIndex).toBe(2);
    expect(checkpoint?.runState.completedPhases.map((item) => item.phase.id)).toEqual(['navigate', 'download']);
    expect(checkpoint?.runState.downloadResult?.filename).toBe('业务列表.xlsx');
    expect(checkpoint?.lastPageUrl).toBe('https://example.test/list');

    state.downloadResult!.filename = '被外部修改.xlsx';
    state.completedPhases.length = 0;
    expect(checkpoint?.runState.downloadResult?.filename).toBe('业务列表.xlsx');
    expect(checkpoint?.runState.completedPhases).toHaveLength(2);
  });

  it('clamps an invalid phase index to the task plan', () => {
    const checkpoint = createComputerUseResumeCheckpoint({
      goal: taskPlan.rawGoal,
      taskPlan,
      runState: runState(),
      phaseIndex: 99,
    });

    expect(checkpoint?.phaseIndex).toBe(2);
    expect(checkpoint?.runState.currentPhaseIndex).toBe(2);
  });

  it('does not create a checkpoint without a compiled plan and run state', () => {
    expect(createComputerUseResumeCheckpoint({ goal: 'test' })).toBeUndefined();
  });
});
