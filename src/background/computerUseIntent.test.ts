import { describe, expect, it } from 'vitest';
import { inferComputerUseIntentByRule, understandComputerUseIntent } from './computerUseIntent';
import { parseComputerUseTask } from './computerUseTaskParser';

describe('computerUseIntent', () => {
  it('recognizes business list data export without fixed path slots', () => {
    const goal = '请自动操作：导出颗粒剂管理中库存预警的列表数据';
    const taskIntent = parseComputerUseTask(goal);
    const intent = inferComputerUseIntentByRule(goal, taskIntent);

    expect(intent.taskType).toBe('download');
    expect(intent.desiredOutput).toBe('download_file');
    expect(intent.entities).toEqual(expect.arrayContaining(['颗粒剂管理', '库存预警']));
    expect(intent.navigationPath).toEqual(['颗粒剂管理', '库存预警']);
    expect(intent.entities).not.toContain('自动操作：导出颗粒剂管理');
    expect(intent.entities).not.toContain('列表');
    expect(intent).not.toHaveProperty('moduleName');
    expect(intent).not.toHaveProperty('pageName');
  });

  it('recognizes obvious search tasks', () => {
    const taskIntent = parseComputerUseTask('打开百度搜索豆哥牛逼');
    const intent = inferComputerUseIntentByRule('打开百度搜索豆哥牛逼', taskIntent);

    expect(intent.taskType).toBe('search');
    expect(intent.startUrl).toBe('https://www.baidu.com/');
  });

  it('recognizes ordinary click/navigation tasks', () => {
    const intent = inferComputerUseIntentByRule('点击新增操作员');

    expect(intent.taskType).toBe('navigation');
    expect(intent.objective).toBe('点击新增操作员');
  });

  it('keeps rule-extracted business entities when LLM returns an empty entity list', async () => {
    const intent = await understandComputerUseIntent({
      goal: '导出颗粒剂管理中库存预警的列表',
      callLLM: async () => ({
        taskType: 'download',
        objective: '导出库存预警列表',
        entities: [],
        desiredOutput: 'download_file',
        riskLevel: 'high',
      }),
    });

    expect(intent.entities).toEqual(expect.arrayContaining(['颗粒剂管理', '库存预警']));
    expect(intent.navigationPath).toEqual(['颗粒剂管理', '库存预警']);
  });

  it('splits complex download and file-center goals into phase queue', () => {
    const goal = '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件';
    const intent = inferComputerUseIntentByRule(goal);

    expect(intent.navigationPath).toEqual(['饮片管理', '库存预警']);
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    expect(intent.taskPlan?.phases[3].waitMs).toBe(5000);
    expect(intent.taskPlan?.phases[2].targets).toEqual(['文件中心']);
  });
});
