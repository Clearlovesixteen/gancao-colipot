import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUsePageContext, ComputerUsePhase, PlannedStep } from '../shared/automationTypes';
import { buildObservedCollections } from './collectionBuilder';
import { resolvePlannedStepTarget } from './targetResolver';

const baseObservation: BrowserObservation = {
  success: true,
  url: 'https://example.test',
  title: 'Example',
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
  capturedAt: 1,
  elements: [
    {
      elementId: 'result_1',
      role: 'link',
      tag: 'a',
      text: '第一条结果',
      selector: '#r1',
      selectors: ['#r1'],
      bbox: { x: 0, y: 10, width: 200, height: 24 },
      visible: true,
      enabled: true,
      clickable: true,
      href: 'https://one.test',
      purpose: 'generic',
      score: 0.9,
    },
    {
      elementId: 'result_3',
      role: 'link',
      tag: 'a',
      text: '第三条结果',
      selector: '#r3',
      selectors: ['#r3'],
      bbox: { x: 0, y: 60, width: 200, height: 24 },
      visible: true,
      enabled: true,
      clickable: true,
      href: 'https://three.test',
      purpose: 'generic',
      score: 0.9,
    },
    {
      elementId: 'granule_warning',
      role: 'menuitem',
      tag: 'div',
      text: '库存预警',
      selector: '#granule-warning',
      selectors: ['#granule-warning'],
      bbox: { x: 0, y: 160, width: 120, height: 32 },
      visible: true,
      enabled: true,
      clickable: true,
      parentText: '颗粒剂管理',
      context: '颗粒剂管理 库存预警',
      purpose: 'menu_item',
      score: 0.8,
    },
    {
      elementId: 'drink_warning',
      role: 'menuitem',
      tag: 'div',
      text: '库存预警',
      selector: '#drink-warning',
      selectors: ['#drink-warning'],
      bbox: { x: 0, y: 200, width: 120, height: 32 },
      visible: true,
      enabled: true,
      clickable: true,
      parentText: '饮片管理',
      context: '饮片管理 库存预警',
      purpose: 'menu_item',
      score: 0.8,
    },
  ],
};

function makeContext(overrides: Partial<ComputerUsePageContext> = {}): ComputerUsePageContext {
  return {
    observation: baseObservation,
    structuredData: undefined,
    pageTextPreview: '',
    navigationCandidates: baseObservation.elements.filter((element) => element.purpose === 'menu_item'),
    tableCandidates: [],
    actionCandidates: [],
    collections: [
      {
        id: 'search_results:main',
        type: 'search_results',
        title: '搜索结果',
        confidence: 0.9,
        items: [
          { index: 1, text: '第一条结果', elementId: 'result_1', selector: '#r1', href: 'https://one.test', confidence: 0.9 },
          { index: 3, text: '第三条结果', elementId: 'result_3', selector: '#r3', href: 'https://three.test', confidence: 0.9 },
          { index: 5, text: '第五条结果', elementId: 'result_5', selector: '#r5', href: 'https://five.test', confidence: 0.9 },
        ],
      },
    {
      id: 'menu_group:sidebar',
      type: 'menu_group',
        title: '侧边栏菜单',
        confidence: 0.8,
        items: [
          { index: 1, text: '库存预警', elementId: 'granule_warning', selector: '#granule-warning', parentText: '颗粒剂管理', context: '颗粒剂管理 库存预警', confidence: 0.8 },
          { index: 2, text: '库存预警', elementId: 'drink_warning', selector: '#drink-warning', parentText: '饮片管理', context: '饮片管理 库存预警', confidence: 0.8 },
        ],
      },
      {
        id: 'collection_action_group',
        type: 'action_group',
        title: '页面动作',
        confidence: 0.8,
        items: [
          { index: 1, text: '导 出', elementId: 'export_1', selector: '#export', purpose: 'download_button', confidence: 0.93 },
          { index: 2, text: '查 询', elementId: 'search_1', selector: '#search', purpose: 'search_button', confidence: 0.72 },
        ],
      },
    ],
    ...overrides,
  };
}

