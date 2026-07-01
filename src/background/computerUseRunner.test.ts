import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUseFinishedMessage, ComputerUseIntent, ComputerUseProgressMessage, ObservedElement } from '../shared/automationTypes';
import { ComputerUseRunner } from './computerUseRunner';

function observation(): BrowserObservation {
  return {
    success: true,
    url: 'https://example.test/warning',
    title: '库存预警',
    viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
    elements: [],
    capturedAt: Date.now(),
  };
}

const intent: ComputerUseIntent = {
  rawGoal: '读取库存预警的列表数据',
  taskType: 'data_extraction',
  objective: '读取库存预警的列表数据',
  entities: ['库存预警'],
  desiredOutput: 'table_data',
  riskLevel: 'medium',
};

const downloadIntent: ComputerUseIntent = {
  rawGoal: '导出库存预警的列表数据',
  taskType: 'download',
  objective: '导出库存预警的列表数据',
  entities: ['库存预警'],
  desiredOutput: 'download_file',
  riskLevel: 'medium',
};

function observedElement(partial: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: partial.elementId || 'el_1',
    role: partial.role || 'button',
    tag: partial.tag || 'div',
    text: partial.text || '',
    selector: partial.selector || `#${partial.elementId || 'el_1'}`,
    selectors: partial.selectors || [partial.selector || `#${partial.elementId || 'el_1'}`],
    bbox: partial.bbox || { x: 0, y: 0, width: 120, height: 32 },
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    purpose: partial.purpose || 'generic',
    score: partial.score || 0.5,
    context: partial.context,
    parentText: partial.parentText,
    active: partial.active,
    expanded: partial.expanded,
    clickable: partial.clickable ?? true,
  };
}

