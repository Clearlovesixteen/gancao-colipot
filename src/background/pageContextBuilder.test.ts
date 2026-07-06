import { describe, expect, it, vi } from 'vitest';
import type { BrowserObservation, ComputerUseIntent } from '../shared/automationTypes';
import { buildComputerUsePageContext } from './pageContextBuilder';

const baseIntent: ComputerUseIntent = {
  rawGoal: '导出库存预警列表数据',
  taskType: 'download',
  objective: '导出库存预警列表数据',
  entities: ['库存预警'],
  desiredOutput: 'download_file',
  riskLevel: 'high',
};

const observation: BrowserObservation = {
  success: true,
  url: 'https://example.test/wms',
  title: 'WMS',
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
  capturedAt: Date.now(),
  elements: [
    {
      elementId: 'nav_1',
      role: 'menuitem',
      tag: 'div',
      text: '库存预警',
      selector: '.menu-warning',
      selectors: ['.menu-warning'],
      bbox: { x: 0, y: 0, width: 100, height: 32 },
      visible: true,
      enabled: true,
      purpose: 'menu_item',
      score: 0.8,
    },
    {
      elementId: 'export_1',
      role: 'button',
      tag: 'button',
      text: '导出',
      selector: '#export',
      selectors: ['#export'],
      bbox: { x: 100, y: 0, width: 80, height: 32 },
      visible: true,
      enabled: true,
      purpose: 'download_button',
      score: 0.9,
    },
  ],
};

