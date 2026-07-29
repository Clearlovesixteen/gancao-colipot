import { describe, expect, it } from 'vitest';
import { inferComputerUseIntentByRule, understandComputerUseIntent } from './computerUseIntent';
import { parseComputerUseTask } from './computerUseTaskParser';

describe('computerUseIntent', () => {
  it('recognizes business list data export with explicit path separators', () => {
    const goal = '请自动操作：导出颗粒剂管理中的库存预警列表数据';
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
    expect(intent.query).toBe('豆哥牛逼');
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual(['open_site', 'search']);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'open_site',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
    }));
    expect(intent.taskPlan?.phases[1]).toEqual(expect.objectContaining({
      type: 'search',
      query: '豆哥牛逼',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
    }));
  });

  it('converts search result selection into executable search phases', () => {
    const taskIntent = parseComputerUseTask('打开 Google，输入甘草医生，然后点击第3个搜索结果');
    const intent = inferComputerUseIntentByRule('打开 Google，输入甘草医生，然后点击第3个搜索结果', taskIntent);

    expect(intent.taskType).toBe('search');
    expect(intent.query).toBe('甘草医生');
    expect(intent.targetResultIndex).toBe(3);
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'open_site',
      'search',
      'select_collection_item',
    ]);
    expect(intent.taskPlan?.phases[0]?.openInNewTab).not.toBe(true);
    expect(intent.taskPlan?.phases[2]).toEqual(expect.objectContaining({
      type: 'select_collection_item',
      collectionType: 'search_results',
      ordinal: 3,
      query: '甘草医生',
    }));
  });

  it('keeps deterministic search task plans when LLM misclassifies the goal as generic', async () => {
    const goal = '请自动操作：打开新页面youtube，搜索贝爷，然后点击第一个搜索结果';
    const taskIntent = parseComputerUseTask(goal);
    const intent = await understandComputerUseIntent({
      goal,
      taskIntent,
      callLLM: async () => ({
        taskType: 'generic',
        objective: goal,
        entities: ['新页面youtube'],
        riskLevel: 'low',
        taskPlan: {
          rawGoal: goal,
          summary: goal,
          phases: [
            {
              id: 'single_phase',
              type: 'generic',
              goal,
              targets: ['新页面youtube'],
            },
          ],
        },
      }),
    });

    expect(intent.taskType).toBe('search');
    expect(intent.startUrl).toBe('https://www.youtube.com/');
    expect(intent.query).toBe('贝爷');
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'open_site',
      'search',
      'select_collection_item',
    ]);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'open_site',
      openInNewTab: true,
    }));
    expect(intent.taskPlan?.phases[2]).toEqual(expect.objectContaining({
      type: 'select_collection_item',
      collectionType: 'search_results',
      ordinal: 1,
      query: '贝爷',
    }));
  });

  it('recognizes ordinary click/navigation tasks', () => {
    const intent = inferComputerUseIntentByRule('点击新增操作员');

    expect(intent.taskType).toBe('navigation');
    expect(intent.objective).toBe('点击新增操作员');
  });

  it('keeps rule-extracted business entities when LLM returns an empty entity list for explicit paths', async () => {
    const intent = await understandComputerUseIntent({
      goal: '导出颗粒剂管理中的库存预警列表',
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
    const goal = '打开饮片管理中的库存预警列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件';
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

  it('recovers common bare module-page wording without splitting center-like page names', () => {
    const goal = '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S,然后点击刚刚下载的文件';
    const intent = inferComputerUseIntentByRule(goal);

    expect(intent.navigationPath).toEqual(['饮片管理', '库存预警']);
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'navigate_to_page',
      navigationPath: ['饮片管理', '库存预警'],
    }));
  });

  it('compiles explicit URL form filtering into form phases instead of web search', () => {
    const goal = '打开饮片管理中库存预警的列表，点击导出，然后打开http://admin-file-center.dev.igancao.cn/#/export，然后子系统选择智慧药房WMS仓储，再输入用户花名：秋枫，再点击搜索，下载第一条数据';
    const taskIntent = parseComputerUseTask(goal);
    const intent = inferComputerUseIntentByRule(goal, taskIntent);

    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_site',
      'fill_form',
      'fill_form',
      'click_action',
      'download_file',
    ]);
    expect(intent.taskPlan?.phases[2]).toEqual(expect.objectContaining({
      type: 'open_site',
      startUrl: 'http://admin-file-center.dev.igancao.cn/#/export',
    }));
    expect(intent.taskPlan?.phases[3]).toEqual(expect.objectContaining({
      type: 'fill_form',
      formValues: [expect.objectContaining({ label: '子系统', value: '智慧药房WMS仓储', control: 'select' })],
    }));
    expect(intent.taskPlan?.phases[4]).toEqual(expect.objectContaining({
      type: 'fill_form',
      formValues: [expect.objectContaining({ label: '用户花名', value: '秋枫', control: 'input' })],
    }));
    expect(intent.taskPlan?.phases[5]).toEqual(expect.objectContaining({
      type: 'click_action',
      targets: ['搜索', '查询'],
    }));
    expect(intent.taskPlan?.phases[6]).toEqual(expect.objectContaining({
      type: 'download_file',
      goal: '下载第1条数据',
      ordinal: 1,
      collectionType: 'table_row_group',
    }));
  });

  it('compiles an in-page form workflow without requiring an explicit URL', () => {
    const goal = '子系统选择智慧药房WMS仓储，再输入用户花名：秋枫，再点击查询，下载第一条数据';
    const intent = inferComputerUseIntentByRule(goal);

    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'fill_form',
      'fill_form',
      'click_action',
      'download_file',
    ]);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      formValues: [expect.objectContaining({ label: '子系统', value: '智慧药房WMS仓储', control: 'select' })],
    }));
    expect(intent.taskPlan?.phases[1]).toEqual(expect.objectContaining({
      formValues: [expect.objectContaining({ label: '用户花名', value: '秋枫', control: 'input' })],
    }));
    expect(intent.taskPlan?.phases.at(-1)).toEqual(expect.objectContaining({
      ordinal: 1,
      collectionType: 'table_row_group',
    }));
  });

  it('adds fallback navigation before download when LLM omits the target page phase', async () => {
    const goal = '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S,然后点击刚刚下载的文件';
    const taskIntent = parseComputerUseTask(goal);
    const intent = await understandComputerUseIntent({
      goal,
      taskIntent,
      callLLM: async () => ({
        taskType: 'download',
        objective: '导出库存预警列表',
        entities: ['导出', '下载'],
        desiredOutput: 'download_file',
        riskLevel: 'high',
        taskPlan: {
          rawGoal: goal,
          summary: '点击真实导出/下载按钮并等待下载完成 -> 打开文件中心 -> 等待 5000ms -> 点击刚刚下载的文件',
          phases: [
            {
              id: 'download_file',
              type: 'download_file',
              goal: '点击真实导出/下载按钮并等待下载完成',
              targets: ['导出', '下载'],
            },
            {
              id: 'open_file_center',
              type: 'open_page_or_center',
              goal: '打开文件中心',
              targets: ['文件中心'],
            },
            {
              id: 'wait_after_download',
              type: 'wait',
              goal: '等待 5000ms',
              waitMs: 5000,
            },
            {
              id: 'click_latest_download',
              type: 'click_latest_download',
              goal: '点击刚刚下载的文件',
              targets: ['刚刚下载的文件'],
              usesDownloadResult: true,
            },
          ],
        },
      }),
    });

    expect(intent.navigationPath).toEqual(['饮片管理', '库存预警']);
    expect(intent.taskPlan?.phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'navigate_to_page',
      navigationPath: ['饮片管理', '库存预警'],
    }));
  });

  it('treats file center as a standalone page target instead of splitting the inner 中 character', () => {
    const intent = inferComputerUseIntentByRule('请自动操作：打开文件中心');

    expect(intent.navigationPath).toEqual([]);
    expect(intent.entities).toContain('文件中心');
    expect(intent.entities).not.toEqual(expect.arrayContaining(['文件', '心']));
    expect(intent.taskPlan?.phases).toEqual([
      expect.objectContaining({
        type: 'open_page_or_center',
        targets: ['文件中心'],
      }),
    ]);
  });

  it('does not split standalone center-like page names by the 中 character', () => {
    for (const target of ['数据中心', '帮助中心', '物流中心']) {
      const intent = inferComputerUseIntentByRule(`打开${target}`);
      expect(intent.navigationPath).toEqual([]);
      expect(intent.entities).toContain(target);
      expect(intent.entities).not.toContain('心');
      expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
        type: 'open_page_or_center',
        targets: [target],
      }));
    }
  });

  it('splits common bare X中Y module-page wording when both sides are meaningful', () => {
    const intent = inferComputerUseIntentByRule('打开饮片管理中库存预警');

    expect(intent.navigationPath).toEqual(['饮片管理', '库存预警']);
  });

  it('accepts explicit slash and angle path separators', () => {
    expect(inferComputerUseIntentByRule('打开饮片管理 > 库存预警').navigationPath).toEqual(['饮片管理', '库存预警']);
    expect(inferComputerUseIntentByRule('打开饮片管理/库存预警').navigationPath).toEqual(['饮片管理', '库存预警']);
  });

  it('does not merge a bad fallback path into a valid LLM task plan', async () => {
    const intent = await understandComputerUseIntent({
      goal: '请自动操作：打开文件中心',
      callLLM: async () => ({
        taskType: 'navigation',
        objective: '打开文件中心',
        entities: ['文件中心'],
        riskLevel: 'low',
        taskPlan: {
          rawGoal: '请自动操作：打开文件中心',
          summary: '打开文件中心',
          phases: [{
            id: 'open_file_center',
            type: 'open_page_or_center',
            goal: '打开文件中心',
            targets: ['文件中心'],
          }],
        },
      }),
    });

    expect(intent.navigationPath).toEqual([]);
    expect(intent.taskPlan?.phases).toHaveLength(1);
    expect(intent.taskPlan?.phases[0]).toEqual(expect.objectContaining({
      type: 'open_page_or_center',
      targets: ['文件中心'],
    }));
  });

  it('keeps row ordinal intent for file center download workflows', () => {
    const intent = inferComputerUseIntentByRule(
      '打开饮片管理中库存预警的列表，点击导出，然后打开http://admin-file-center.dev.igancao.cn/#/export，然后子系统选择智慧药房WMS仓储，再输入用户花名：秋枫，再点击搜索，下载第一条数据'
    );

    const phases = intent.taskPlan?.phases || [];
    expect(phases.map((phase) => phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_site',
      'fill_form',
      'fill_form',
      'click_action',
      'download_file',
    ]);
    expect(phases.at(-1)).toEqual(expect.objectContaining({
      type: 'download_file',
      goal: '下载第1条数据',
      ordinal: 1,
      collectionType: 'table_row_group',
    }));
  });
});
