import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUseFinishedMessage, ComputerUseIntent, ComputerUseProgressMessage, ObservedElement } from '../shared/automationTypes';
import { BrowserUseSession, type BrowserUseTabInfo } from './browserUseSession';
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
    expect(finished?.runState?.completedPhases).toHaveLength(1);
    expect(finished?.runState?.outputs).toEqual({ single_phase: tableResult });
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
    const exportButton = observedElement({ elementId: 'export_1', text: '导出', purpose: 'download_button' });
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
        if (toolName === 'observe_page') return { ...observation(), elements: [exportButton] };
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

  it('blocks download phase before target page evidence when no export button is visible', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let createPlanCalls = 0;
    const phasedIntent: ComputerUseIntent = {
      ...downloadIntent,
      rawGoal: '打开饮片管理中库存预警的列表，点击导出',
      objective: '进入库存预警后导出',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
      taskPlan: {
        rawGoal: '打开饮片管理中库存预警的列表，点击导出',
        summary: '点击导出',
        phases: [
          {
            id: 'download_file',
            type: 'download_file',
            goal: '点击真实导出/下载按钮并等待下载完成',
            targets: ['饮片管理', '库存预警', '导出'],
            navigationPath: ['饮片管理', '库存预警'],
          },
        ],
      },
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_download_precondition',
      goal: phasedIntent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async () => {
        createPlanCalls += 1;
        return {
          summary: '不应进入规划器',
          confidence: 0.1,
          steps: [{ id: 'finish', action: 'finish', rationale: 'unexpected' }],
          successCriteria: [],
        };
      },
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return {
          ...observation(),
          url: 'https://wms.test/#/basic-settings/data-permission',
          title: '智慧药房WMS',
          elements: [
            observedElement({ elementId: 'operator', text: '数据权限管理', purpose: 'menu_item', active: true }),
          ],
        };
        if (toolName === 'extract_page_structured_data') return { headings: [], tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: '数据权限管理 新增操作员 查询' };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(createPlanCalls).toBe(0);
    const error = emitted.find((message) => message.type === 'COMPUTER_USE_ERROR');
    expect(error?.phaseType).toBe('download_file');
    expect(error?.error).toContain('前置条件不满足');
    expect(error?.error).toContain('饮片管理 > 库存预警');
  });

  it('continues later phases after a successful download instead of finishing early', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    const exportButton = observedElement({ elementId: 'export_1', text: '导出', purpose: 'download_button' });
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
        if (toolName === 'observe_page') return { ...observation(), elements: [exportButton] };
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

  it('runs search goals through the unified phase runner and clicks the requested result ordinal', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let page: 'blank' | 'home' | 'results' | 'target' = 'blank';
    let typedQuery = '';
    let clickedResultIndex: number | undefined;
    let clickedElementId: string | undefined;
    let createPlanCalls = 0;

    const searchIntent: ComputerUseIntent = {
      rawGoal: '打开百度，输入甘草医生，然后点击第3个搜索结果',
      taskType: 'search',
      objective: '打开百度，搜索甘草医生并点击第3个结果',
      entities: ['甘草医生'],
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: '甘草医生',
      postSearchAction: 'click_first_result',
      targetResultIndex: 3,
      riskLevel: 'low',
      taskPlan: {
        rawGoal: '打开百度，输入甘草医生，然后点击第3个搜索结果',
        summary: '打开百度 -> 搜索甘草医生 -> 点击第3个搜索结果',
        phases: [
          { id: 'open_search_site', type: 'open_site', goal: '打开百度', targets: ['百度'], startUrl: 'https://www.baidu.com/', siteName: 'baidu' },
          { id: 'search_query', type: 'search', goal: '搜索 甘草医生', targets: ['甘草医生'], query: '甘草医生', startUrl: 'https://www.baidu.com/', siteName: 'baidu' },
          { id: 'select_search_result', type: 'select_collection_item', goal: '点击第3个搜索结果', targets: ['第3个搜索结果'], query: '甘草医生', ordinal: 3, collectionType: 'search_results' },
        ],
      },
    };

    const buildObservation = (): BrowserObservation => {
      if (page === 'target') {
        return {
          ...observation(),
          url: 'https://www.gancao.com/',
          title: '甘草医生官网',
          elements: [],
        };
      }
      if (page === 'results') {
        return {
          ...observation(),
          // Some search sites render results asynchronously before updating URL/title.
          // The semantic search_results collection is the reliable completion evidence.
          url: 'https://www.baidu.com/',
          title: '百度一下，你就知道',
          pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: true },
          elements: [],
        };
      }
      return {
        ...observation(),
        url: 'https://www.baidu.com/',
        title: '百度一下，你就知道',
        pageState: {
          kind: 'search_page',
          mainInputId: 'kw',
          searchInputId: 'kw',
          primaryButtonId: 'su',
          searchButtonId: 'su',
          hasModal: false,
          hasCaptcha: false,
          hasLoginSignal: false,
        },
        elements: [
          observedElement({ elementId: 'kw', role: 'textbox', tag: 'input', text: typedQuery, selector: '#kw', purpose: 'search_input', value: typedQuery }),
          observedElement({ elementId: 'su', role: 'button', tag: 'button', text: '百度一下', selector: '#su', purpose: 'search_button' }),
        ],
      };
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_search_phases',
      goal: searchIntent.rawGoal,
      maxSteps: 8,
      signal: new AbortController().signal,
      navigate: async (_tabId, url) => {
        page = url.includes('/s?') ? 'results' : 'home';
      },
      understandIntent: async () => searchIntent,
      createPlan: async () => {
        createPlanCalls += 1;
        return {
          summary: '不应进入通用规划器',
          confidence: 0.1,
          steps: [{ id: 'finish', action: 'finish', rationale: 'unexpected' }],
          successCriteria: [],
        };
      },
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return buildObservation();
        if (toolName === 'type_text') {
          typedQuery = args.text || args.value || '';
          return { success: true };
        }
        if (toolName === 'click_element') {
          if (args.elementId === 'su') page = 'results';
          if (args.elementId === 'result_3') {
            clickedElementId = args.elementId;
            clickedResultIndex = 3;
            page = 'target';
          }
          return { success: true };
        }
        if (toolName === 'get_search_results') {
          return page === 'results'
            ? {
              success: true,
              count: 3,
              results: [
                { index: 1, title: '第一条', href: 'https://one.test/', elementId: 'result_1', selector: '#r1' },
                { index: 2, title: '第二条', href: 'https://two.test/', elementId: 'result_2', selector: '#r2' },
                { index: 3, title: '甘草医生官网', href: 'https://www.gancao.com/', elementId: 'result_3', selector: '#r3' },
              ],
            }
            : { success: true, count: 0, results: [] };
        }
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    expect(createPlanCalls).toBe(0);
    expect(typedQuery).toBe('甘草医生');
    expect(clickedResultIndex).toBe(3);
    expect(clickedElementId).toBe('result_3');
    expect(page).toBe('target');
    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.runState?.completedPhases.map((item) => item.phase.type)).toEqual([
      'open_site',
      'search',
      'select_collection_item',
    ]);
    expect(emitted.find((message) => message.type === 'COMPUTER_USE_ERROR')).toBeFalsy();
  });

  it('completes navigation when the correct leaf click changes the business route without active evidence', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let page: 'before' | 'target' = 'before';
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
      url: page === 'target'
        ? 'https://wms.test/#/management-y/inventory-warning'
        : 'https://wms.test/#/basic-settings/data-permission',
      title: '智慧药房WMS',
      viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
      capturedAt: Date.now(),
      elements: [
        observedElement({
          elementId: 'drink_warning',
          text: '库存预警',
          purpose: 'menu_item',
          context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
          parentText: '饮片管理 待入库列表 库存列表 库存预警 库存结存',
          active: false,
        }),
      ],
    });

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_route_change_navigation',
      goal: phasedIntent.rawGoal,
      maxSteps: 3,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async () => ({
        summary: '点击子菜单',
        confidence: 0.9,
        steps: [{
          id: 'click_leaf',
          action: 'click',
          target: {
            elementId: 'drink_warning',
            text: '库存预警',
            parentPath: ['饮片管理'],
          },
          rationale: '点击饮片管理下的库存预警',
          verify: { type: 'page_changed', value: '库存预警' },
        }],
        successCriteria: ['进入库存预警列表'],
      }),
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return buildObservation();
        if (toolName === 'extract_page_structured_data') return { headings: [], tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: buildObservation().elements.map((element) => element.context || element.text).join(' ') };
        if (toolName === 'click_element') {
          if (args.elementId === 'drink_warning') page = 'target';
          return { success: true };
        }
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.runState?.completedPhases.map((item) => item.phase.type)).toEqual(['navigate_to_page']);
    expect(emitted.find((message) => message.type === 'COMPUTER_USE_ERROR')).toBeFalsy();
  });

  it('allows download after completed navigation evidence and waits for delayed export button', async () => {
    const emitted: Array<ComputerUseProgressMessage | ComputerUseFinishedMessage | any> = [];
    let page: 'before' | 'target' = 'before';
    let targetObserveCount = 0;
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
    const buildObservation = (): BrowserObservation => {
      const isTarget = page === 'target';
      if (isTarget) targetObserveCount += 1;
      const exportVisible = isTarget && targetObserveCount >= 3;
      return {
        success: true,
        url: isTarget
          ? 'https://wms.test/#/management-y/inventory-warning'
          : 'https://wms.test/#/basic-settings/data-permission',
        title: '智慧药房WMS',
        viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
        scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
        capturedAt: Date.now(),
        elements: [
          observedElement({
            elementId: 'drink_parent',
            text: '饮片管理',
            purpose: 'menu_item',
            context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
            active: isTarget,
            expanded: isTarget,
          }),
          observedElement({
            elementId: 'drink_warning',
            text: '库存预警',
            purpose: 'menu_item',
            context: 'sidebar | 库存预警',
            parentText: isTarget ? undefined : '饮片管理',
            active: isTarget,
          }),
          ...(exportVisible
            ? [observedElement({
              elementId: 'export_button',
              text: '导 出',
              role: 'button',
              purpose: 'download_button',
              context: 'toolbar | 库存预警',
              score: 0.95,
            })]
            : []),
        ],
      };
    };

    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_download_after_navigation_evidence',
      goal: phasedIntent.rawGoal,
      maxSteps: 5,
      signal: new AbortController().signal,
      navigate: async () => {},
      understandIntent: async () => phasedIntent,
      createPlan: async ({ phase, context }) => {
        if (phase?.type === 'navigate_to_page') {
          return {
            summary: '点击子菜单',
            confidence: 0.9,
            steps: [{
              id: 'click_leaf',
              action: 'click',
              target: { elementId: 'drink_warning', text: '库存预警', parentPath: ['饮片管理'] },
              rationale: '点击饮片管理下的库存预警',
              verify: { type: 'page_changed', value: '库存预警' },
            }],
            successCriteria: ['进入库存预警列表'],
          };
        }
        expect(context.actionCandidates.some((element) => element.elementId === 'export_button')).toBe(true);
        return {
          summary: '点击导出',
          confidence: 0.9,
          steps: [{
            id: 'download',
            action: 'download_file',
            target: { elementId: 'export_button', text: '导 出', purpose: 'download_button', collectionType: 'action_group' },
            rationale: '点击真实导出按钮',
            verify: { type: 'element_exists', value: '导 出' },
          }],
          successCriteria: ['捕获下载'],
        };
      },
      executeDownloadAction: async () => ({
        success: true,
        status: 'completed',
        filename: '库存预警.xlsx',
        downloadId: 88,
        savedToDocumentCenter: true,
        assetId: 'asset_88',
        message: '下载完成',
      }),
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return buildObservation();
        if (toolName === 'extract_page_structured_data') return { headings: isFinite(targetObserveCount) ? ['库存预警'] : [], tables: [] };
        if (toolName === 'extract_page_tables') return { tables: [] };
        if (toolName === 'get_page_info') return { text: buildObservation().elements.map((element) => `${element.text} ${element.context || ''}`).join(' ') };
        if (toolName === 'click_element') {
          if (args.elementId === 'drink_warning') page = 'target';
          return { success: true };
        }
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED') as ComputerUseFinishedMessage | undefined;
    expect(finished?.summary).toContain('库存预警.xlsx');
    expect(finished?.runState?.completedPhases.map((item) => item.phase.type)).toEqual(['navigate_to_page', 'download_file']);
    expect(finished?.runState?.completedPhases[0].evidence?.matchedNavigationPath).toEqual(['饮片管理', '库存预警']);
    expect(emitted.find((message) => message.type === 'COMPUTER_USE_ERROR')).toBeFalsy();
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
        elements.push(observedElement({ elementId: 'downloaded_file', text: '下载', role: 'link', purpose: 'generic', context: `文件中心 | 最近文件 | ${filename}`, href: `https://storage.test/${filename}` }));
      }
      if (page === 'file_detail') {
        elements.push(observedElement({ elementId: 'file_detail_title', text: filename, role: 'heading', purpose: 'generic', context: '文件详情', active: true }));
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
        title: '智慧药房WMS',
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
    expect(finished?.summary).toContain('已打开刚下载文件');
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

  it('resumes from the failed phase without replaying completed phases or the initial start URL', async () => {
    const navigated: string[] = [];
    const emitted: any[] = [];
    const resumeIntent: ComputerUseIntent = {
      rawGoal: '先等待，再打开结果页',
      taskType: 'navigation',
      objective: '打开结果页',
      entities: ['结果页'],
      riskLevel: 'low',
      taskPlan: {
        rawGoal: '先等待，再打开结果页',
        summary: '等待 -> 打开结果页',
        phases: [
          { id: 'done_wait', type: 'wait', goal: '等待', waitMs: 1 },
          { id: 'open_result', type: 'open_site', goal: '打开结果页', startUrl: 'https://result.test/' },
        ],
      },
    };
    const runner = new ComputerUseRunner({
      tabId: 1,
      runId: 'run_resume',
      goal: resumeIntent.rawGoal,
      maxSteps: 3,
      startUrl: 'https://initial.test/',
      signal: new AbortController().signal,
      navigate: async (_tabId, url) => { navigated.push(url); },
      understandIntent: async () => resumeIntent,
      executeBrowserTool: async (_tabId, toolName) => {
        if (toolName === 'observe_page') return { ...observation(), url: 'https://result.test/', title: '结果页' };
        if (toolName === 'get_page_info') return { text: '结果页' };
        if (toolName === 'extract_page_structured_data') return { headings: ['结果页'], tables: [] };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
      resumeCheckpoint: {
        goal: resumeIntent.rawGoal,
        taskPlan: resumeIntent.taskPlan!,
        phaseIndex: 1,
        runState: {
          currentPhaseIndex: 1,
          completedPhases: [{ phase: resumeIntent.taskPlan!.phases[0], success: true, summary: '等待完成' }],
          warnings: [],
        },
        createdAt: Date.now(),
      },
    });

    await runner.run();

    expect(navigated).toEqual(['https://result.test/']);
    expect(emitted.some((message) => message.result?.summary?.includes('正在从失败阶段继续'))).toBe(true);
    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(finished?.runState?.completedPhases).toHaveLength(2);
  });

  it('opens, takes control of and observes an explicitly requested new tab', async () => {
    const emitted: any[] = [];
    let tabs: BrowserUseTabInfo[] = [{
      id: 1,
      active: true,
      url: 'https://work.test/',
      title: '工作台',
    }];
    const session = new BrowserUseSession({
      initialTabId: 1,
      listTabs: async () => tabs,
    });
    await session.initialize();
    const openIntent: ComputerUseIntent = {
      rawGoal: '打开新页面 https://target.test/',
      taskType: 'navigation',
      objective: '在新标签页打开目标页面',
      entities: ['目标页面'],
      riskLevel: 'low',
      startUrl: 'https://target.test/',
      taskPlan: {
        rawGoal: '打开新页面 https://target.test/',
        summary: '在新标签页打开目标页面',
        phases: [{
          id: 'open_target',
          type: 'open_site',
          goal: '打开目标页面',
          startUrl: 'https://target.test/',
          openInNewTab: true,
        }],
      },
    };
    const observedTabIds: number[] = [];
    const runner = new ComputerUseRunner({
      tabId: 1,
      tabSession: session,
      runId: 'run_open_new_tab',
      goal: openIntent.rawGoal,
      maxSteps: 3,
      signal: new AbortController().signal,
      navigate: async () => { throw new Error('显式新标签页不应复用当前标签导航'); },
      understandIntent: async () => openIntent,
      executeBrowserTool: async (tabId, toolName) => {
        observedTabIds.push(tabId);
        if (toolName === 'observe_page') return {
          ...observation(),
          url: 'https://target.test/',
          title: '目标页面',
        };
        if (toolName === 'get_page_info') return { text: '目标页面' };
        if (toolName === 'extract_page_structured_data') return { headings: ['目标页面'], tables: [] };
        throw new Error(`unexpected tool: ${toolName}`);
      },
      tabActionDeps: {
        createTab: async ({ url, openerTabId }) => {
          const tab = { id: 2, active: true, url, title: '目标页面', openerTabId };
          tabs = tabs.map((item) => ({ ...item, active: false })).concat(tab);
          return tab;
        },
        activateTab: async (tabId) => { tabs = tabs.map((item) => ({ ...item, active: item.id === tabId })); },
        closeTab: async (tabId) => { tabs = tabs.filter((item) => item.id !== tabId); },
        goBack: async () => {},
        goForward: async () => {},
        reload: async () => {},
      },
      confirmAction: async () => true,
      emit: (message) => emitted.push(message),
    });

    await runner.run();

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(finished?.runState?.browserSession?.currentTabId).toBe(2);
    expect(finished?.runState?.outputs?.open_target).toEqual(expect.objectContaining({
      url: 'https://target.test/',
      title: '目标页面',
    }));
    expect(observedTabIds).not.toContain(1);
    expect(observedTabIds).toContain(2);
  });
});
