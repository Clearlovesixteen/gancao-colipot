import { describe, expect, it } from 'vitest';
import type { ComputerUsePageContext, PlannedStep } from '../shared/automationTypes';
import { createBrowserUseTargetLease, revalidateBrowserUseTargetLease } from './browserUseTargetLease';

function context(item: { elementId: string; text: string; href?: string }): ComputerUsePageContext {
  return {
    observation: {
      success: true,
      capturedAt: Date.now(),
      url: 'https://example.com/search?q=test',
      title: 'results',
      viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
      elements: [{
        elementId: item.elementId,
        role: 'link',
        tag: 'a',
        text: item.text,
        selector: `#${item.elementId}`,
        selectors: [`#${item.elementId}`],
        bbox: { x: 10, y: 10, width: 100, height: 20 },
        visible: true,
        enabled: true,
        clickable: true,
        href: item.href,
      }],
      regions: [],
      pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false },
    },
    collections: [{
      id: 'search-results',
      type: 'search_results',
      items: [{ index: 3, text: item.text, href: item.href, elementId: item.elementId, selector: `#${item.elementId}`, confidence: 0.95 }],
    }],
    structuredData: { headings: [], fields: [], tables: [], lists: [] },
    pageTextPreview: item.text,
    navigationCandidates: [],
    tableCandidates: [],
    actionCandidates: [],
  };
}

const step: PlannedStep = {
  id: 'click-third',
  action: 'click',
  target: { collectionType: 'search_results', ordinal: 3 },
  rationale: '点击第三条自然结果',
};

describe('BrowserUseTargetLease', () => {
  it('rebinds a semantic target after a DOM rerender changes the element id', () => {
    const before = context({ elementId: 'old-id', text: '第三条结果', href: 'https://example.com/third' });
    const initial = revalidateBrowserUseTargetLease({ step, context: before });
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error(initial.reason);

    const lease = createBrowserUseTargetLease(initial.resolution, before);
    const after = context({ elementId: 'new-id', text: '第三条结果', href: 'https://example.com/third' });
    const refreshed = revalidateBrowserUseTargetLease({ step, context: after, lease });

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error(refreshed.reason);
    expect(refreshed.rebound).toBe(true);
    expect(refreshed.resolution.step.target?.elementId).toBe('new-id');
  });

  it('rejects the lease when the requested ordinal now points to different content', () => {
    const before = context({ elementId: 'old-id', text: '第三条结果', href: 'https://example.com/third' });
    const initial = revalidateBrowserUseTargetLease({ step, context: before });
    if (!initial.ok) throw new Error(initial.reason);
    const lease = createBrowserUseTargetLease(initial.resolution, before);

    const after = context({ elementId: 'replacement', text: '新的第三条广告', href: 'https://ads.example.com/' });
    const refreshed = revalidateBrowserUseTargetLease({ step, context: after, lease });

    expect(refreshed).toMatchObject({ ok: false, code: 'TARGET_STALE' });
  });
});
