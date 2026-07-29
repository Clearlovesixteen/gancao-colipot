import { describe, expect, it } from 'vitest';
import {
  normalizePageContextActionMessage,
  type PageSelectionContext,
} from './pageContextActions';

function selectionContext(): PageSelectionContext {
  return {
    text: '  一段需要解释的内容  ',
    prefix: '上文',
    suffix: '下文',
    headingPath: ['章节一'],
    pageTitle: '测试页面',
    url: 'https://example.com/article',
    selector: '#article',
    rect: { x: 10, y: 20, width: 120, height: 24 },
  };
}

describe('pageContextActions', () => {
  it('normalizes a structured page selection action', () => {
    const message = normalizePageContextActionMessage({
      type: 'PAGE_CONTEXT_ACTION',
      action: 'explain',
      context: selectionContext(),
    });

    expect(message).toMatchObject({
      action: 'explain',
      context: {
        text: '一段需要解释的内容',
        pageTitle: '测试页面',
        url: 'https://example.com/article',
      },
    });
  });

  it('rejects ask actions without a question', () => {
    expect(normalizePageContextActionMessage({
      type: 'PAGE_CONTEXT_ACTION',
      action: 'ask',
      context: selectionContext(),
    })).toBeNull();
  });

  it('keeps direct actions question-free', () => {
    expect(normalizePageContextActionMessage({
      type: 'PAGE_CONTEXT_ACTION',
      action: 'add_to_topic',
      context: selectionContext(),
    })?.action).toBe('add_to_topic');
  });
});
