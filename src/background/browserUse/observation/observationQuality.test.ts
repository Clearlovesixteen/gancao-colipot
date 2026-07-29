import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ObservedCollection, ObservedElement } from '../../../shared/automation/automationTypes';
import { evaluateObservationQuality } from './observationQuality';

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: 'element-1',
    role: 'button',
    tag: 'button',
    text: '查询',
    selector: '#query',
    selectors: ['#query'],
    bbox: { x: 0, y: 0, width: 80, height: 32 },
    visible: true,
    enabled: true,
    clickable: true,
    ...overrides,
  };
}

function observation(elements: ObservedElement[]): BrowserObservation {
  return {
    success: true,
    url: 'https://example.test/list',
    title: '业务列表',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    elements,
    capturedAt: Date.now(),
  };
}

describe('evaluateObservationQuality', () => {
  it('scores a complete semantic observation highly', () => {
    const elements = [
      element({ elementId: 'field-1', role: 'textbox', tag: 'input', text: '', selector: '#name', parentText: '用户花名' }),
      element({ elementId: 'query-1', text: '查询', selector: '#query', purpose: 'search_button' }),
      element({ elementId: 'download-1', text: '下载', selector: '#download', purpose: 'download_button' }),
    ];
    const collections: ObservedCollection[] = [
      {
        id: 'form',
        type: 'form_group',
        items: [{
          index: 1,
          text: '用户花名',
          elementId: 'field-1',
          selector: '#name',
          confidence: 0.9,
          metadata: { label: '用户花名', controlType: 'input', fieldPurpose: 'user_alias' },
        }],
      },
      {
        id: 'actions',
        type: 'action_group',
        items: [
          { index: 1, text: '查询', elementId: 'query-1', selector: '#query', purpose: 'search_button', confidence: 0.9, metadata: { actionKind: 'search', riskLevel: 'low' } },
          { index: 2, text: '下载', elementId: 'download-1', selector: '#download', purpose: 'download_button', confidence: 0.95, metadata: { actionKind: 'download', riskLevel: 'medium' } },
        ],
      },
    ];

    const report = evaluateObservationQuality({ observation: observation(elements), collections });

    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.coverageRatio).toBe(1);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('reports duplicate element ids and duplicate collection items', () => {
    const duplicate = element({ elementId: 'same-id' });
    const collections: ObservedCollection[] = [{
      id: 'actions',
      type: 'action_group',
      items: [
        { index: 1, text: '查询', elementId: 'same-id', selector: '#query', purpose: 'search_button', confidence: 0.8, metadata: { actionKind: 'search', riskLevel: 'low' } },
        { index: 2, text: '查询', elementId: 'same-id', selector: '#query', purpose: 'search_button', confidence: 0.8, metadata: { actionKind: 'search', riskLevel: 'low' } },
      ],
    }];

    const report = evaluateObservationQuality({ observation: observation([duplicate, { ...duplicate }]), collections });

    expect(report.issues.map((issue) => issue.code)).toContain('DUPLICATE_ELEMENT_ID');
    expect(report.issues.map((issue) => issue.code)).toContain('DUPLICATE_COLLECTION_ITEM');
    expect(report.duplicateRatio).toBeGreaterThan(0);
  });

  it('rejects ambiguous duplicate menu leaves without parent context', () => {
    const collections: ObservedCollection[] = [{
      id: 'menus',
      type: 'menu_group',
      items: [
        { index: 1, text: '库存预警', elementId: 'menu-1', selector: '#menu-1', confidence: 0.8 },
        { index: 2, text: '库存预警', elementId: 'menu-2', selector: '#menu-2', confidence: 0.8 },
      ],
    }];

    const report = evaluateObservationQuality({
      observation: observation([
        element({ elementId: 'menu-1', text: '库存预警', purpose: 'menu_item' }),
        element({ elementId: 'menu-2', text: '库存预警', purpose: 'menu_item' }),
      ]),
      collections,
    });

    expect(report.issues.filter((issue) => issue.code === 'MISSING_PARENT_CONTEXT')).toHaveLength(2);
  });

  it('reports incomplete form, row and action semantics', () => {
    const collections: ObservedCollection[] = [
      { id: 'form', type: 'form_group', items: [{ index: 1, text: '字段', elementId: 'field', confidence: 0.7 }] },
      { id: 'rows', type: 'table_row_group', items: [{ index: 1, text: '第一行', elementId: 'row', confidence: 0.7 }] },
      { id: 'actions', type: 'action_group', items: [{ index: 1, text: '图标', elementId: 'action', confidence: 0.7 }] },
    ];
    const report = evaluateObservationQuality({
      observation: observation([
        element({ elementId: 'field', role: 'textbox' }),
        element({ elementId: 'row' }),
        element({ elementId: 'action' }),
      ]),
      collections,
    });

    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'INCOMPLETE_FORM_FIELD',
      'INCOMPLETE_TABLE_ROW',
      'INCOMPLETE_ACTION',
    ]));
  });

  it('returns an explicit low-quality report for an empty observation', () => {
    const report = evaluateObservationQuality({ observation: observation([]), collections: [] });
    expect(report.score).toBeLessThan(50);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'NO_INTERACTIVE_ELEMENTS',
      'NO_SEMANTIC_COLLECTIONS',
    ]));
  });
});