describe('pageContextBuilder', () => {
  it('builds navigation, table, and action candidates', async () => {
    const executeBrowserTool = vi.fn(async (_tabId: number, toolName: string) => {
      if (toolName === 'observe_page') return observation;
      if (toolName === 'extract_page_structured_data') return { headings: ['库存预警'], fields: [], tables: [{ title: '库存预警' }], lists: [] };
      if (toolName === 'extract_page_tables') return { tables: [{ title: '库存预警', headers: ['商品'], rows: [['A']] }] };
      if (toolName === 'get_page_info') return { text: '库存预警 商品 A' };
      return {};
    });

    const context = await buildComputerUsePageContext({ tabId: 1, intent: baseIntent, executeBrowserTool });

    expect(context.navigationCandidates[0]).toEqual(expect.objectContaining({ text: '库存预警' }));
    expect(context.actionCandidates[0]).toEqual(expect.objectContaining({ purpose: 'download_button' }));
    expect(context.tableCandidates).toHaveLength(1);
    expect(context.collections?.some((collection) => collection.type === 'menu_group')).toBe(true);
    expect(context.collections?.some((collection) => collection.type === 'table')).toBe(true);
    const actionGroup = context.collections?.find((collection) => collection.type === 'action_group');
    expect(actionGroup?.items[0]).toEqual(expect.objectContaining({
      elementId: 'export_1',
      purpose: 'download_button',
    }));
    expect(context.pageTextPreview).toContain('库存预警');
  });

  it('keeps target navigation candidates even when they appear deep in a large sidebar', async () => {
    const manyMenus = Array.from({ length: 220 }, (_, index) => ({
      elementId: `nav_${index}`,
      role: 'menuitem',
      tag: 'div',
      text: `普通菜单 ${index}`,
      selector: `.menu-${index}`,
      selectors: [`.menu-${index}`],
      bbox: { x: 0, y: index * 10, width: 100, height: 32 },
      visible: true,
      enabled: true,
      purpose: 'menu_item' as const,
      score: 0.8,
    }));
    const targetMenu = {
      ...manyMenus[219],
      elementId: 'nav_target_warning',
      text: '库存预警',
      selector: '.menu-warning',
      selectors: ['.menu-warning'],
    };
    const executeBrowserTool = vi.fn(async (_tabId: number, toolName: string) => {
      if (toolName === 'observe_page') return { ...observation, elements: [...manyMenus.slice(0, 219), targetMenu] };
      if (toolName === 'extract_page_structured_data') return { headings: [], fields: [], tables: [], lists: [] };
      if (toolName === 'extract_page_tables') return { tables: [] };
      if (toolName === 'get_page_info') return { text: '数据权限管理' };
      return {};
    });

    const context = await buildComputerUsePageContext({ tabId: 1, intent: baseIntent, executeBrowserTool });

    expect(context.navigationCandidates[0]).toEqual(expect.objectContaining({ elementId: 'nav_target_warning' }));
    expect(context.navigationCandidates).toHaveLength(80);
    expect(executeBrowserTool).toHaveBeenCalledWith(1, 'observe_page', expect.objectContaining({ limit: 520 }));
  });

  it('does not collect structured tables during navigate phases', async () => {
    const executeBrowserTool = vi.fn(async (_tabId: number, toolName: string) => {
      if (toolName === 'observe_page') return observation;
      if (toolName === 'extract_page_structured_data') return { headings: ['不应调用'], fields: [], tables: [], lists: [] };
      if (toolName === 'extract_page_tables') return { tables: [{ title: '不应调用' }] };
      if (toolName === 'get_page_info') return { text: '不应调用' };
      return {};
    });

    const context = await buildComputerUsePageContext({
      tabId: 1,
      intent: baseIntent,
      phase: {
        id: 'navigate',
        type: 'navigate_to_page',
        goal: '进入库存预警',
        targets: ['库存预警'],
        navigationPath: ['库存预警'],
      },
      executeBrowserTool,
    });

    expect(context.navigationCandidates[0]).toEqual(expect.objectContaining({ text: '库存预警' }));
    expect(context.actionCandidates[0]).toEqual(expect.objectContaining({ purpose: 'download_button' }));
    expect(context.tableCandidates).toHaveLength(0);
    expect(context.collections?.some((collection) => collection.type === 'menu_group')).toBe(true);
    expect(context.collections?.some((collection) => collection.type === 'table')).toBe(false);
    expect(context.pageTextPreview).toBe('');
    expect(executeBrowserTool).toHaveBeenCalledTimes(1);
    expect(executeBrowserTool).toHaveBeenCalledWith(1, 'observe_page', expect.any(Object));
  });

  it('collects search results as semantic collections for collection item phases', async () => {
    const searchIntent: ComputerUseIntent = {
      rawGoal: '打开百度，搜索甘草医生，点击第3个结果',
      taskType: 'search',
      objective: '搜索并点击结果',
      entities: ['甘草医生'],
      desiredOutput: 'page_state',
      query: '甘草医生',
      riskLevel: 'low',
    };
    const executeBrowserTool = vi.fn(async (_tabId: number, toolName: string) => {
      if (toolName === 'observe_page') return { ...observation, elements: [] };
      if (toolName === 'get_search_results') return {
        success: true,
        count: 3,
        results: [
          { index: 1, title: '第一条', href: 'https://one.test/', elementId: 'r1', selector: '#r1' },
          { index: 2, title: '第二条', href: 'https://two.test/', elementId: 'r2', selector: '#r2' },
          { index: 3, title: '第三条', href: 'https://three.test/', elementId: 'r3', selector: '#r3' },
        ],
      };
      return {};
    });

    const context = await buildComputerUsePageContext({
      tabId: 1,
      intent: searchIntent,
      phase: {
        id: 'select',
        type: 'select_collection_item',
        goal: '点击第3个搜索结果',
        ordinal: 3,
        collectionType: 'search_results',
        query: '甘草医生',
      },
      executeBrowserTool,
    });

    const searchResults = context.collections?.find((collection) => collection.type === 'search_results');
    expect(searchResults?.items).toHaveLength(3);
    expect(searchResults?.items[2]).toEqual(expect.objectContaining({
      index: 3,
      elementId: 'r3',
      href: 'https://three.test/',
    }));
    expect(executeBrowserTool).toHaveBeenCalledWith(1, 'get_search_results', { limit: 30 });
    expect(executeBrowserTool).not.toHaveBeenCalledWith(1, 'extract_page_tables', expect.anything());
  });
});
