import { describe, expect, it } from 'vitest';
import type {
  BrowserObservation,
  ComputerUsePageContext,
  ComputerUsePhase,
  ElementPurpose,
  ObservedCollection,
} from '../shared/automationTypes';
import { evaluateObservationQuality } from './observationQuality';
import { evaluatePhaseObservationGate } from './phaseObservationGate';

function makeContext(collections: ObservedCollection[], observationPatch: Partial<BrowserObservation> = {}): ComputerUsePageContext {
  const observation: BrowserObservation = {
    success: true,
    url: 'https://example.test/list',
    title: '业务列表',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    capturedAt: Date.now(),
    elements: collections.flatMap((collection) => collection.items.map((item) => ({
      elementId: item.elementId || `${collection.id}_${item.index}`,
      role: 'button',
      tag: 'button',
      text: item.text,
      selector: item.selector || `#${collection.id}_${item.index}`,
      selectors: [item.selector || `#${collection.id}_${item.index}`],
      bbox: { x: 10, y: item.index * 40, width: 120, height: 32 },
      visible: true,
      enabled: true,
      clickable: true,
      purpose: (item.purpose || 'generic') as ElementPurpose,
      score: item.confidence,
    }))),
    ...observationPatch,
  };
  const quality = evaluateObservationQuality({ observation, collections });
  return {
    observation: { ...observation, qualityReport: quality },
    pageTextPreview: '',
    navigationCandidates: [],
    tableCandidates: [],
    actionCandidates: [],
    collections,
    observationQuality: quality,
  };
}

describe('phase observation gate', () => {
  it('blocks selecting a result when search_results is absent', () => {
    const phase: ComputerUsePhase = {
      id: 'select', type: 'select_collection_item', goal: '点击第3个结果', ordinal: 3, collectionType: 'search_results',
    };
    const result = evaluatePhaseObservationGate({ phase, context: makeContext([]) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('search_results');
  });

  it('allows a download phase only with an actionable action group', () => {
    const phase: ComputerUsePhase = { id: 'download', type: 'download_file', goal: '导出' };
    const context = makeContext([{
      id: 'actions', type: 'action_group', items: [{
        index: 1, text: '导 出', elementId: 'export', selector: '#export', purpose: 'download_button', confidence: 0.95,
      }],
    }]);
    expect(evaluatePhaseObservationGate({ phase, context }).ok).toBe(true);
  });

  it('blocks duplicate element identities before target resolution', () => {
    const phase: ComputerUsePhase = { id: 'navigate', type: 'navigate_to_page', goal: '进入库存预警', navigationPath: ['饮片管理', '库存预警'] };
    const collections: ObservedCollection[] = [{
      id: 'menus', type: 'menu_group', items: [{
        index: 1, text: '库存预警', elementId: 'duplicate', selector: '#one', parentPath: ['饮片管理'], confidence: 0.9,
      }],
    }];
    const base = makeContext(collections);
    const duplicate = { ...base.observation.elements[0], selector: '#two', selectors: ['#two'] };
    const context = makeContext(collections, { elements: [...base.observation.elements, duplicate] });
    expect(evaluatePhaseObservationGate({ phase, context })).toEqual(expect.objectContaining({ ok: false, retryable: true }));
  });

  it('does not reject a strong required collection because unrelated page coverage is low', () => {
    const phase: ComputerUsePhase = { id: 'fill', type: 'fill_form', goal: '填写用户花名' };
    const context = makeContext([{
      id: 'form', type: 'form_group', items: [{
        index: 1, text: '用户花名', elementId: 'alias', selector: '#alias', confidence: 0.95,
        metadata: { label: '用户花名', controlType: 'input', fieldPurpose: 'text_input' },
      }],
    }]);
    expect(evaluatePhaseObservationGate({ phase, context }).ok).toBe(true);
  });

  it('allows wait phases without semantic collections', () => {
    const phase: ComputerUsePhase = { id: 'wait', type: 'wait', goal: '等待页面刷新', waitMs: 1000 };
    const context = makeContext([], { elements: [] });
    expect(evaluatePhaseObservationGate({ phase, context }).ok).toBe(true);
  });

  it('accepts a legacy partial quality report without collection summaries', () => {
    const phase: ComputerUsePhase = {
      id: 'select',
      type: 'select_collection_item',
      goal: '点击第3个搜索结果',
      ordinal: 3,
      collectionType: 'search_results',
    };
    const context = makeContext([{
      id: 'results',
      type: 'search_results',
      metadata: { verifiedNaturalResults: true },
      items: [{
        index: 3,
        text: '第三个自然搜索结果',
        elementId: 'result-3',
        selector: '#result-3',
        href: 'https://example.test/result-3',
        confidence: 0.95,
      }],
    }]);

    context.observationQuality = undefined;
    context.observation.qualityReport = {
      score: 80,
      issues: [],
    } as unknown as BrowserObservation['qualityReport'];

    expect(() => evaluatePhaseObservationGate({ phase, context })).not.toThrow();
    expect(evaluatePhaseObservationGate({ phase, context }).ok).toBe(true);
  });
});
