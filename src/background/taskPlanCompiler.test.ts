import { describe, expect, it } from 'vitest';
import type { ComputerUseIntent, ComputerUseTaskPlan } from '../shared/automationTypes';
import { compileComputerUseTaskPlan } from './taskPlanCompiler';

function withoutTaskPlan(intent: ComputerUseIntent): Omit<ComputerUseIntent, 'taskPlan'> {
  const { taskPlan: _taskPlan, ...rest } = intent;
  return rest;
}

const searchFallback: ComputerUseIntent = {
  rawGoal: '请自动操作：打开新页面youtube，搜索贝爷，然后点击第一个搜索结果',
  taskType: 'search',
  objective: '打开 YouTube 搜索贝爷并点击第一个结果',
  entities: ['贝爷'],
  desiredOutput: 'page_state',
  startUrl: 'https://www.youtube.com/',
  siteName: 'youtube',
  query: '贝爷',
  postSearchAction: 'click_first_result',
  targetResultIndex: 1,
  riskLevel: 'low',
  navigationPath: [],
  taskPlan: {
    rawGoal: '请自动操作：打开新页面youtube，搜索贝爷，然后点击第一个搜索结果',
    summary: '打开youtube -> 搜索 贝爷 -> 点击第1个搜索结果',
    phases: [
      { id: 'open_search_site', type: 'open_site', goal: '打开youtube', targets: ['youtube'], startUrl: 'https://www.youtube.com/', siteName: 'youtube' },
      { id: 'search_query', type: 'search', goal: '搜索 贝爷', targets: ['贝爷'], query: '贝爷', startUrl: 'https://www.youtube.com/', siteName: 'youtube' },
      { id: 'select_search_result', type: 'select_collection_item', goal: '点击第1个搜索结果', targets: ['第1个搜索结果'], query: '贝爷', ordinal: 1, collectionType: 'search_results' },
    ],
  },
};

const wmsFallback: ComputerUseIntent = {
  rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
  taskType: 'download',
  objective: '导出库存预警列表并打开刚下载文件',
  entities: ['饮片管理', '库存预警', '文件中心'],
  desiredOutput: 'download_file',
  riskLevel: 'high',
  navigationPath: ['饮片管理', '库存预警'],
  taskPlan: {
    rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
    summary: '进入 饮片管理 > 库存预警 -> 点击真实导出/下载按钮并等待下载完成 -> 打开文件中心 -> 等待 5000ms -> 点击刚刚下载的文件',
    phases: [
      { id: 'navigate_to_target_page', type: 'navigate_to_page', goal: '进入 饮片管理 > 库存预警', targets: ['饮片管理', '库存预警'], navigationPath: ['饮片管理', '库存预警'] },
      { id: 'download_file', type: 'download_file', goal: '点击真实导出/下载按钮并等待下载完成', targets: ['饮片管理', '库存预警', '导出', '下载'], navigationPath: ['饮片管理', '库存预警'] },
      { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
      { id: 'wait_after_download', type: 'wait', goal: '等待 5000ms', waitMs: 5000 },
      { id: 'click_latest_download', type: 'click_latest_download', goal: '点击刚刚下载的文件', targets: ['刚刚下载的文件'], usesDownloadResult: true },
    ],
  },
};

describe('taskPlanCompiler', () => {
  it('keeps deterministic search phases when LLM returns a generic single phase', () => {
    const llmTaskPlan: ComputerUseTaskPlan = {
      rawGoal: searchFallback.rawGoal,
      summary: searchFallback.rawGoal,
      phases: [
        { id: 'single_phase', type: 'generic', goal: searchFallback.rawGoal, targets: ['新页面youtube'] },
      ],
    };

    const compiled = compileComputerUseTaskPlan({
      goal: searchFallback.rawGoal,
      normalizedIntent: withoutTaskPlan(searchFallback),
      fallbackIntent: searchFallback,
      llmTaskPlan,
    });

    expect(compiled.intentPatch?.taskType).toBe('search');
    expect(compiled.intentPatch?.startUrl).toBe('https://www.youtube.com/');
    expect(compiled.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'open_site',
      'search',
      'select_collection_item',
    ]);
    expect(compiled.taskPlan?.repairReason).toContain('确定性搜索计划');
  });

  it('repairs download plans by inserting target navigation before download', () => {
    const llmTaskPlan: ComputerUseTaskPlan = {
      rawGoal: wmsFallback.rawGoal,
      summary: '下载后打开文件中心',
      phases: [
        { id: 'download_file', type: 'download_file', goal: '点击导出', targets: ['导出', '下载'] },
        { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
        { id: 'click_latest_download', type: 'click_latest_download', goal: '点击刚刚下载的文件', targets: ['刚刚下载的文件'], usesDownloadResult: true },
      ],
    };

    const compiled = compileComputerUseTaskPlan({
      goal: wmsFallback.rawGoal,
      normalizedIntent: withoutTaskPlan(wmsFallback),
      fallbackIntent: wmsFallback,
      llmTaskPlan,
    });

    expect(compiled.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    expect(compiled.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      source: 'repair',
      navigationPath: ['饮片管理', '库存预警'],
    }));
    expect(compiled.taskPlan?.phases[1]).toEqual(expect.objectContaining({
      navigationPath: ['饮片管理', '库存预警'],
    }));
  });

  it('does not split standalone center targets into navigation paths', () => {
    const fallback: ComputerUseIntent = {
      rawGoal: '请自动操作：打开文件中心',
      taskType: 'navigation',
      objective: '打开文件中心',
      entities: ['文件中心'],
      riskLevel: 'low',
      navigationPath: [],
      taskPlan: {
        rawGoal: '请自动操作：打开文件中心',
        summary: '打开文件中心',
        phases: [
          { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
        ],
      },
    };

    const compiled = compileComputerUseTaskPlan({
      goal: fallback.rawGoal,
      normalizedIntent: withoutTaskPlan(fallback),
      fallbackIntent: fallback,
      llmTaskPlan: fallback.taskPlan,
    });

    expect(compiled.taskPlan?.phases).toHaveLength(1);
    expect(compiled.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'open_page_or_center',
      targets: ['文件中心'],
      navigationPath: undefined,
    }));
  });
});