describe('ComputerUseRunner', () => {
  it('finishes immediately after successful extract_table and keeps table result in steps', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const tableResult = {
      tables: [{
        title: '库存预警',
        headers: ['品名', '库存'],
        rows: [['甘草', '10'], ['黄芪', '3']],
        rowCount: 2,
        columnCount: 2,
      }],
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_1',
      goal: intent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => intent,
      createPlan: async () => ({
        summary: '提取页面表格',
        confidence: 0.9,
        steps: [{
          id: 'extract_table',
          action: 'extract_table',
          rationale: '页面已有目标表格',
          verify: { type: 'table_exists' },
        }],
        successCriteria: ['提取到表格'],
      }),
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return observation();
        if (toolName === 'extract_page_tables') return tableResult;
        if (toolName === 'extract_page_structured_data') return { tables: tableResult.tables };
        if (toolName === 'get_page_info') return { text: '库存预警 列表数据' };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished).toBeTruthy();
    expect(finished?.summary).toContain('已提取到 1 个表格，共 2 行');
    expect(finished?.steps).toHaveLength(1);
    expect(finished?.steps[0].action?.action).toBe('extract_table');
    expect(finished?.steps[0].result).toEqual(tableResult);
    expect(emitted.filter((message) => message.type === 'COMPUTER_USE_PROGRESS' && message.state === 'planning')).toHaveLength(1);
  });

  it('does not mark data tasks as completed when planner returns an empty finish before any action', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_empty_finish',
      goal: intent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => intent,
      createPlan: async () => ({
        summary: 'finish',
        confidence: 0.9,
        steps: [{
          id: 'finish',
          action: 'finish',
          rationale: 'finish',
          summary: 'finish',
        }],
        successCriteria: [],
      }),
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return observation();
        if (toolName === 'extract_page_structured_data') return { tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: '库存预警 列表数据' };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED')).toBeFalsy();
    const error = emitted.find((message) => message.type === 'COMPUTER_USE_ERROR');
    expect(error?.error).toContain('自动操作没有执行');
  });

  it('finishes download tasks after a real download is captured and saved', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const downloadResult = {
      success: true,
      status: 'completed',
      filename: '库存预警.xlsx',
      assetId: 'download_1',
      savedToDocumentCenter: true,
      localParseStatus: 'parsed',
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_download',
      goal: downloadIntent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => downloadIntent,
      createPlan: async () => ({
        summary: '点击真实导出按钮',
        confidence: 0.9,
        steps: [{
          id: 'download_file',
          action: 'download_file',
          target: { elementId: 'export_1', text: '导出' },
          rationale: '点击导出按钮并等待下载',
        }],
        successCriteria: ['下载完成'],
      }),
      executeDownloadAction: async () => downloadResult,
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return observation();
        if (toolName === 'extract_page_structured_data') return { tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: '库存预警 列表数据 导出' };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.summary).toContain('已导出文件');
    expect(finished?.summary).toContain('download_1');
    expect(finished?.steps[0].action?.action).toBe('download_file');
    expect(finished?.steps[0].result).toEqual(downloadResult);
  });

  it('continues later phases after a successful download instead of finishing early', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
      objective: '导出后打开文件中心并点击刚刚下载的文件',
      navigationPath: ['饮片管理', '库存预警'],
      taskPlan: {
        rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
        summary: '导出并打开文件',
        phases: [
          { id: 'download_file', type: 'download_file', goal: '点击真实导出/下载按钮并等待下载完成', targets: ['饮片管理', '库存预警', '导出'], navigationPath: ['饮片管理', '库存预警'] },
          { id: 'wait_after_download', type: 'wait', goal: '等待 10ms', waitMs: 10 },
        ],
      },
    };
    const downloadResult = {
      success: true,
      status: 'completed',
      filename: '库存预警.xlsx',
      downloadId: 8,
      assetId: 'download_8',
      savedToDocumentCenter: true,
      localParseStatus: 'parsed',
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_phased_download',
      goal: phasedIntent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async ({ phase }) => phase?.type === 'wait'
        ? {
          summary: '等待',
          confidence: 0.95,
          steps: [{ id: 'wait', action: 'wait', value: '10', rationale: '等待文件中心刷新' }],
          successCriteria: ['等待完成'],
        }
        : {
          summary: '点击导出',
          confidence: 0.9,
          steps: [{
            id: 'download_file',
            action: 'download_file',
            target: { elementId: 'export_1', text: '导出' },
            rationale: '点击导出按钮并等待下载',
          }],
          successCriteria: ['下载完成'],
        },
      executeDownloadAction: async () => downloadResult,
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return observation();
        if (toolName === 'extract_page_structured_data') return { tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: '库存预警 列表数据 导出' };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finishedEvents = emitted.filter((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage[];
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].runState?.completedPhases.map((item) => item.phase.type)).toEqual(['download_file', 'wait']);
    expect(finishedEvents[0].summary).toContain('库存预警.xlsx');
    const doneBeforeWait = emitted.findIndex((message) => message.type === 'COMPUTER_USE_PROGRESS' && message.phaseType === 'wait' && message.state === 'acting');
    const finishedIndex = emitted.findIndex((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(doneBeforeWait).toBeGreaterThan(-1);
    expect(finishedIndex).toBeGreaterThan(doneBeforeWait);
  });

  it('does not complete navigate phase when only the parent menu was clicked', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开饮片管理中库存预警的列表，点击导出',
      objective: '打开饮片管理中库存预警的列表，点击导出',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
      taskPlan: {
        rawGoal: '打开饮片管理中库存预警的列表，点击导出',
        summary: '进入目标列表并导出',
        phases: [
          { id: 'navigate', type: 'navigate_to_page', goal: '进入 饮片管理 > 库存预警', targets: ['饮片管理', '库存预警'], navigationPath: ['饮片管理', '库存预警'] },
          { id: 'download', type: 'download_file', goal: '点击真实导出/下载按钮并等待下载完成', targets: ['饮片管理', '库存预警', '导出'], navigationPath: ['饮片管理', '库存预警'] },
        ],
      },
    };
    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_parent_only',
      goal: phasedIntent.rawGoal,
      maxSteps: 1,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async () => ({
        summary: '点击父菜单',
        confidence: 0.9,
        steps: [{
          id: 'click_parent',
          action: 'click',
          target: { elementId: 'drink_parent', text: '饮片管理' },
          rationale: '按业务菜单路径进入目标页面：饮片管理 > 库存预警',
          verify: { type: 'page_changed', value: '饮片管理' },
        }],
        successCriteria: ['展开饮片管理'],
      }),
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return {
          ...observation(),
          url: 'https://example.test/#/welcome',
          title: '智慧药房WMS',
          elements: [{ elementId: 'drink_parent', text: '饮片管理', active: true, visible: true, enabled: true }],
        };
        if (toolName === 'extract_page_structured_data') return { tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: '饮片管理 库存预警' };
        if (toolName === 'click_element') return { success: true };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(emitted.some((message) => message.type === 'COMPUTER_USE_PROGRESS' && message.phaseType === 'download_file')).toBe(false);
    const error = emitted.find((message) => message.type === 'COMPUTER_USE_ERROR');
    expect(error?.phaseType).toBe('navigate_to_page');
  });

  it('emits error instead of finished when max steps are reached without completion', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_max_steps',
      goal: intent.rawGoal,
      maxSteps: 1,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => ({ ...intent, taskType: 'generic', desiredOutput: undefined }),
      createPlan: async () => ({
        summary: '等待页面变化',
        confidence: 0.9,
        steps: [{ id: 'wait', action: 'wait', rationale: '等待页面变化', value: '10' }],
        successCriteria: [],
      }),
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return observation();
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED')).toBeFalsy();
    expect(emitted.find((message) => message.type === 'COMPUTER_USE_ERROR')?.error).toContain('最大步数');
  });

  it('does not retry the same failed candidate within a phase', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let page: 'welcome' | 'target' = 'welcome';
    const actions: string[] = [];
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开饮片管理中库存预警的列表',
      objective: '打开饮片管理中库存预警的列表',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
      taskPlan: {
        rawGoal: '打开饮片管理中库存预警的列表',
        summary: '进入目标列表',
        phases: [
          { id: 'navigate', type: 'navigate_to_page', goal: '进入 饮片管理 > 库存预警', targets: ['饮片管理', '库存预警'], navigationPath: ['饮片管理', '库存预警'] },
        ],
      },
    };

    const buildObservation = (): BrowserObservation => ({
      success: true,
      url: page === 'target' ? 'https://wms.test/#/drink-warning' : 'https://wms.test/#/welcome',
      title: page === 'target' ? '库存预警' : '智慧药房WMS',
      viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
      capturedAt: Date.now(),
      elements: [
        observedElement({
          elementId: 'bad_warning',
          text: '库存预警',
          purpose: 'menu_item',
          context: 'sidebar | 饮片管理 库存预警 wrapper',
          parentText: '饮片管理',
          score: 0.99,
        }),
        observedElement({
          elementId: 'good_warning',
          text: '库存预警',
          purpose: 'menu_item',
          context: 'sidebar | 饮片管理 库存预警',
          parentText: '饮片管理',
          active: page === 'target',
          score: 0.5,
        }),
      ],
    });

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_failed_candidate_memory',
      goal: phasedIntent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return buildObservation();
        if (toolName === 'click_element') {
          actions.push(args.elementId);
          if (args.elementId === 'good_warning') page = 'target';
          return { success: true };
        }
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(actions).toEqual(['bad_warning', 'good_warning']);
    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.runState?.completedPhases.map((item) => item.phase.type)).toEqual(['navigate_to_page']);
  });

  it('does not finish open_page_or_center without visible target evidence', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开文件中心',
      objective: '打开文件中心',
      taskPlan: {
        rawGoal: '打开文件中心',
        summary: '打开文件中心',
        phases: [
          { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
        ],
      },
    };
    const staleObservation = {
      ...observation(),
      url: 'https://wms.test/#/welcome',
      title: '智慧药房WMS',
      elements: [observedElement({ elementId: 'file_center', text: '文件中心', purpose: 'navigation_item' })],
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_open_without_evidence',
      goal: phasedIntent.rawGoal,
      maxSteps: 2,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async () => ({
        summary: '打开文件中心',
        confidence: 0.9,
        steps: [{
          id: 'open_page_or_center',
          action: 'click',
          target: { elementId: 'file_center', text: '文件中心' },
          rationale: '点击文件中心入口',
          verify: { type: 'page_changed', value: '文件中心' },
        }],
        successCriteria: ['进入文件中心'],
      }),
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return staleObservation;
        if (toolName === 'click_element') return { success: true };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED')).toBeFalsy();
    const error = emitted.find((message) => message.type === 'COMPUTER_USE_ERROR');
    expect(error?.phaseType).toBe('open_page_or_center');
  });

  it('runs a WMS-like multi-phase export flow without hard-coded menu paths', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let page: 'welcome' | 'drink_warning' | 'file_center' | 'file_detail' = 'welcome';
    let drinkExpanded = false;
    const filename = '库存预警_20260701.xlsx';
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
      objective: '打开饮片管理中的库存预警列表，点击导出，然后在文件中心打开刚刚下载的文件。',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
      taskPlan: {
        rawGoal: '打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S，然后点击刚刚下载的文件',
        summary: '进入饮片库存预警 -> 导出 -> 文件中心 -> 打开刚下载文件',
        phases: [
          { id: 'navigate', type: 'navigate_to_page', goal: '进入 饮片管理 > 库存预警', targets: ['饮片管理', '库存预警'], navigationPath: ['饮片管理', '库存预警'] },
          { id: 'download', type: 'download_file', goal: '点击真实导出/下载按钮并等待下载完成', targets: ['饮片管理', '库存预警', '导出'], navigationPath: ['饮片管理', '库存预警'] },
          { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
          { id: 'wait', type: 'wait', goal: '等待 10ms', waitMs: 10 },
          { id: 'click_latest_download', type: 'click_latest_download', goal: '点击刚刚下载的文件', targets: ['刚刚下载的文件'], usesDownloadResult: true },
        ],
      },
    };

    const buildObservation = (): BrowserObservation => {
      const elements: ObservedElement[] = [
        observedElement({ elementId: 'file_center', text: '文件中心', role: 'link', purpose: 'navigation_item', context: 'top_nav' }),
        observedElement({ elementId: 'granule_parent', text: '颗粒剂管理', purpose: 'menu_item', context: 'sidebar | 颗粒剂管理' }),
        observedElement({ elementId: 'granule_warning', text: '库存预警', purpose: 'menu_item', context: 'sidebar | 颗粒剂管理 库存列表 库存预警', parentText: '颗粒剂管理 库存列表 库存预警', active: false }),
        observedElement({ elementId: 'drink_parent', text: '饮片管理', purpose: 'menu_item', context: 'sidebar | 饮片管理', expanded: drinkExpanded, active: drinkExpanded }),
      ];
      if (drinkExpanded || page === 'drink_warning') {
        elements.push(observedElement({
          elementId: 'drink_warning',
          text: '库存预警',
          purpose: 'menu_item',
          context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
          parentText: '饮片管理 待入库列表 库存列表 库存预警 库存结存',
          active: page === 'drink_warning',
        }));
      }
      if (page === 'drink_warning') {
        elements.push(observedElement({ elementId: 'export_drink_warning', text: '导 出', role: 'button', purpose: 'download_button', context: 'toolbar | 库存预警', score: 0.95 }));
      }
      if (page === 'file_center') {
        elements.push(observedElement({ elementId: 'downloaded_file', text: filename, role: 'link', purpose: 'generic', context: '文件中心 | 最近文件' }));
      }
      return {
        success: true,
        url: page === 'welcome'
          ? 'https://wms.test/#/welcome'
          : page === 'drink_warning'
            ? 'https://wms.test/#/management-k/inventory-warning'
            : page === 'file_center'
              ? 'https://wms.test/#/file-center'
              : 'https://wms.test/#/file-center/detail',
        title: page === 'file_center' ? '文件中心' : page === 'file_detail' ? filename : '智慧药房WMS',
        viewport: { width: 1400, height: 900, devicePixelRatio: 1 },
        scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
        elements,
        pageState: { kind: page === 'drink_warning' ? 'table_page' : 'unknown', hasModal: false, hasCaptcha: false, hasLoginSignal: false },
        capturedAt: Date.now(),
      };
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_wms_multi_phase',
      goal: phasedIntent.rawGoal,
      maxSteps: 12,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      executeDownloadAction: async () => ({
        success: true,
        status: 'completed',
        filename,
        downloadId: 18,
        assetId: 'asset_18',
        savedToDocumentCenter: true,
        localParseStatus: 'parsed',
        message: '下载完成并入库',
      }),
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return buildObservation();
        if (toolName === 'extract_page_structured_data') {
          return page === 'drink_warning'
            ? { headings: ['库存预警'], tables: [{ headers: ['所属仓', '药材名称'], rows: [['test仓1', '艾叶']] }] }
            : page === 'file_center'
              ? { headings: ['文件中心'], tables: [] }
              : { headings: [], tables: [] };
        }
        if (toolName === 'extract_page_tables') {
          return page === 'drink_warning'
            ? { tables: [{ headers: ['所属仓', '药材名称'], rows: [['test仓1', '艾叶']] }] }
            : { tables: [] };
        }
        if (toolName === 'get_page_info') {
          return { text: buildObservation().elements.map((element) => `${element.text} ${element.context || ''}`).join(' ') };
        }
        if (toolName === 'click_element') {
          if (args.elementId === 'drink_parent') drinkExpanded = true;
          if (args.elementId === 'drink_warning') page = 'drink_warning';
          if (args.elementId === 'file_center') page = 'file_center';
          if (args.elementId === 'downloaded_file') page = 'file_detail';
          return { success: true };
        }
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.summary).toContain(filename);
    expect(finished?.runState?.completedPhases.map((item) => item.phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    const actions = emitted
      .filter((message) => message.type === 'COMPUTER_USE_PROGRESS' && message.state === 'acting')
      .map((message) => message.action?.elementId || message.action?.action);
    expect(actions).toEqual([
      'drink_parent',
      'drink_warning',
      'export_drink_warning',
      'file_center',
      'wait',
      'downloaded_file',
    ]);
    expect(page).toBe('file_detail');
  });
});
