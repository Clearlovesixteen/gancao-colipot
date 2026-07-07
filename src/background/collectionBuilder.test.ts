import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ObservedElement } from '../shared/automationTypes';
import { buildObservedCollections } from './collectionBuilder';

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: overrides.elementId || `el_${Math.random().toString(36).slice(2)}`,
    role: overrides.role || 'button',
    tag: overrides.tag || 'button',
    text: overrides.text || '',
    selector: overrides.selector || '',
    selectors: overrides.selectors || [],
    bbox: overrides.bbox || { x: 0, y: 0, width: 100, height: 32 },
    visible: overrides.visible ?? true,
    enabled: overrides.enabled ?? true,
    purpose: overrides.purpose,
    region: overrides.region,
    context: overrides.context,
    parentText: overrides.parentText,
    placeholder: overrides.placeholder,
    name: overrides.name,
    value: overrides.value,
    clickable: overrides.clickable ?? true,
    active: overrides.active,
    expanded: overrides.expanded,
  };
}

function observation(elements: ObservedElement[]): BrowserObservation {
  return {
    success: true,
    url: 'https://example.test',
    title: '测试页面',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
    elements,
    capturedAt: Date.now(),
  };
}

describe('buildObservedCollections', () => {
  it('builds form_group from labeled controls', () => {
    const collections = buildObservedCollections({
      observation: observation([
        element({
          elementId: 'field_user',
          role: 'textbox',
          tag: 'input',
          parentText: '用户花名',
          placeholder: '请输入',
          value: '秋枫',
          region: 'form_area',
          bbox: { x: 180, y: 80, width: 220, height: 32 },
        }),
        element({
          elementId: 'field_system',
          role: 'combobox',
          tag: 'div',
          parentText: '子系统',
          value: '智慧药房WMS仓储',
          region: 'form_area',
          bbox: { x: 180, y: 36, width: 220, height: 32 },
        }),
      ]),
    });

    const formGroup = collections.find((collection) => collection.type === 'form_group');
    expect(formGroup?.items.map((item) => item.metadata?.label)).toEqual(['子系统', '用户花名']);
    expect(formGroup?.items[0]?.metadata?.controlType).toBe('select');
    expect(formGroup?.items[1]?.metadata?.value).toBe('秋枫');
  });

  it('builds action_group with risk levels and inferred purposes', () => {
    const collections = buildObservedCollections({
      observation: observation([
        element({ elementId: 'export', text: '导 出', purpose: 'download_button', bbox: { x: 40, y: 120, width: 72, height: 32 } }),
        element({ elementId: 'search', text: '查询', bbox: { x: 900, y: 80, width: 64, height: 32 } }),
        element({ elementId: 'delete', text: '删除', bbox: { x: 980, y: 80, width: 64, height: 32 } }),
      ]),
    });

    const actionGroup = collections.find((collection) => collection.type === 'action_group');
    const byId = new Map(actionGroup?.items.map((item) => [item.elementId, item]));
    expect(byId.get('export')?.purpose).toBe('download_button');
    expect(byId.get('export')?.riskLevel).toBe('medium');
    expect(byId.get('search')?.purpose).toBe('search_button');
    expect(byId.get('search')?.riskLevel).toBe('low');
    expect(byId.get('delete')?.purpose).toBe('delete_button');
    expect(byId.get('delete')?.riskLevel).toBe('high');
  });

  it('builds table_row_group with row actions', () => {
    const collections = buildObservedCollections({
      observation: observation([
        element({ elementId: 'cell_name_1', role: 'cell', tag: 'td', text: '库存预警-秋枫.xlsx', region: 'table_area', bbox: { x: 120, y: 200, width: 240, height: 36 } }),
        element({ elementId: 'cell_status_1', role: 'cell', tag: 'td', text: '已生成', region: 'table_area', bbox: { x: 420, y: 200, width: 120, height: 36 } }),
        element({ elementId: 'download_1', role: 'button', tag: 'button', text: '下载', region: 'table_area', bbox: { x: 900, y: 200, width: 48, height: 32 } }),
      ]),
    });

    const tableRows = collections.find((collection) => collection.type === 'table_row_group');
    expect(tableRows?.items).toHaveLength(1);
    expect(tableRows?.items[0]?.text).toContain('库存预警-秋枫.xlsx');
    expect((tableRows?.items[0]?.metadata?.actions as any[])?.[0]).toMatchObject({
      text: '下载',
      purpose: 'download_button',
      riskLevel: 'medium',
    });
  });
});
