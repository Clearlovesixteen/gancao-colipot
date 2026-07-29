import { finder } from '@medv/finder';
import type {
  PageContextAction,
  PageContextActionMessage,
  PageSelectionContext,
} from '../../shared/context/pageContextActions';

const HOST_ID = 'gancao-page-selection-toolbar';
const HIGHLIGHT_ID = 'gancao-page-selection-highlight';
const CONTEXT_CHARS = 180;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function selectionElement(range: Range): HTMLElement | null {
  const node = range.commonAncestorContainer;
  return node instanceof HTMLElement ? node : node.parentElement;
}

export function shouldIgnoreSelectionElement(element: Element | null): boolean {
  if (!element) return true;
  if (element.closest(`#${HOST_ID}, #${HIGHLIGHT_ID}`)) return true;
  return Boolean(element.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  ));
}

function buildHeadingPath(element: HTMLElement): string[] {
  const headings: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const labelledBy = current.getAttribute('aria-labelledby');
    const labelledText = labelledBy
      ? normalizeText(document.getElementById(labelledBy)?.textContent || '')
      : '';
    const directHeading = Array.from(current.children).find((child) => /^H[1-6]$/.test(child.tagName));
    const headingText = normalizeText(labelledText || directHeading?.textContent || '');
    if (headingText && !headings.includes(headingText)) headings.unshift(headingText);
    current = current.parentElement;
  }
  const preceding = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .filter((heading) => Boolean(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
    .slice(-3)
    .map((heading) => normalizeText(heading.textContent || ''))
    .filter(Boolean);
  return Array.from(new Set([...preceding, ...headings])).slice(-6);
}

function buildSurroundingText(range: Range): { prefix: string; suffix: string } {
  const prefixRange = document.createRange();
  const suffixRange = document.createRange();
  const root = document.body || document.documentElement;
  try {
    prefixRange.selectNodeContents(root);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    suffixRange.selectNodeContents(root);
    suffixRange.setStart(range.endContainer, range.endOffset);
    return {
      prefix: normalizeText(prefixRange.toString()).slice(-CONTEXT_CHARS),
      suffix: normalizeText(suffixRange.toString()).slice(0, CONTEXT_CHARS),
    };
  } catch {
    return { prefix: '', suffix: '' };
  } finally {
    prefixRange.detach();
    suffixRange.detach();
  }
}

function buildSelector(element: HTMLElement): string | undefined {
  try {
    return finder(element, {
      root: document.body || document.documentElement,
      seedMinLength: 1,
      optimizedMinLength: 2,
    });
  } catch {
    if (!element.id) return undefined;
    const escapedId = globalThis.CSS?.escape
      ? globalThis.CSS.escape(element.id)
      : element.id.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
    return `#${escapedId}`;
  }
}

export function buildPageSelectionContext(selection: Selection): PageSelectionContext | null {
  const text = normalizeText(selection.toString());
  if (!text || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const element = selectionElement(range);
  if (!element || shouldIgnoreSelectionElement(element)) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const surrounding = buildSurroundingText(range);
  return {
    text,
    prefix: surrounding.prefix,
    suffix: surrounding.suffix,
    headingPath: buildHeadingPath(element),
    pageTitle: document.title || '当前页面',
    url: window.location.href,
    selector: buildSelector(element),
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
  };
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const TOOLBAR_CSS = `
  :host { all: initial; color-scheme: light; }
  * { box-sizing: border-box; letter-spacing: 0; }
  .toolbar { position: relative; display:flex; align-items:center; gap:2px; padding:4px; color:#202124;
    background:#fff; border:1px solid #dadce0; border-radius:8px; box-shadow:0 6px 20px rgba(32,33,36,.22);
    font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space:nowrap; }
  button { appearance:none; border:0; background:transparent; color:inherit; padding:6px 8px; min-height:28px;
    border-radius:6px; cursor:pointer; font:inherit; }
  button:hover, button:focus-visible { background:#f1f3f4; outline:none; }
  button.primary { color:#5b4df7; font-weight:600; }
  .ask-row { display:none; align-items:center; gap:4px; min-width:286px; }
  .ask-row.visible { display:flex; }
  .actions.hidden { display:none; }
  input { width:220px; height:30px; border:1px solid #c7c9d9; border-radius:6px; padding:0 8px; outline:none;
    font:inherit; color:#202124; background:#fff; }
  input:focus { border-color:#6558f5; box-shadow:0 0 0 2px rgba(101,88,245,.14); }
  .more-menu { position:absolute; display:none; right:0; top:calc(100% + 4px); min-width:112px; padding:4px;
    background:#fff; border:1px solid #dadce0; border-radius:8px; box-shadow:0 6px 20px rgba(32,33,36,.18); }
  .more-menu.visible { display:grid; }
  .more-menu button { text-align:left; }
`;

export class PageSelectionToolbar {
  private host: HTMLDivElement | null = null;
  private context: PageSelectionContext | null = null;

  constructor(private readonly onAction: (message: PageContextActionMessage) => void) {}

  hide(): void {
    this.host?.remove();
    this.host = null;
    this.context = null;
  }

  contains(target: EventTarget | null): boolean {
    return Boolean(target && this.host?.contains(target as Node));
  }

  show(context: PageSelectionContext): void {
    this.hide();
    this.context = context;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:auto;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOOLBAR_CSS;
    shadow.appendChild(style);

    const wrapper = makeElement('div', 'toolbar');
    const actions = makeElement('div', 'actions');
    const ask = makeElement('button', 'primary', '问 AI');
    const explain = makeElement('button', '', '解释');
    const addTopic = makeElement('button', '', '加入专题');
    const more = makeElement('button', '', '更多');
    actions.append(ask, explain, addTopic, more);
    const menu = makeElement('div', 'more-menu');
    const summarize = makeElement('button', '', '总结选区');
    const extractPoints = makeElement('button', '', '提取要点');
    menu.append(summarize, extractPoints);
    const askRow = makeElement('div', 'ask-row');
    const input = makeElement('input');
    input.placeholder = '针对选中内容提问';
    input.setAttribute('aria-label', '针对选中内容提问');
    const send = makeElement('button', 'primary', '发送');
    const cancel = makeElement('button', '', '取消');
    askRow.append(input, send, cancel);
    wrapper.append(actions, askRow, menu);
    shadow.appendChild(wrapper);
    document.documentElement.appendChild(host);
    this.host = host;

    const emit = (action: PageContextAction, question?: string) => {
      if (!this.context) return;
      this.onAction({ type: 'PAGE_CONTEXT_ACTION', action, question, context: this.context });
      this.hide();
    };
    ask.addEventListener('click', () => {
      actions.classList.add('hidden');
      askRow.classList.add('visible');
      input.focus();
    });
    explain.addEventListener('click', () => emit('explain'));
    addTopic.addEventListener('click', () => emit('add_to_topic'));
    summarize.addEventListener('click', () => emit('summarize'));
    extractPoints.addEventListener('click', () => emit('extract_points'));
    more.addEventListener('click', () => menu.classList.toggle('visible'));
    cancel.addEventListener('click', () => this.hide());
    send.addEventListener('click', () => {
      const question = input.value.trim();
      if (question) emit('ask', question);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const question = input.value.trim();
        if (question) emit('ask', question);
      } else if (event.key === 'Escape') {
        this.hide();
      }
    });
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    requestAnimationFrame(() => this.position(context, wrapper));
  }

  private position(context: PageSelectionContext, wrapper: HTMLElement): void {
    if (!this.host) return;
    const margin = 8;
    const width = wrapper.offsetWidth || 320;
    const height = wrapper.offsetHeight || 40;
    const center = context.rect.x + context.rect.width / 2;
    const left = Math.min(window.innerWidth - width - margin, Math.max(margin, center - width / 2));
    const above = context.rect.y - height - margin;
    const top = above >= margin
      ? above
      : Math.min(window.innerHeight - height - margin, context.rect.y + context.rect.height + margin);
    this.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}

export function locatePageSelection(context: PageSelectionContext): boolean {
  document.getElementById(HIGHLIGHT_ID)?.remove();
  let target: Element | null = null;
  if (context.selector) {
    try {
      target = document.querySelector(context.selector);
    } catch {
      target = null;
    }
  }
  if (!target) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const needle = normalizeText(context.text).slice(0, 80);
    while (walker.nextNode()) {
      if (normalizeText(walker.currentNode.textContent || '').includes(needle)) {
        target = walker.currentNode.parentElement;
        break;
      }
    }
  }
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const outline = document.createElement('div');
  outline.id = HIGHLIGHT_ID;
  const rect = target.getBoundingClientRect();
  outline.style.cssText = [
    'position:fixed',
    `left:${Math.max(0, rect.left - 4)}px`,
    `top:${Math.max(0, rect.top - 4)}px`,
    `width:${Math.max(8, rect.width + 8)}px`,
    `height:${Math.max(8, rect.height + 8)}px`,
    'border:2px solid #6558f5',
    'background:rgba(101,88,245,.08)',
    'pointer-events:none',
    'z-index:2147483646',
    'border-radius:4px',
  ].join(';');
  document.documentElement.appendChild(outline);
  window.setTimeout(() => outline.remove(), 2400);
  return true;
}
