import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUsePageContext, ObservedElement, PlannedStep } from '../shared/automationTypes';
import { verifyComputerUseStep } from './verifyComputerUseStep';

function element(partial: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: partial.elementId || 'el_1',
    role: partial.role || 'textbox',
    tag: partial.tag || 'input',
    text: partial.text || '',
    selector: partial.selector || '#input',
    selectors: partial.selectors || [partial.selector || '#input'],
    bbox: partial.bbox || { x: 0, y: 0, width: 100, height: 32 },
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    value: partial.value,
    purpose: partial.purpose || 'generic',
    active: partial.active,
  };
}

function context(overrides: Partial<ComputerUsePageContext> = {}): ComputerUsePageContext {
  const observation: BrowserObservation = {
    success: true,
    url: 'https://example.test',
    title: '测试页',
    viewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
    elements: [],
    capturedAt: Date.now(),
  };
  const { observation: observationOverrides, ...restOverrides } = overrides;
  return {
    pageTextPreview: '',
    navigationCandidates: [],
    tableCandidates: [],
    actionCandidates: [],
    ...restOverrides,
    observation: { ...observation, ...observationOverrides },
  };
}

describe('verifyComputerUseStep', () => {
  it('verifies text input values', () => {
    const step: PlannedStep = {
      id: 'type',
      action: 'type',
      target: { elementId: 'input_1' },
      value: '豆哥牛逼',
      rationale: '输入关键词',
    };
    const after = context({ observation: { elements: [element({ elementId: 'input_1', value: '豆哥牛逼' })] } as any });

    expect(verifyComputerUseStep({ step, result: {}, before: context(), after }).success).toBe(true);
  });

  it('verifies selected values from form_group metadata', () => {
    const step: PlannedStep = {
      id: 'select_system',
      action: 'select_option',
      target: { elementId: 'system_select', collectionType: 'form_group', text: '子系统' },
      value: '智慧药房WMS仓储',
      rationale: '选择子系统',
      verify: { type: 'value_equals', value: '智慧药房WMS仓储' },
    };
    const after = context({
      collections: [{
        id: 'forms',
        type: 'form_group',
        items: [{
          index: 1,
          text: '子系统',
          elementId: 'system_select',
          confidence: 0.9,
          metadata: { label: '子系统', controlType: 'select', currentValue: '智慧药房WMS仓储' },
        }],
      }],
    });

    expect(verifyComputerUseStep({ step, result: { success: true }, before: context(), after }).success).toBe(true);
  });

  it('rejects a select action when the selected value is not observable', () => {
    const step: PlannedStep = {
      id: 'select_system',
      action: 'select_option',
      target: { elementId: 'system_select', collectionType: 'form_group', text: '子系统' },
      value: '智慧药房WMS仓储',
      rationale: '选择子系统',
      verify: { type: 'value_equals', value: '智慧药房WMS仓储' },
    };
    const after = context({
      collections: [{
        id: 'forms',
        type: 'form_group',
        items: [{
          index: 1,
          text: '子系统',
          elementId: 'system_select',
          confidence: 0.9,
          metadata: { label: '子系统', controlType: 'select', currentValue: '其他系统' },
        }],
      }],
    });

    expect(verifyComputerUseStep({ step, result: { success: true }, before: context(), after })).toEqual(expect.objectContaining({ success: false }));
  });

  it('fails when extract_table returns no table', () => {
    const step: PlannedStep = { id: 'extract', action: 'extract_table', rationale: '提取表格' };

    expect(verifyComputerUseStep({ step, result: { tables: [] }, before: context(), after: context() })).toEqual(expect.objectContaining({
      success: false,
    }));
  });

  it('does not pass extract_table only because the page still has table candidates', () => {
    const step: PlannedStep = { id: 'extract', action: 'extract_table', rationale: '提取表格' };

    expect(verifyComputerUseStep({
      step,
      result: { tables: [] },
      before: context(),
      after: context({ tableCandidates: [{ headers: ['商品'], rows: [['A']] }] }),
    })).toEqual(expect.objectContaining({
      success: false,
    }));
  });

  it('passes when extract_table returns tables', () => {
    const step: PlannedStep = { id: 'extract', action: 'extract_table', rationale: '提取表格' };

    expect(verifyComputerUseStep({
      step,
      result: { tables: [{ headers: ['商品'], rows: [['A']] }] },
      before: context(),
      after: context(),
    }).success).toBe(true);
  });

  it('passes download_file with a warning when file is downloaded but not saved to documents', () => {
    const step: PlannedStep = { id: 'download', action: 'download_file', rationale: '导出文件' };

    expect(verifyComputerUseStep({
      step,
      result: {
        success: true,
        status: 'partial',
        filename: '库存预警.xlsx',
        error: '无法自动读取文件内容',
        needsManualImport: true,
      },
      before: context(),
      after: context(),
    })).toEqual(expect.objectContaining({
      success: true,
      warning: expect.stringContaining('无法自动读取文件内容'),
    }));
  });

  it('blocks download_file when no completed download is captured', () => {
    const step: PlannedStep = { id: 'download', action: 'download_file', rationale: '导出文件' };

    expect(verifyComputerUseStep({
      step,
      result: { success: false, status: 'timeout', error: '等待下载完成超时' },
      before: context(),
      after: context(),
    })).toEqual(expect.objectContaining({
      success: false,
      blocking: true,
    }));
  });

  it('blocks on login or captcha pages', () => {
    const step: PlannedStep = { id: 'click', action: 'click', rationale: '点击' };
    const after = context({ observation: { pageState: { kind: 'login_page', hasModal: false, hasCaptcha: false, hasLoginSignal: true } } as any });

    expect(verifyComputerUseStep({ step, result: {}, before: context(), after })).toEqual(expect.objectContaining({
      success: false,
      blocking: true,
    }));
  });

  it('fails click verification when nothing meaningful changes', () => {
    const step: PlannedStep = {
      id: 'click_nav',
      action: 'click',
      target: { elementId: 'menu_1', text: '库存预警' },
      rationale: '点击菜单',
      verify: { type: 'page_changed', value: '库存预警' },
    };
    const before = context({ pageTextPreview: '库存预警', observation: { elements: [element({ elementId: 'menu_1', text: '库存预警' })] } as any });
    const after = context({ pageTextPreview: '库存预警', observation: { elements: [element({ elementId: 'menu_1', text: '库存预警' })] } as any });

    expect(verifyComputerUseStep({ step, result: { success: true }, before, after })).toEqual(expect.objectContaining({
      success: false,
    }));
  });

  it('passes click verification when target menu becomes active', () => {
    const step: PlannedStep = {
      id: 'click_nav',
      action: 'click',
      target: { elementId: 'menu_1', text: '库存预警' },
      rationale: '点击菜单',
      verify: { type: 'page_changed', value: '库存预警' },
    };
    const after = context({ observation: { elements: [element({ elementId: 'menu_1', text: '库存预警', active: true })] } as any });

    expect(verifyComputerUseStep({ step, result: { success: true }, before: context(), after }).success).toBe(true);
  });
});
