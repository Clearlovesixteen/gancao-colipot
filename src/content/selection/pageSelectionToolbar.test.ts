import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPageSelectionContext,
  PageSelectionToolbar,
  shouldIgnoreSelectionElement,
} from './pageSelectionToolbar';

function makeSelection(range: Range, text: string): Selection {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: range.startContainer,
    focusNode: range.endContainer,
    anchorOffset: range.startOffset,
    focusOffset: range.endOffset,
    type: 'Range',
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection;
}

describe('pageSelectionToolbar', () => {
  beforeEach(() => {
    document.title = '选区测试';
    document.body.innerHTML = `
      <main>
        <h1>产品介绍</h1>
        <section><h2>核心能力</h2><p id="target">上文 需要解释的页面内容 下文</p></section>
        <textarea id="editor">表单内容</textarea>
      </main>
    `;
  });

  it('builds structured context with heading and viewport coordinates', () => {
    const paragraph = document.getElementById('target')!;
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 13);
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ left: 40, top: 80, width: 160, height: 24 }),
    });

    const context = buildPageSelectionContext(makeSelection(range, '需要解释的页面内容'));

    expect(context).toMatchObject({
      text: '需要解释的页面内容',
      pageTitle: '选区测试',
      headingPath: expect.arrayContaining(['产品介绍', '核心能力']),
      rect: { x: 40, y: 80, width: 160, height: 24 },
    });
    expect(context?.prefix).toContain('上文');
    expect(context?.suffix).toContain('下文');
  });

  it('does not activate inside editable controls', () => {
    expect(shouldIgnoreSelectionElement(document.getElementById('editor'))).toBe(true);
  });

  it('requires a question before emitting ask and emits direct explain actions', () => {
    const emitted = vi.fn();
    const toolbar = new PageSelectionToolbar(emitted);
    toolbar.show({
      text: '页面内容',
      prefix: '',
      suffix: '',
      headingPath: [],
      pageTitle: '选区测试',
      url: 'https://example.com',
      rect: { x: 40, y: 80, width: 160, height: 24 },
    });
    const host = document.getElementById('gancao-page-selection-toolbar') as HTMLDivElement;
    const shadow = host.shadowRoot!;
    const buttons = Array.from(shadow.querySelectorAll('button'));

    buttons.find((button) => button.textContent === '问 AI')?.click();
    buttons.find((button) => button.textContent === '发送')?.click();
    expect(emitted).not.toHaveBeenCalled();

    const input = shadow.querySelector('input')!;
    input.value = '这句话是什么意思？';
    buttons.find((button) => button.textContent === '发送')?.click();
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ask',
      question: '这句话是什么意思？',
    }));

    toolbar.show({
      text: '页面内容',
      prefix: '',
      suffix: '',
      headingPath: [],
      pageTitle: '选区测试',
      url: 'https://example.com',
      rect: { x: 40, y: 80, width: 160, height: 24 },
    });
    const nextButtons = Array.from(
      (document.getElementById('gancao-page-selection-toolbar') as HTMLDivElement)
        .shadowRoot!
        .querySelectorAll('button'),
    );
    nextButtons.find((button) => button.textContent === '解释')?.click();
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ action: 'explain' }));
  });
});
