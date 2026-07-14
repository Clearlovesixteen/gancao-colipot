import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUseIntent, ComputerUsePageContext, ComputerUsePhase } from '../shared/automationTypes';
import { getPhaseFinishEvidence, isPhaseTargetReached } from './phaseCompletion';

function makeContext(observation: BrowserObservation): ComputerUsePageContext {
  return {
    observation,
    pageTextPreview: '',
    navigationCandidates: observation.elements.filter((element) => element.purpose === 'menu_item'),
    tableCandidates: [],
    actionCandidates: [],
    collections: [],
  };
}

const baseObservation: BrowserObservation = {
  success: true,
  url: 'https://adminweb-erp-warehousing.gancao.com/#/basic-settings/data-permission',
  title: '智慧药房WMS',
  viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
  scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
  capturedAt: 1,
  elements: [],
};

const phase: ComputerUsePhase = {
  id: 'navigate',
  type: 'navigate_to_page',
  goal: '进入 饮片管理 > 库存预警',
  targets: ['饮片管理', '库存预警'],
  navigationPath: ['饮片管理', '库存预警'],
};

const formIntent: ComputerUseIntent = {
  rawGoal: '输入用户花名秋枫',
  taskType: 'form',
  objective: '输入用户花名秋枫',
  entities: ['用户花名', '秋枫'],
  riskLevel: 'low',
};

describe('phaseCompletion', () => {
  it('does not treat an active parent menu as the leaf page when its context contains the leaf text', () => {
    const context = makeContext({
      ...baseObservation,
      elements: [{
        elementId: 'drink_parent',
        role: 'div',
        tag: 'div',
        text: '饮片管理',
        selector: 'div.sidebar-handle',
        selectors: ['div.sidebar-handle'],
        bbox: { x: 12, y: 320, width: 180, height: 40 },
        visible: true,
        enabled: true,
        purpose: 'menu_item',
        active: true,
        context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
      }],
    });

    expect(isPhaseTargetReached(phase, context)).toBe(false);
  });

  it('accepts an active leaf menu under the expected parent path', () => {
    const context = makeContext({
      ...baseObservation,
      elements: [{
        elementId: 'drink_warning',
        role: 'div',
        tag: 'div',
        text: '库存预警',
        selector: 'div.nav-item.leaf.active',
        selectors: ['div.nav-item.leaf.active'],
        bbox: { x: 18, y: 520, width: 174, height: 40 },
        visible: true,
        enabled: true,
        purpose: 'menu_item',
        active: true,
        parentText: '饮片管理',
        context: 'sidebar | 饮片管理 库存预警',
      }],
    });

    expect(isPhaseTargetReached(phase, context)).toBe(true);
  });

  it('accepts split active parent and active leaf evidence for nested menus', () => {
    const context = makeContext({
      ...baseObservation,
      url: 'https://adminweb-erp-warehousing.gancao.com/#/management-y/inventory-warning',
      elements: [
        {
          elementId: 'drink_parent',
          role: 'div',
          tag: 'div',
          text: '饮片管理',
          selector: 'div.sidebar-item.active',
          selectors: ['div.sidebar-item.active'],
          bbox: { x: 12, y: 320, width: 180, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          active: true,
          expanded: true,
          context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
        },
        {
          elementId: 'drink_warning',
          role: 'div',
          tag: 'div',
          text: '库存预警',
          selector: 'div.nav-item.leaf.selected',
          selectors: ['div.nav-item.leaf.selected'],
          bbox: { x: 18, y: 520, width: 174, height: 40 },
          visible: true,
          enabled: true,
          purpose: 'menu_item',
          active: true,
          context: 'sidebar | 库存预警',
        },
      ],
    });

    expect(isPhaseTargetReached(phase, context)).toBe(true);
  });

  it('accepts file center routes even when the browser title remains the WMS title', () => {
    const context = makeContext({
      ...baseObservation,
      url: 'https://adminweb-erp-warehousing.gancao.com/#/file-center',
      title: '智慧药房WMS',
      elements: [],
    });

    expect(isPhaseTargetReached({
      id: 'open_file_center',
      type: 'open_page_or_center',
      goal: '打开文件中心',
      targets: ['文件中心'],
    }, context)).toBe(true);
  });

  it('accepts file center pages with visible file list evidence', () => {
    const context = {
      ...makeContext({
        ...baseObservation,
        title: '智慧药房WMS',
        elements: [],
      }),
      pageTextPreview: '搜索文件名 文件名称 文件大小 下载时间',
    };

    expect(isPhaseTargetReached({
      id: 'open_file_center',
      type: 'open_page_or_center',
      goal: '打开文件中心',
      targets: ['文件中心'],
    }, context)).toBe(true);
  });

  it('requires the observed form value before completing a fill phase', () => {
    const fillPhase: ComputerUsePhase = {
      id: 'fill_alias',
      type: 'fill_form',
      goal: '输入用户花名秋枫',
      formValues: [{ label: '用户花名', value: '秋枫', control: 'input' }],
    };
    const context = makeContext({
      ...baseObservation,
      elements: [{
        elementId: 'alias',
        role: 'textbox',
        tag: 'input',
        text: '',
        selector: '#alias',
        selectors: ['#alias'],
        bbox: { x: 10, y: 10, width: 120, height: 32 },
        visible: true,
        enabled: true,
        parentText: '用户花名',
        value: '',
      }],
    });

    expect(getPhaseFinishEvidence({
      phase: fillPhase,
      intent: formIntent,
      context,
      history: [{ action: { action: 'type', elementId: 'alias', text: '秋枫' } }],
      runState: { currentPhaseIndex: 0, completedPhases: [] },
    })).toMatchObject({ ok: false });
  });

  it('completes a fill phase when the selected value is present in form metadata', () => {
    const fillPhase: ComputerUsePhase = {
      id: 'select_system',
      type: 'fill_form',
      goal: '选择子系统',
      formValues: [{ label: '子系统', value: '智慧药房WMS仓储', control: 'select' }],
    };
    const context = {
      ...makeContext(baseObservation),
      collections: [{
        id: 'forms',
        type: 'form_group' as const,
        items: [{
          index: 1,
          text: '子系统',
          confidence: 1,
          metadata: { label: '子系统', currentValue: '智慧药房WMS仓储', controlType: 'select' as const },
        }],
      }],
    };

    expect(getPhaseFinishEvidence({
      phase: fillPhase,
      intent: formIntent,
      context,
      history: [{ action: { action: 'select_option', elementId: 'system', text: '智慧药房WMS仓储' } }],
      runState: { currentPhaseIndex: 0, completedPhases: [] },
    })).toMatchObject({ ok: true });
  });
});
