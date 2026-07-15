import { describe, expect, it } from 'vitest';
import type { ComputerUseRunState } from '../shared/automationTypes';
import { resolveBrowserUseVariables, resolvePlannedStepVariables, summarizeBrowserUseOutputs } from './browserUseVariables';

const runState: ComputerUseRunState = {
  currentPhaseIndex: 2,
  completedPhases: [],
  outputs: {
    extract_customers: { first: { name: '秋枫', id: 18 } },
  },
  downloadResult: {
    success: true,
    status: 'completed',
    message: '完成',
    filename: '库存预警.xlsx',
    assetId: 'asset_1',
  },
  browserSession: {
    initialTabId: 1,
    currentTabId: 2,
    startedAt: 1,
    updatedAt: 2,
    tabs: [{ tabId: 2, current: true, title: '文件中心', url: 'https://files.test' }],
  },
};

describe('browserUseVariables', () => {
  it('resolves phase, download and current tab variables', () => {
    expect(resolveBrowserUseVariables('{{extract_customers.first.name}}-{{download.filename}}', runState))
      .toBe('秋枫-库存预警.xlsx');
    expect(resolveBrowserUseVariables('{{currentTab.title}}', runState)).toBe('文件中心');
  });

  it('keeps unresolved variables visible instead of silently deleting them', () => {
    expect(resolveBrowserUseVariables('{{missing.value}}', runState)).toBe('{{missing.value}}');
  });

  it('resolves variables inside planned steps and exposes a compact planner summary', () => {
    const step = resolvePlannedStepVariables({
      id: 'open_file',
      action: 'click',
      target: { text: '{{download.filename}}' },
      rationale: '打开 {{download.filename}}',
    }, runState);
    expect(step.target?.text).toBe('库存预警.xlsx');
    expect(step.rationale).toBe('打开 库存预警.xlsx');
    expect(summarizeBrowserUseOutputs(runState)).toMatchObject({
      download: { filename: '库存预警.xlsx', assetId: 'asset_1' },
      currentTab: { id: 2, title: '文件中心' },
    });
  });
});