describe('targetResolver', () => {
  it('resolves collection ordinal targets', () => {
    const step: PlannedStep = {
      id: 'click_third',
      action: 'click',
      target: { collectionType: 'search_results', ordinal: 3, text: '搜索结果' },
      rationale: '点击第三个自然结果',
    };

    const resolved = resolvePlannedStepTarget({ step, context: makeContext() });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({ elementId: 'result_3', selector: '#r3' }));
    expect(resolved.candidate?.source).toBe('collection');
  });

  it('resolves the fifth natural result by semantic ordinal instead of DOM position', () => {
    const step: PlannedStep = {
      id: 'click_fifth',
      action: 'click',
      target: { collectionType: 'search_results', ordinal: 5, text: '搜索结果' },
      rationale: '点击第五个自然结果',
    };

    const resolved = resolvePlannedStepTarget({ step, context: makeContext() });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({
      elementId: 'result_5',
      selector: '#r5',
      href: 'https://five.test',
    }));
  });

  it('resolves duplicate menu labels by parent path', () => {
    const phase: ComputerUsePhase = {
      id: 'navigate',
      type: 'navigate_to_page',
      goal: '进入饮片管理库存预警',
      targets: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const step: PlannedStep = {
      id: 'click_warning',
      action: 'click',
      target: { collectionType: 'menu_group', text: '库存预警', parentPath: ['饮片管理'] },
      rationale: '点击饮片管理下的库存预警',
    };

    const resolved = resolvePlannedStepTarget({ step, context: makeContext(), phase });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({ elementId: 'drink_warning', selector: '#drink-warning' }));
  });

  it('revalidates an explicit planner-selected elementId through semantic collection scoring', () => {
    const phase: ComputerUsePhase = {
      id: 'navigate',
      type: 'navigate_to_page',
      goal: '进入饮片管理库存预警',
      targets: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const step: PlannedStep = {
      id: 'click_warning',
      action: 'click',
      target: {
        elementId: 'drink_warning',
        selector: '#drink-warning',
        collectionType: 'menu_group',
        text: '库存预警',
        parentPath: ['饮片管理'],
      },
      rationale: 'Planner 已经选中饮片管理下的库存预警',
    };

    const resolved = resolvePlannedStepTarget({ step, context: makeContext(), phase });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({ elementId: 'drink_warning', selector: '#drink-warning' }));
    expect(resolved.candidate?.source).toBe('collection');
    expect(resolved.matchedBy).toBe('collection_semantic_text');
  });

  it('skips candidates remembered as failed in the same phase', () => {
    const step: PlannedStep = {
      id: 'click_result',
      action: 'click',
      target: { collectionType: 'search_results', text: '结果' },
      rationale: '点击搜索结果',
    };

    const resolved = resolvePlannedStepTarget({
      step,
      context: makeContext(),
      phaseMemory: {
        phaseId: 'search',
        attempts: 1,
        failedCandidates: [{ action: 'click', elementId: 'result_1', reason: '页面无变化', count: 1 }],
      },
    });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target?.elementId).toBe('result_3');
  });

  it('blocks unresolved required targets instead of guessing', () => {
    const step: PlannedStep = {
      id: 'click_missing',
      action: 'click',
      target: { collectionType: 'menu_group', text: '不存在的菜单' },
      rationale: '点击不存在的菜单',
    };

    const resolved = resolvePlannedStepTarget({
      step,
      context: makeContext({ collections: [], navigationCandidates: [], actionCandidates: [], observation: { ...baseObservation, elements: [] } }),
    });

    expect(resolved.blocked).toBe(true);
    expect(resolved.reason).toContain('无法解析动作目标');
  });

  it('resolves download targets from action_group only when the item is a real download button', () => {
    const step: PlannedStep = {
      id: 'download',
      action: 'download_file',
      target: { collectionType: 'action_group', purpose: 'download_button', text: '导出' },
      rationale: '点击真实导出按钮',
    };
    const phase: ComputerUsePhase = {
      id: 'download',
      type: 'download_file',
      goal: '点击导出',
      targets: ['导出'],
    };

    const resolved = resolvePlannedStepTarget({ step, context: makeContext(), phase });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({ elementId: 'export_1', selector: '#export', purpose: 'download_button' }));
    expect(resolved.candidate?.source).toBe('collection');
  });

  it('does not use a row download action for a page-level export phase', () => {
    const step: PlannedStep = {
      id: 'download',
      action: 'download_file',
      target: { collectionType: 'action_group', purpose: 'download_button', text: '导出' },
      rationale: '点击页面级导出按钮',
    };
    const phase: ComputerUsePhase = {
      id: 'download',
      type: 'download_file',
      goal: '点击导出',
      targets: ['导出'],
    };
    const collections = [{
      id: 'collection_action_group',
      type: 'action_group' as const,
      title: '页面动作',
      confidence: 0.8,
      items: [{
        index: 1,
        text: '下载文件',
        elementId: 'row_download_1',
        selector: '#row-download-1',
        purpose: 'download_button',
        confidence: 0.93,
        metadata: { purpose: 'download_button', rowIndex: 1 },
      }],
    }];

    const resolved = resolvePlannedStepTarget({
      step,
      phase,
      context: makeContext({ collections, observation: { ...baseObservation, elements: [] } }),
    });

    expect(resolved.blocked).toBe(true);
    expect(resolved.reason).toContain('无法解析真实导出/下载按钮');
  });

  it('blocks download actions when only non-download actions are present', () => {
    const step: PlannedStep = {
      id: 'download',
      action: 'download_file',
      target: { collectionType: 'action_group', purpose: 'download_button', text: '导出' },
      rationale: '点击真实导出按钮',
    };
    const phase: ComputerUsePhase = {
      id: 'download',
      type: 'download_file',
      goal: '点击导出',
      targets: ['导出'],
    };

    const resolved = resolvePlannedStepTarget({
      step,
      phase,
      context: makeContext({
        collections: [{
          id: 'collection_action_group',
          type: 'action_group',
          title: '页面动作',
          items: [{ index: 1, text: '查询', elementId: 'search_1', selector: '#search', purpose: 'search_button', confidence: 0.8 }],
        }],
      }),
    });

    expect(resolved.blocked).toBe(true);
    expect(resolved.reason).toContain('真实导出/下载按钮');
  });

  it('uses sidebar parent context to choose the correct duplicate child menu', () => {
    const observation: BrowserObservation = {
      ...baseObservation,
      elements: [
        {
          elementId: 'granule_parent_container',
          role: 'div',
          tag: 'div',
          text: '颗粒剂管理颗粒剂收货库存预警库存结存',
          selector: 'div.sidebar-item',
          selectors: ['div.sidebar-item'],
          bbox: { x: 12, y: 10, width: 180, height: 160 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 颗粒剂管理颗粒剂收货库存预警库存结存',
          clickable: false,
          level: 1,
          score: 0.82,
        },
        {
          elementId: 'granule_parent',
          role: 'div',
          tag: 'div',
          text: '颗粒剂管理',
          selector: 'div.sidebar-handle',
          selectors: ['div.sidebar-handle'],
          bbox: { x: 12, y: 10, width: 180, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 颗粒剂管理颗粒剂收货库存预警库存结存',
          clickable: false,
          level: 1,
          score: 0.82,
        },
        {
          elementId: 'granule_warning',
          role: 'div',
          tag: 'div',
          text: '库存预警',
          selector: 'div.nav-item.leaf',
          selectors: ['div.nav-item.leaf'],
          bbox: { x: 18, y: 90, width: 174, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 颗粒剂收货库存预警库存结存',
          parentText: '颗粒剂收货库存预警库存结存',
          clickable: false,
          level: 1,
          score: 0.82,
        },
        {
          elementId: 'drink_parent_container',
          role: 'div',
          tag: 'div',
          text: '饮片管理待入库列表库存预警库存结存',
          selector: 'div.sidebar-item.active',
          selectors: ['div.sidebar-item.active'],
          bbox: { x: 12, y: 200, width: 180, height: 160 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 饮片管理待入库列表库存预警库存结存',
          clickable: false,
          level: 1,
          active: true,
          expanded: true,
          score: 0.82,
        },
        {
          elementId: 'drink_parent',
          role: 'div',
          tag: 'div',
          text: '饮片管理',
          selector: 'div.sidebar-handle',
          selectors: ['div.sidebar-handle'],
          bbox: { x: 12, y: 200, width: 180, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 饮片管理待入库列表库存预警库存结存',
          clickable: false,
          level: 1,
          score: 0.82,
        },
        {
          elementId: 'drink_warning',
          role: 'div',
          tag: 'div',
          text: '库存预警',
          selector: 'div.nav-item.leaf',
          selectors: ['div.nav-item.leaf'],
          bbox: { x: 18, y: 280, width: 174, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          region: 'sidebar',
          context: 'sidebar | 待入库列表库存预警库存结存',
          parentText: '待入库列表库存预警库存结存',
          clickable: false,
          level: 1,
          score: 0.82,
        },
      ],
    };
    const phase: ComputerUsePhase = {
      id: 'navigate',
      type: 'navigate_to_page',
      goal: '进入饮片管理库存预警',
      targets: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const context: ComputerUsePageContext = {
      observation,
      pageTextPreview: '',
      navigationCandidates: observation.elements,
      tableCandidates: [],
      actionCandidates: [],
      collections: buildObservedCollections({ observation, phase }),
    };
    const step: PlannedStep = {
      id: 'click_warning',
      action: 'click',
      target: { collectionType: 'menu_group', text: '库存预警', parentPath: ['饮片管理'] },
      rationale: '点击饮片管理下的库存预警',
    };

    const resolved = resolvePlannedStepTarget({ step, context, phase });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target?.elementId).toBe('drink_warning');
  });

  it('resolves row-scoped download actions from table_row_group', () => {
    const step: PlannedStep = {
      id: 'download_first_row',
      action: 'download_file',
      target: {
        elementId: 'row_download_1',
        selector: '#row-download-1',
        collectionType: 'table_row_group',
        ordinal: 1,
        purpose: 'download_button',
        text: '下载',
      },
      rationale: '下载第一条数据',
    };
    const phase: ComputerUsePhase = {
      id: 'download_row',
      type: 'download_file',
      goal: '下载第一条数据',
      targets: ['下载'],
      ordinal: 1,
      collectionType: 'table_row_group',
    };
    const context = makeContext({
      collections: [{
        id: 'table_rows',
        type: 'table_row_group',
        title: '表格行',
        items: [{
          index: 1,
          text: '库存预警-秋枫.xlsx | 已生成',
          confidence: 0.8,
          metadata: {
            actions: [{
              text: '下载',
              purpose: 'download_button',
              elementId: 'row_download_1',
              selector: '#row-download-1',
            }],
          },
        }],
      }],
      observation: {
        ...baseObservation,
        elements: [
          ...baseObservation.elements,
          {
            elementId: 'row_download_1',
            role: 'button',
            tag: 'button',
            text: '下载',
            selector: '#row-download-1',
            selectors: ['#row-download-1'],
            bbox: { x: 900, y: 200, width: 48, height: 32 },
            visible: true,
            enabled: true,
            clickable: true,
            purpose: 'download_button',
            score: 0.9,
          },
        ],
      },
    });

    const resolved = resolvePlannedStepTarget({ step, context, phase });

    expect(resolved.blocked).toBeFalsy();
    expect(resolved.step.target).toEqual(expect.objectContaining({
      elementId: 'row_download_1',
      selector: '#row-download-1',
      purpose: 'download_button',
    }));
    expect(resolved.candidate?.source).toBe('collection');
    expect(resolved.matchedBy).toBe('collection_row_action');
    expect(resolved.score).toBeGreaterThan(0);
    expect(resolved.verificationHint).toContain('download');
  });

  it('reports rejected candidates when a semantic target cannot be resolved', () => {
    const step: PlannedStep = {
      id: 'missing_download',
      action: 'download_file',
      target: { collectionType: 'action_group', purpose: 'download_button', text: '下载' },
      rationale: '下载文件',
    };
    const context = makeContext({
      collections: [{
        id: 'actions',
        type: 'action_group',
        items: [{ index: 1, text: '查询', elementId: 'search', purpose: 'search_button', confidence: 0.9 }],
      }],
    });

    const resolved = resolvePlannedStepTarget({ step, context });

    expect(resolved.blocked).toBe(true);
    expect(resolved.rejectedCandidates?.[0]).toMatchObject({ text: '查询', reason: expect.any(String) });
  });
});
