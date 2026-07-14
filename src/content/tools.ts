
/**
 * 处理工具执行
 */
import type { BrowserObservation, BrowserPageRegion, BrowserPageRegionType, BrowserPageState, ElementBox, ElementPurpose, ObservedElement } from '../shared/automationTypes';

export interface ConsoleErrorEntry {
  id: string;
  level: 'error';
  source: 'console.error' | 'window.error' | 'unhandledrejection' | 'resource';
  message: string;
  stack?: string;
  url: string;
  title: string;
  timestamp: number;
  line?: number;
  column?: number;
  resourceUrl?: string;
  tagName?: string;
}

const MAX_CONSOLE_ERRORS = 100;
const consoleErrorBuffer: ConsoleErrorEntry[] = [];
const observedElementRegistry = new Map<string, Element>();

function stringifyConsoleValue(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushConsoleError(entry: Omit<ConsoleErrorEntry, 'id' | 'url' | 'title' | 'timestamp'> & Partial<Pick<ConsoleErrorEntry, 'url' | 'title' | 'timestamp'>>) {
  const nextEntry: ConsoleErrorEntry = {
    id: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    ...entry,
  };

  consoleErrorBuffer.push(nextEntry);
  if (consoleErrorBuffer.length > MAX_CONSOLE_ERRORS) {
    consoleErrorBuffer.splice(0, consoleErrorBuffer.length - MAX_CONSOLE_ERRORS);
  }
}

export function recordConsoleError(entry: Omit<ConsoleErrorEntry, 'id' | 'url' | 'title' | 'timestamp'> & Partial<Pick<ConsoleErrorEntry, 'url' | 'title' | 'timestamp'>>) {
  pushConsoleError(entry);
}

export function getConsoleErrors(args: any = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit || 30), MAX_CONSOLE_ERRORS));
  const since = Number(args.since || 0);
  const errors = consoleErrorBuffer
    .filter((entry) => !since || entry.timestamp >= since)
    .slice(-limit);

  return {
    success: true,
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    note: '只能捕获插件注入后发生的 console.error、window.error、unhandledrejection 和资源加载错误。',
    count: errors.length,
    errors,
  };
}

export async function handleToolExecution(toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'observe_page':
      return await observePage(args);
    case 'click_element':
      return await clickElement(args);
    case 'double_click':
      return await clickElement({ ...args, clickCount: 2 });
    case 'right_click':
      return await clickElement({ ...args, button: 'right' });
    case 'click_by_coordinate':
      return await clickElement({ ...args, selector: undefined, elementId: undefined, text: undefined });
    case 'get_search_results':
      return getSearchResults(args);
    case 'click_search_result':
      return await clickSearchResult(args);
    case 'click_first_search_result':
      return await clickFirstSearchResult(args);
    case 'type_text':
      return await typeText(args);
    case 'clear_input':
      return await clearInput(args);
    case 'focus_element':
      return await focusElement(args);
    case 'keyboard_shortcut':
      return await keyboardShortcut(args);
    case 'press_key':
      return await pressKey(args);
    case 'select_option':
      return await selectOption(args);
    case 'check_element':
      return await checkElement(args);
    case 'hover_element':
      return await hoverElement(args);
    case 'drag_element':
      return await dragElement(args);
    case 'upload_file':
      return await uploadFile(args);
    case 'assert_page':
      return await assertPage(args);
    case 'get_page_info':
      return await getPageInfo(args);
    case 'get_text':
      return await getText(args);
    case 'get_value':
      return await getValue(args);
    case 'query_elements':
      return await queryElements(args);
    case 'scroll_page':
      return await scrollPage(args);
    case 'wait_for_element':
      return await waitForElement(args);
    case 'screenshot':
      return await takeScreenshot(args);
    case 'fill_form':
      return await fillForm(args);
    case 'extract_page_overview':
      return extractPageOverview();
    case 'extract_page_tables':
      return extractPageTables();
    case 'extract_page_fields':
      return extractPageFields();
    case 'extract_page_lists':
      return extractPageLists();
    case 'extract_page_structured_data':
      return extractPageStructuredData();
    case 'get_console_errors':
      return getConsoleErrors(args);
    default:
      throw new Error(`未知的工具: ${toolName}`);
  }
}

/**
 * 填写表单
 */
async function fillForm(args: any): Promise<any> {
  const { selector, value, formType = 'text', selectBy = 'value', clear = false } = args;
  
  if (!selector && !args.elementId) throw new Error('Selector or elementId is required');

  if (args.waitForElement !== false) {
    try {
      await waitForElement({ selector, elementId: args.elementId, timeout: args.timeoutMs || 5000 });
    } catch (e) {}
  }

  const element = resolveTargetElement(args) as HTMLElement;
  if (!element) throw new Error(`Element not found: ${selector}`);

  // 确保可见
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(r => setTimeout(r, 100));

  if (formType === 'text') {
    // 文本输入
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    if (clear) input.value = '';
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } 
  else if (formType === 'checkbox' || formType === 'radio') {
    // 复选/单选
    // 如果 value 是 "true" 或 true，则选中；否则取消选中 (仅 Checkbox)
    // 对于 Radio，通常是点击它
    if (formType === 'radio') {
      element.click();
    } else {
      const input = element as HTMLInputElement;
      const shouldCheck = value === true || value === 'true';
      if (input.checked !== shouldCheck) {
        input.click();
      }
    }
  }
  else if (formType === 'select') {
    // 下拉列表
    const select = element as HTMLSelectElement;
    let targetIndex = -1;

    if (selectBy === 'index') {
      targetIndex = parseInt(value, 10);
    } else if (selectBy === 'value') {
      targetIndex = Array.from(select.options).findIndex(opt => opt.value === value);
    } else if (selectBy === 'text') {
      targetIndex = Array.from(select.options).findIndex(opt => opt.text === value);
    }

    if (targetIndex >= 0 && targetIndex < select.options.length) {
      select.selectedIndex = targetIndex;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      throw new Error(`Option not found by ${selectBy}: ${value}`);
    }
  }

  return { success: true, message: 'Form filled' };
}

async function getText(args: any): Promise<any> {
  const selector = args?.selector;
  const el = resolveTargetElement(args);
  if (!el) {
    throw new Error(`未找到元素: ${selector}`);
  }
  return { selector, text: (el.textContent || '').trim() };
}

async function getValue(args: any): Promise<any> {
  const selector = args?.selector;
  const el = resolveTargetElement(args) as any;
  if (!el) {
    throw new Error(`未找到元素: ${selector}`);
  }
  const value = typeof el.value === 'string' ? el.value : null;
  return { selector, value };
}

/**
 * 点击元素
 */
async function clickElement(args: any): Promise<any> {
  let element: Element | null = resolveTargetElement(args);

  if (!element && args.selector) {
    if (args.waitForElement !== false) {
       // 默认等待元素，除非明确设为 false
       try {
         await waitForElement({ selector: args.selector, timeout: args.timeoutMs || 5000 });
       } catch (e) {
         // 即使等待超时，也尝试直接获取，或许在
       }
    }
    element = document.querySelector(args.selector);
  } else if (!element && args.text) {
    // 查找包含文本的元素
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent?.includes(args.text)) {
        element = node.parentElement;
        break;
      }
    }
  } else if (!element && args.x !== undefined && args.y !== undefined) {
    element = document.elementFromPoint(args.x, args.y);
  }

  if (!element) {
    throw new Error(targetNotFoundMessage('未找到目标元素'));
  }

  // 确保元素可见
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 100));

  const buttonMap: Record<string, number> = { 'left': 0, 'middle': 1, 'right': 2 };
  const button = buttonMap[args.button || 'left'] || 0;
  
  const clickCount = args.clickCount || 1;

  for (let i = 0; i < clickCount; i++) {
    dispatchPointerMouseSequence(element, 'click', button, i + 1);
    
    if (button === 2) {
      // 如果是右键，通常还需要触发 contextmenu
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: 2,
        button: 2
      }));
    }
    
    if (i < clickCount - 1) await new Promise(r => setTimeout(r, 50));
  }
  
  return { success: true, message: '点击成功', selector: generateSelector(element) };
}

/**
 * 输入文本
 */
async function typeText(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLInputElement | HTMLTextAreaElement;
  if (!element) {
    throw new Error(targetNotFoundMessage(`未找到输入框: ${args.selector || args.elementId || args.text || ''}`));
  }

  // 确保元素可见
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 100));

  element.focus();

  if (args.clear !== false) {
    if (typeof element.select === 'function') element.select();
    element.value = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }

  // 支持输入延迟
  const delay = args.delay || 0;
  if (delay > 0) {
    for (const char of args.text) {
      element.value += char;
      element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await new Promise(r => setTimeout(r, delay));
    }
  } else {
    element.value = args.text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: args.text, inputType: 'insertText' }));
  }
  
  // 触发输入事件
  element.dispatchEvent(new Event('change', { bubbles: true }));

  return { success: true, message: '输入成功', selector: args.selector };
}

async function clearInput(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  if (!element) throw new Error(targetNotFoundMessage(`未找到输入框: ${args.selector || args.elementId || args.text || ''}`));
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 80));
  (element as HTMLElement).focus?.();
  if ('value' in element) {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    if (typeof input.select === 'function') input.select();
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    element.textContent = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }
  return { success: true, message: '已清空输入', selector: generateSelector(element) };
}

async function focusElement(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLElement | null;
  if (!element) throw new Error(targetNotFoundMessage('未找到聚焦目标'));
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 80));
  element.focus?.();
  return { success: true, message: '已聚焦元素', selector: generateSelector(element) };
}

async function keyboardShortcut(args: any): Promise<any> {
  const target = resolveTargetElement(args) as HTMLElement | null;
  const element = target || document.activeElement || document.body;
  const keys: string[] = Array.isArray(args.keys)
    ? args.keys.map(String)
    : String(args.key || args.value || '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!keys.length) throw new Error('缺少快捷键');
  const key = keys[keys.length - 1];
  const lower = keys.map((item) => item.toLowerCase());
  const init = {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: lower.includes('ctrl') || lower.includes('control'),
    metaKey: lower.includes('meta') || lower.includes('cmd') || lower.includes('command'),
    altKey: lower.includes('alt') || lower.includes('option'),
    shiftKey: lower.includes('shift'),
  };
  (element as HTMLElement).focus?.();
  element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
  return { success: true, message: `已发送快捷键 ${keys.join('+')}` };
}

function getAllElementsIncludingShadow(root: ParentNode = document): Element[] {
  const elements = Array.from(root.querySelectorAll('*'));
  const shadowElements = elements.flatMap((element) => {
    const shadowRoot = (element as HTMLElement).shadowRoot;
    return shadowRoot ? getAllElementsIncludingShadow(shadowRoot) : [];
  });
  return [...elements, ...shadowElements];
}

function getElementRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit') return 'button';
    return 'textbox';
  }
  if (tag === 'table') return 'table';
  if (element.getAttribute('aria-modal') === 'true') return 'dialog';
  return tag;
}

function isInteractiveElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const role = getElementRole(element);
  if (['a', 'button', 'input', 'textarea', 'select', 'option', 'table', 'nav', 'aside'].includes(tag)) return true;
  if (['button', 'link', 'textbox', 'checkbox', 'radio', 'select', 'menuitem', 'tab', 'dialog', 'grid', 'table'].includes(role)) return true;
  if (element.hasAttribute('onclick') || element.hasAttribute('contenteditable')) return true;
  const tabIndex = (element as HTMLElement).tabIndex;
  return tabIndex >= 0;
}

function isNavigationCandidateElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const role = getElementRole(element);
  const text = getCleanText(element);
  if (!text || text.length > 80) return false;
  if (['script', 'style', 'svg', 'path'].includes(tag)) return false;
  if (['menuitem', 'tab', 'treeitem', 'link'].includes(role)) return true;
  const className = String((element as HTMLElement).className || '').toLowerCase();
  const parentClassName = String((element.parentElement as HTMLElement | null)?.className || '').toLowerCase();
  const context = `${className} ${parentClassName}`;
  if (/(menu|nav|sidebar|sider|aside|tabs?|breadcrumb|submenu|ant-menu|el-menu)/.test(context)) return true;
  return Boolean(element.closest('aside,nav,[role="menu"],[role="navigation"],[class*="menu"],[class*="sidebar"],[class*="sider"],[class*="layout-sider"],.ant-menu,.el-menu'));
}

function isEnabledElement(element: Element): boolean {
  const el = element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
  return !el.disabled && element.getAttribute('aria-disabled') !== 'true';
}

function getElementValue(element: Element): string | undefined {
  const el = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (typeof el.value === 'string') return el.value;
  const role = element.getAttribute('role');
  const className = String((element as HTMLElement).className || '');
  if (role === 'combobox' || /(ant-select|el-select|select)/i.test(className)) {
    const selected = element.querySelector(
      '.ant-select-selection-item,.el-select__selected-item,[aria-selected="true"],[role="option"][aria-selected="true"]',
    );
    const text = getCleanText(selected || element);
    return text || undefined;
  }
  return undefined;
}

function getElementDescriptor(element: Element): string {
  const el = element as HTMLInputElement | HTMLButtonElement | HTMLAnchorElement;
  return [
    element.tagName.toLowerCase(),
    element.id,
    element.getAttribute('name'),
    element.getAttribute('type'),
    element.getAttribute('role'),
    (element as HTMLElement).className,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('data-testid'),
    element.getAttribute('data-test'),
    element.getAttribute('data-cy'),
    element.getAttribute('data-icon'),
    element.getAttribute('aria-describedby'),
    element.querySelector('svg')?.getAttribute('data-icon'),
    element.querySelector('use')?.getAttribute('href'),
    element.parentElement?.getAttribute('aria-label'),
    element.parentElement?.getAttribute('title'),
    element.parentElement?.getAttribute('data-testid'),
    element.closest('[role="tooltip"],.ant-tooltip,.el-tooltip')?.textContent,
    element.closest('.ant-dropdown,.el-dropdown,.dropdown,.menu,.ant-menu,.el-menu')?.textContent,
    (el as HTMLInputElement).placeholder,
    (el as HTMLInputElement | HTMLButtonElement).value,
    getCleanText(element.parentElement).slice(0, 120),
    getCleanText(element),
  ].filter(Boolean).join(' ').toLowerCase();
}

function getNavigationParentText(element: Element): string | undefined {
  const parentMenu = element.parentElement?.closest?.('li,[role="menuitem"],.ant-menu-submenu,.el-sub-menu,.menu-item,[class*="submenu"]');
  const parent = parentMenu?.parentElement?.closest?.('li,[role="menuitem"],.ant-menu-submenu,.el-sub-menu,.menu-item,[class*="submenu"]');
  const text = getCleanText(parent).slice(0, 80);
  return text && text !== getCleanText(element).slice(0, 80) ? text : undefined;
}

function getNavigationLevel(element: Element): number | undefined {
  const ariaLevel = element.getAttribute('aria-level');
  if (ariaLevel && Number.isFinite(Number(ariaLevel))) return Number(ariaLevel);
  if (!element.closest('aside,[class*="sider"],[class*="sidebar"],.ant-menu,.el-menu,[role="menu"]')) return undefined;
  let level = 1;
  let current = element.parentElement;
  while (current && current !== document.body) {
    if (current.matches('ul,ol,[role="menu"],.ant-menu-sub,.el-menu')) level += 1;
    current = current.parentElement;
  }
  return Math.min(level, 8);
}

function isElementExpanded(element: Element): boolean | undefined {
  const expanded = element.getAttribute('aria-expanded');
  if (expanded === 'true') return true;
  if (expanded === 'false') return false;
  const className = String((element as HTMLElement).className || '');
  if (/(open|opened|expanded|active|selected|ant-menu-submenu-open|el-sub-menu.is-open)/i.test(className)) return true;
  return undefined;
}

function isElementActive(element: Element): boolean | undefined {
  const current = element.getAttribute('aria-current');
  if (current && current !== 'false') return true;
  if (element.getAttribute('aria-selected') === 'true') return true;
  const className = String((element as HTMLElement).className || '');
  if (/(active|selected|current|ant-menu-item-selected|router-link-active|is-active)/i.test(className)) return true;
  return undefined;
}

function elementBox(element: Element): ElementBox {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function inferElementRegion(element: Element): BrowserPageRegionType {
  if (element.closest('[role="dialog"],[aria-modal="true"],.ant-modal,.modal,.el-dialog')) return 'modal';
  if (element.closest('aside,[class*="sidebar"],[class*="sider"],.ant-layout-sider,.el-aside')) return 'sidebar';
  if (element.closest('#content_left,#search,#rso,#b_results,.b_results,.result,[class*="result"],.b_algo,ytd-search,ytd-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer')) return 'search_results';
  if (element.closest('.ant-table,table,[role="table"],[role="grid"]')) return 'table_area';
  if (element.closest('header,nav,[role="navigation"],#s-top-left,#u1,[class*="header"],[class*="navbar"],[class*="top-nav"]')) return 'top_nav';
  if (element.closest('footer,[class*="footer"]')) return 'footer';
  if (element.closest('main,#main,#app,.app,.content,[class*="content"],[class*="main"]')) return 'main';
  return 'unknown';
}

function getElementContext(element: Element): string {
  const region = inferElementRegion(element);
  const parentText = getCleanText(element.parentElement).slice(0, 180);
  const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
    .filter((item) => isVisibleElement(item) && item.getBoundingClientRect().y <= element.getBoundingClientRect().y)
    .map(getCleanText)
    .filter(Boolean)
    .slice(-1)[0];
  return [region, heading, parentText].filter(Boolean).join(' | ').slice(0, 260);
}

function collectPageRegions(): BrowserPageRegion[] {
  const selectors: Array<{ type: BrowserPageRegionType; selector: string }> = [
    { type: 'modal', selector: '[role="dialog"],[aria-modal="true"],.ant-modal,.modal,.el-dialog' },
    { type: 'top_nav', selector: 'header,nav,[role="navigation"],#s-top-left,#u1,[class*="header"],[class*="navbar"],[class*="top-nav"]' },
    { type: 'sidebar', selector: 'aside,[class*="sidebar"],[class*="sider"],.ant-layout-sider,.el-aside' },
    { type: 'search_results', selector: '#content_left,#search,#rso,#b_results,.b_results,ytd-search,ytd-item-section-renderer,#contents' },
    { type: 'table_area', selector: '.ant-table,table,[role="table"],[role="grid"]' },
    { type: 'form_area', selector: 'form,.ant-form,.el-form,[role="form"],[class*="form"],[class*="filter"],[class*="search"]' },
    { type: 'main', selector: 'main,#main,#app,.app,.content,[class*="content"],[class*="main"]' },
    { type: 'footer', selector: 'footer,[class*="footer"]' },
  ];
  const regions: BrowserPageRegion[] = [];
  const seen = new Set<Element>();
  selectors.forEach((item) => {
    document.querySelectorAll(item.selector).forEach((element) => {
      if (seen.has(element) || !isVisibleElement(element)) return;
      seen.add(element);
      regions.push({
        type: item.type,
        selector: generateSelector(element),
        text: getCleanText(element).slice(0, 300),
        bbox: elementBox(element),
      });
    });
  });
  return regions.slice(0, 30);
}

function hasNearbySearchSubmit(element: Element): boolean {
  let container: Element | null = element.parentElement;
  for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
    const candidates = container.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]');
    if (Array.from(candidates).some((candidate) => (
      /(百度一下|搜索|查询|search|submit|go|🔍)/i.test(getElementDescriptor(candidate))
    ))) return true;
  }
  return false;
}

function inferElementPurpose(element: Element, role: string): { purpose: ElementPurpose; score: number } {
  const tag = element.tagName.toLowerCase();
  const descriptor = getElementDescriptor(element);
  const compactDescriptor = descriptor.replace(/\s+/g, '');
  const input = element as HTMLInputElement;
  const isTextEntry = role === 'textbox'
    || tag === 'textarea'
    || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes((input.type || 'text').toLowerCase()));
  const downloadPattern = /(下载|导出|导出excel|导出csv|下载报表|download|export|download-outlined|export-outlined|file-excel|excel|csv)/i;

  if (tag === 'table' || role === 'table' || role === 'grid') {
    return { purpose: 'table', score: 0.85 };
  }

  if (isNavigationCandidateElement(element)) {
    const score = /(menu|nav|sidebar|sider|aside|ant-menu|el-menu)/i.test(descriptor) ? 0.82 : 0.68;
    return { purpose: role === 'tab' ? 'navigation_item' : 'menu_item', score };
  }

  if (isTextEntry && (
    /(搜索|search|查询|关键字|关键词|keyword|query|\bwd\b|\bq\b)/i.test(descriptor)
    || hasNearbySearchSubmit(element)
  )) {
    let score = 0.76;
    if (input.id === 'kw' || input.name === 'wd' || input.name === 'q' || input.type === 'search') score = 0.98;
    if (/请输入|搜索|search/.test(input.placeholder || '')) score = Math.max(score, 0.9);
    return { purpose: 'search_input', score };
  }

  if (role === 'button' || tag === 'button' || (tag === 'input' && ['button', 'submit'].includes((input.type || '').toLowerCase()))) {
    if (/(百度一下|搜索|查询|search|submit|go|🔍)/i.test(descriptor)) {
      let score = 0.78;
      if (element.id === 'su' || input.value === '百度一下') score = 0.98;
      return { purpose: 'search_button', score };
    }
    if (/(删除|作废|移除|delete|remove|void)/i.test(descriptor)) {
      return { purpose: 'delete_button', score: 0.86 };
    }
    if (/(保存|save)/i.test(descriptor)) {
      return { purpose: 'save_button', score: 0.78 };
    }
    if (/(提交|确定|确认|下一步|完成|发送|支付|购买|submit|ok|confirm|next|send|pay|buy)/i.test(descriptor)) {
      return { purpose: 'submit_button', score: 0.76 };
    }
    if (/(登录|登陆|sign in|login)/i.test(descriptor)) {
      return { purpose: 'login_button', score: 0.82 };
    }
    if (downloadPattern.test(descriptor) || downloadPattern.test(compactDescriptor)) {
      return { purpose: 'download_button', score: 0.9 };
    }
    if (/(关闭|取消|close|cancel|×|\b x \b)/i.test(` ${descriptor} `)) {
      return { purpose: 'close_modal', score: 0.72 };
    }
  }

  if ((role === 'link' || tag === 'a') && (downloadPattern.test(descriptor) || downloadPattern.test(compactDescriptor))) {
    return { purpose: 'download_button', score: 0.76 };
  }

  if (/(分页|上一页|下一页|page|pagination)/i.test(descriptor)) {
    return { purpose: 'pagination', score: 0.72 };
  }

  return { purpose: 'generic', score: 0.35 };
}

function getObservationCandidatePriority(element: Element, role: string, purpose: ElementPurpose, purposeScore: number, sourceIndex: number): number {
  const rect = elementBox(element);
  const tag = element.tagName.toLowerCase();
  const purposePriority: Record<string, number> = {
    download_button: 1000,
    search_input: 930,
    search_button: 920,
    delete_button: 880,
    danger_button: 870,
    save_button: 850,
    submit_button: 830,
    login_button: 820,
    menu_item: 760,
    navigation_item: 750,
    pagination: 620,
    table: 500,
    close_modal: 430,
    generic: 120,
  };
  let priority = purposePriority[purpose] ?? 100;
  if (role === 'button' || tag === 'button') priority += 80;
  if (role === 'link' || tag === 'a') priority += 35;
  if (role === 'textbox' || tag === 'input' || tag === 'textarea') priority += 45;
  if (isEnabledElement(element)) priority += 20;
  priority += purposeScore * 100;
  if (rect.y >= 0 && rect.y < Math.max(window.innerHeight || 0, 800)) priority += 30;
  return priority - sourceIndex * 0.001;
}

function inferPageState(elements: ObservedElement[]): BrowserPageState {
  const bodyText = document.body.innerText?.replace(/\s+/g, ' ').slice(0, 5000) || '';
  const url = window.location.href;
  const title = document.title || '';
  const searchInput = elements
    .filter((element) => element.purpose === 'search_input')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const searchButton = elements
    .filter((element) => element.purpose === 'search_button')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const mainInput = searchInput || elements.find((element) => element.role === 'textbox' && element.visible && element.enabled);
  const primaryButton = searchButton || elements
    .filter((element) => ['search_button', 'submit_button', 'save_button', 'delete_button', 'danger_button', 'login_button'].includes(element.purpose || ''))
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    || elements.find((element) => element.role === 'button' && element.visible && element.enabled);
  const hasCaptcha = /(验证码|captcha|滑块|人机验证|安全验证)/i.test(bodyText);
  const hasLoginSignal = /(登录|登陆|扫码登录|账号登录|sign in|login)/i.test(`${title} ${bodyText}`);
  const hasPermissionDenied = /(无权限|权限不足|没有权限|未授权|403|forbidden|access denied|permission denied)/i.test(`${title} ${bodyText}`);
  const hasEmptyState = /(暂无数据|无数据|没有数据|空数据|empty|no data|not found)/i.test(bodyText);
  const hasModal = Boolean(document.querySelector('[role="dialog"],[aria-modal="true"],.ant-modal,.modal,.el-dialog'));
  const hasTable = elements.some((element) => element.purpose === 'table');

  let kind: BrowserPageState['kind'] = 'unknown';
  if (hasPermissionDenied) kind = 'permission_page';
  else if (/baidu\.com\/s\?|bing\.com\/search|google\.[^/]+\/search|youtube\.com\/results/i.test(url)) kind = 'result_page';
  else if (hasLoginSignal && !mainInput) kind = 'login_page';
  else if (searchInput) kind = 'search_page';
  else if (hasTable) kind = 'table_page';
  else if (hasEmptyState) kind = 'empty_page';
  else if (elements.some((element) => element.role === 'textbox' || element.role === 'select' || element.role === 'checkbox')) kind = 'form_page';

  return {
    kind,
    hasModal,
    hasCaptcha,
    hasLoginSignal,
    hasPermissionDenied,
    hasEmptyState,
    mainInputId: mainInput?.elementId,
    primaryButtonId: primaryButton?.elementId,
    searchInputId: searchInput?.elementId,
    searchButtonId: searchButton?.elementId,
  };
}

function makeCssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const currentTag = current.tagName;
    const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === currentTag);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }
  return parts.join(' > ');
}

function getCandidateSelectors(element: Element): string[] {
  const selectors: string[] = [];
  const escapeCss = (value: string) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/["\\]/g, '\\$&');
  };
  const id = element.id;
  if (id) selectors.push(`#${escapeCss(id)}`);
  ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'title'].forEach((attr) => {
    const value = element.getAttribute(attr);
    if (value) selectors.push(`${element.tagName.toLowerCase()}[${attr}="${escapeCss(value)}"]`);
  });
  const role = element.getAttribute('role');
  if (role) selectors.push(`[role="${escapeCss(role)}"]`);
  const generated = generateSelector(element);
  if (generated) selectors.push(generated);
  selectors.push(makeCssPath(element));
  return Array.from(new Set(selectors.filter(Boolean)));
}

function registerObservedElement(element: Element, index: number): string {
  const stableSource = [
    window.location.pathname,
    element.tagName.toLowerCase(),
    element.id,
    element.getAttribute('name'),
    element.getAttribute('aria-label'),
    getCleanText(element).slice(0, 40),
    index,
  ].filter(Boolean).join('|');
  let hash = 0;
  for (let i = 0; i < stableSource.length; i += 1) {
    hash = ((hash << 5) - hash + stableSource.charCodeAt(i)) | 0;
  }
  const elementId = `el_${Math.abs(hash).toString(36)}_${index}`;
  observedElementRegistry.set(elementId, element);
  return elementId;
}

function resolveTargetElement(args: any): Element | null {
  if (args?.elementId) {
    const cached = observedElementRegistry.get(String(args.elementId));
    if (cached && document.contains(cached)) return cached;
  }
  if (args?.selector) {
    const found = document.querySelector(String(args.selector));
    if (found) return found;
  }
  if (args?.text) {
    const text = String(args.text);
    const element = getAllElementsIncludingShadow(document.body).find((el) => isVisibleElement(el) && getCleanText(el).includes(text));
    if (element) return element;
  }
  if (args?.role || args?.purpose) {
    const element = getAllElementsIncludingShadow(document.body).find((el) => {
      if (!isVisibleElement(el)) return false;
      const roleMatched = args.role ? getElementRole(el) === String(args.role) : true;
      const purposeMatched = args.purpose ? inferElementPurpose(el, getElementRole(el)).purpose === String(args.purpose) : true;
      return roleMatched && purposeMatched;
    });
    if (element) return element;
  }
  if (args?.x !== undefined && args?.y !== undefined) {
    return document.elementFromPoint(Number(args.x), Number(args.y));
  }
  return null;
}

function targetNotFoundMessage(defaultMessage: string): string {
  const iframes = Array.from(document.querySelectorAll('iframe')).filter(isVisibleElement);
  if (!iframes.length) return defaultMessage;
  const crossOriginCount = iframes.filter((frame) => {
    try {
      void (frame as HTMLIFrameElement).contentDocument?.body;
      return false;
    } catch {
      return true;
    }
  }).length;
  if (crossOriginCount > 0) {
    return `${defaultMessage}。当前页面包含 ${iframes.length} 个 iframe，其中 ${crossOriginCount} 个疑似跨域，扩展无法直接操作跨域 iframe 内元素。`;
  }
  return `${defaultMessage}。当前页面包含 ${iframes.length} 个 iframe，目标可能在 iframe 内，请补充更明确的选择器或先切换到目标内容区域。`;
}

export async function observePage(args: any = {}): Promise<BrowserObservation> {
  observedElementRegistry.clear();
  const limit = Math.max(1, Math.min(Number(args.limit || 80), 650));
  const candidates = getAllElementsIncludingShadow(document.body)
    .filter((element) => (isInteractiveElement(element) || isNavigationCandidateElement(element)) && isVisibleElement(element))
    .map((element, sourceIndex) => {
      const role = getElementRole(element);
      const purpose = inferElementPurpose(element, role);
      return {
        element,
        sourceIndex,
        role,
        purpose,
        priority: getObservationCandidatePriority(element, role, purpose.purpose, purpose.score, sourceIndex),
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
  const elements: ObservedElement[] = candidates.map(({ element, sourceIndex, role, purpose }) => {
    const selectors = getCandidateSelectors(element);
    return {
      elementId: registerObservedElement(element, sourceIndex),
      role,
      tag: element.tagName.toLowerCase(),
      text: getCleanText(element).slice(0, 500),
      selector: selectors[0] || element.tagName.toLowerCase(),
      selectors,
      selectorCandidates: selectors,
      bbox: elementBox(element),
      visible: isVisibleElement(element),
      enabled: isEnabledElement(element),
      value: getElementValue(element),
      checked: typeof (element as HTMLInputElement).checked === 'boolean' ? (element as HTMLInputElement).checked : undefined,
      href: (element as HTMLAnchorElement).href || undefined,
      placeholder: (element as HTMLInputElement).placeholder || undefined,
      name: (element as HTMLInputElement).name || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      title: element.getAttribute('title') || undefined,
      required: (element as HTMLInputElement).required || element.getAttribute('aria-required') === 'true' || undefined,
      purpose: purpose.purpose,
      score: purpose.score,
      region: inferElementRegion(element),
      context: getElementContext(element),
      clickable: isInteractiveElement(element),
      parentText: getNavigationParentText(element),
      level: getNavigationLevel(element),
      expanded: isElementExpanded(element),
      active: isElementActive(element),
      framePath: [],
      shadowPath: (element.getRootNode() instanceof ShadowRoot) ? ['shadow-root'] : undefined,
    };
  });
  const pageState = inferPageState(elements);
  const regions = collectPageRegions();

  return {
    success: true,
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    },
    elements,
    regions,
    pageState,
    capturedAt: Date.now(),
  };
}

function dispatchPointerMouseSequence(element: Element, type: 'click' | 'hover' | 'drag', button = 0, detail = 1, to?: { x: number; y: number }) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const eventWindow = element.ownerDocument.defaultView || window;
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: button === 0 ? 1 : 2, detail };
  const PointerEventCtor = eventWindow.PointerEvent || (typeof PointerEvent !== 'undefined' ? PointerEvent : undefined);
  const MouseEventCtor = eventWindow.MouseEvent || MouseEvent;
  const DragEventCtor = eventWindow.DragEvent || (typeof DragEvent !== 'undefined' ? DragEvent : undefined);
  if (PointerEventCtor) {
    try {
      element.dispatchEvent(new PointerEventCtor('pointerover', init));
      element.dispatchEvent(new PointerEventCtor('pointerenter', init));
      element.dispatchEvent(new PointerEventCtor('pointerdown', init));
    } catch {}
  }
  element.dispatchEvent(new MouseEventCtor('mouseover', init));
  element.dispatchEvent(new MouseEventCtor('mousemove', init));
  if (type === 'hover') return;
  element.dispatchEvent(new MouseEventCtor('mousedown', init));
  if (type === 'drag' && to) {
    const moveInit = { ...init, clientX: to.x, clientY: to.y };
    element.dispatchEvent(new MouseEventCtor('mousemove', moveInit));
    if (DragEventCtor) {
      element.dispatchEvent(new DragEventCtor('drag', { bubbles: true, cancelable: true }));
    }
  }
  if (PointerEventCtor) {
    try {
      element.dispatchEvent(new PointerEventCtor('pointerup', init));
    } catch {}
  }
  element.dispatchEvent(new MouseEventCtor('mouseup', init));
  element.dispatchEvent(new MouseEventCtor('click', init));
}

async function pressKey(args: any): Promise<any> {
  const target = resolveTargetElement(args) as HTMLElement | null;
  const element = target || document.activeElement || document.body;
  const key = String(args.key || '');
  if (!key) throw new Error('缺少 key');
  (element as HTMLElement).focus?.();
  const downEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(downEvent);
  element.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));

  if (key.toLowerCase() === 'enter' && !downEvent.defaultPrevented) {
    const inputLike = element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || (element as HTMLElement).isContentEditable;
    const form = inputLike ? element.closest('form') as HTMLFormElement | null : null;
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.submit();
      }
    }
  }
  return { success: true, message: `已按键 ${key}` };
}

async function selectOption(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLSelectElement | null;
  if (!element) throw new Error(targetNotFoundMessage('未找到下拉框'));
  if (element.tagName.toLowerCase() !== 'select') {
    const value = String(args.value ?? args.text ?? '');
    (element as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 80));
    dispatchPointerMouseSequence(element, 'click');
    await new Promise(resolve => setTimeout(resolve, 160));
    const options = getAllElementsIncludingShadow(document.body)
      .filter((item) => isVisibleElement(item))
      .filter((item) => {
        const role = getElementRole(item);
        const context = `${generateSelector(item)} ${String((item as HTMLElement).className || '')}`;
        return role === 'option'
          || item.getAttribute('aria-selected') !== null
          || /(ant-select-item-option|el-select-dropdown__item|dropdown|option)/i.test(context);
      });
    const matched = options.find((item) => getCleanText(item).includes(value));
    if (!matched) throw new Error(`未找到下拉选项: ${value}`);
    dispatchPointerMouseSequence(matched, 'click');
    return { success: true, message: '选择成功', value, selector: generateSelector(matched) };
  }
  const selectBy = args.selectBy || 'value';
  const value = String(args.value ?? '');
  const index = selectBy === 'index'
    ? Number(value)
    : Array.from(element.options).findIndex((option) => selectBy === 'text' ? option.text === value : option.value === value);
  if (index < 0 || index >= element.options.length) throw new Error(`未找到选项: ${value}`);
  element.selectedIndex = index;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, message: '选择成功', value: element.value };
}

async function checkElement(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLInputElement | null;
  if (!element) throw new Error(targetNotFoundMessage('未找到复选框/单选框'));
  const checked = args.checked !== false;
  if (element.checked !== checked) {
    element.click();
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, checked: element.checked };
}

async function hoverElement(args: any): Promise<any> {
  const element = resolveTargetElement(args);
  if (!element) throw new Error(targetNotFoundMessage('未找到悬停目标'));
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 100));
  dispatchPointerMouseSequence(element, 'hover');
  return { success: true, message: '悬停成功', selector: generateSelector(element) };
}

async function dragElement(args: any): Promise<any> {
  const element = resolveTargetElement(args);
  if (!element) throw new Error(targetNotFoundMessage('未找到拖拽目标'));
  const to = { x: Number(args.toX ?? args.x ?? 0), y: Number(args.toY ?? args.y ?? 0) };
  dispatchPointerMouseSequence(element, 'drag', 0, 1, to);
  return { success: true, message: '拖拽事件已发送', to };
}

async function uploadFile(args: any): Promise<any> {
  const element = resolveTargetElement(args) as HTMLInputElement | null;
  if (!element) throw new Error(targetNotFoundMessage('未找到文件输入框'));
  if (element.tagName.toLowerCase() !== 'input' || element.type !== 'file') {
    throw new Error('目标元素不是 file input。浏览器扩展无法直接设置任意文件路径，请使用文件输入框。');
  }
  return { success: false, error: '当前版本仅能定位文件输入框，无法在 content script 中直接注入本地文件。' };
}

async function assertPage(args: any): Promise<any> {
  const assertion = args.assertion;
  if (assertion === 'url_matches') {
    const matched = new RegExp(String(args.value || args.text || '')).test(window.location.href);
    if (!matched) throw new Error(`URL 不匹配: ${window.location.href}`);
    return { success: true, assertion };
  }
  if (assertion === 'text_exists') {
    const text = String(args.text || args.value || '');
    if (!document.body.innerText.includes(text)) throw new Error(`页面不存在文本: ${text}`);
    return { success: true, assertion };
  }
  if (assertion === 'element_exists') {
    const element = resolveTargetElement(args);
    if (!element) throw new Error('断言失败：元素不存在');
    return { success: true, assertion, selector: generateSelector(element) };
  }
  if (assertion === 'value_equals') {
    const element = resolveTargetElement(args);
    const value = element ? getElementValue(element) : undefined;
    if (value !== String(args.value || '')) throw new Error(`值不匹配: ${value}`);
    return { success: true, assertion, value };
  }
  throw new Error(`不支持的断言: ${assertion}`);
}

function isBadSearchResultAnchor(anchor: HTMLAnchorElement): boolean {
  const text = getSearchResultAnchorText(anchor);
  const href = anchor.href || '';
  if (!href || !/^https?:\/\//i.test(href)) return true;
  if (!text || /^(新闻|网页|贴吧|知道|图片|视频|地图|文库|资讯|购物|更多|设置|登录|百度首页|上一页|下一页|\d+)$/i.test(text)) return true;
  if (/hao\s*123/i.test(text)) return true;
  try {
    const url = new URL(href);
    if (/(hao123\.com|passport\.baidu\.com|help\.baidu\.com)/i.test(url.hostname)) return true;
    if (/baidu\.com$/i.test(url.hostname) && /(hao\s*123|from_pc_logon)/i.test(decodeURIComponent(url.href))) return true;
  } catch {
    return true;
  }
  const selector = generateSelector(anchor);
  if (/(^|[#.\s_-])(s-top|u1|head|header|nav|toolbar|tabs?|foot|footer|setting|user|login)([#.\s_-]|$)/i.test(selector)) return true;
  return false;
}

function getSearchResultMinY(): number {
  const input = document.querySelector('#kw, input[name="wd"], input[name="q"], input[type="search"], textarea[name="q"]') as HTMLElement | null;
  if (input && isVisibleElement(input)) {
    const rect = input.getBoundingClientRect();
    return rect.y + rect.height + 30;
  }
  return Math.max(80, Math.round(window.innerHeight * 0.1));
}

type SearchResultCandidate = {
  anchor: HTMLAnchorElement;
  container: Element;
};

function getSearchResultAnchorText(anchor: HTMLAnchorElement): string {
  return String(
    getCleanText(anchor)
    || anchor.getAttribute('title')
    || anchor.getAttribute('aria-label')
    || ''
  ).replace(/\s+/g, ' ').trim();
}

function resultAnchorPriority(anchor: HTMLAnchorElement): number {
  const selector = generateSelector(anchor);
  const closest = anchor.closest('#content_left,.result,[class*="result"],.c-container,#b_results,.b_algo,#rso,#search,ytd-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer');
  let priority = 0;
  if (anchor.closest('#content_left')) priority += 80;
  if (anchor.closest('ytd-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer')) priority += 85;
  if (anchor.closest('.result,[class*="result"],.c-container')) priority += 50;
  if (anchor.closest('h3') || anchor.querySelector('h3')) priority += 30;
  if (anchor.matches('#video-title,a#video-title-link,[href*="/watch"]')) priority += 45;
  if (closest) priority += 20;
  if (/\bh3\b/i.test(selector)) priority += 10;
  return priority;
}

function pickPrimaryResultAnchor(container: Element): HTMLAnchorElement | null {
  const selectors = [
    'a#video-title[href]',
    'a#video-title-link[href]',
    'a[href*="/watch"]',
    'h3 a[href]',
    'a[href] h3',
    '[class*="title"] a[href]',
    'a[class*="title"][href]',
    'a[href]',
  ];
  for (const selector of selectors) {
    const matched = Array.from(container.querySelectorAll<HTMLElement>(selector));
    for (const item of matched) {
      const anchor = item.tagName.toLowerCase() === 'a'
        ? item as HTMLAnchorElement
        : item.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor && isVisibleElement(anchor) && !isBadSearchResultAnchor(anchor)) return anchor;
    }
  }
  return null;
}

function collectSearchResultBlocks(): SearchResultCandidate[] {
  const blockSelectors = [
    '#content_left > .result',
    '#content_left > [class*="result"]',
    '#content_left > .c-container',
    '#content_left > div',
    '#b_results > .b_algo',
    '#rso > div',
    '#search .g',
    'ytd-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
  ];
  const blocks = new Set<Element>();
  blockSelectors.forEach((selector) => {
    document.querySelectorAll<Element>(selector).forEach((element) => blocks.add(element));
  });
  const minY = getSearchResultMinY();
  return Array.from(blocks)
    .map((container) => ({ container, anchor: pickPrimaryResultAnchor(container) }))
    .filter((item): item is SearchResultCandidate => Boolean(item.anchor))
    .filter((item) => item.anchor.getBoundingClientRect().y >= minY)
    .sort((a, b) => {
      const ra = a.container.getBoundingClientRect();
      const rb = b.container.getBoundingClientRect();
      return ra.y - rb.y || ra.x - rb.x || resultAnchorPriority(b.anchor) - resultAnchorPriority(a.anchor);
    });
}

function collectFirstSearchResultCandidates(): HTMLAnchorElement[] {
  const blockCandidates = collectSearchResultBlocks().map((item) => item.anchor);
  if (blockCandidates.length) return blockCandidates;

  const anchors = new Set<HTMLAnchorElement>();
  const anchorSelectors = [
    'ytd-video-renderer a#video-title[href]',
    'ytd-rich-item-renderer a#video-title-link[href]',
    'ytd-rich-item-renderer a#video-title[href]',
    'ytd-compact-video-renderer a#video-title[href]',
    'ytd-grid-video-renderer a#video-title[href]',
    'a[href*="/watch"]#video-title',
    '#content_left h3 a[href]',
    '#content_left .result a[href]',
    '#content_left [class*="result"] a[href]',
    '#content_left .c-container a[href]',
    '.result h3 a[href]',
    '#b_results .b_algo h2 a[href]',
    '.b_algo h2 a[href]',
  ];
  anchorSelectors.forEach((selector) => {
    document.querySelectorAll<HTMLAnchorElement>(selector).forEach((anchor) => anchors.add(anchor));
  });
  ['#search h3', '#rso h3', '#content_left h3'].forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((heading) => {
      const anchor = heading.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor) anchors.add(anchor);
    });
  });
  if (!anchors.size) {
    document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => anchors.add(anchor));
  }

  const minY = getSearchResultMinY();
  return Array.from(anchors)
    .filter((anchor) => isVisibleElement(anchor) && !isBadSearchResultAnchor(anchor))
    .filter((anchor) => anchor.getBoundingClientRect().y >= minY)
    .sort((a, b) => {
      const pa = resultAnchorPriority(a);
      const pb = resultAnchorPriority(b);
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return pb - pa || ra.y - rb.y || ra.x - rb.x;
    });
}

function getSearchResults(args: any = {}): any {
  const candidates = collectFirstSearchResultCandidates();
  const limit = Math.max(1, Math.min(Number(args?.limit || 10), 30));
  return {
    success: true,
    url: window.location.href,
    title: document.title,
    count: candidates.length,
    results: candidates.slice(0, limit).map((anchor, index) => ({
      index: index + 1,
      title: getSearchResultAnchorText(anchor),
      text: getSearchResultAnchorText(anchor),
      snippet: getCleanText(anchor.closest('.result,[class*="result"],.b_algo,#content_left,#rso,ytd-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer') || anchor.parentElement).slice(0, 240),
      url: anchor.href,
      href: anchor.href,
      elementId: registerObservedElement(anchor, index),
      selector: generateSelector(anchor),
      region: inferElementRegion(anchor),
      bbox: elementBox(anchor),
    })),
  };
}

async function clickSearchResult(args: any): Promise<any> {
  const candidates = collectFirstSearchResultCandidates();
  const index = Math.max(0, Number(args?.index || 1) - 1);
  const anchor = candidates[index];
  if (!anchor) {
    return {
      success: false,
      error: '未识别到可点击的搜索结果',
      url: window.location.href,
      title: document.title,
      candidateCount: candidates.length,
    };
  }
  anchor.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const href = anchor.href;
  window.setTimeout(() => {
    window.location.assign(href);
  }, 50);
  return {
    success: true,
    index: index + 1,
    text: getSearchResultAnchorText(anchor),
    href,
    selector: generateSelector(anchor),
    candidateCount: candidates.length,
  };
}

async function clickFirstSearchResult(args: any): Promise<any> {
  return await clickSearchResult({ ...args, index: args?.index || 1 });
}

/**
 * 获取页面信息
 */
async function getPageInfo(args: any): Promise<any> {
  const info: any = {
    url: window.location.href,
    title: document.title,
    text: document.body.innerText?.substring(0, 5000) || '', // 限制长度
  };

  if (args.include_html) {
    info.html = document.documentElement.outerHTML.substring(0, 10000); // 限制长度
  }

  return info;
}

function isVisibleElement(element: Element): boolean {
  const el = element as HTMLElement;
  let current: Element | null = el;
  while (current) {
    const currentElement = current as HTMLElement;
    if (currentElement.hidden || currentElement.getAttribute('aria-hidden') === 'true') return false;
    const currentStyle = window.getComputedStyle(currentElement);
    if (currentStyle.display === 'none' || currentStyle.visibility === 'hidden' || currentStyle.opacity === '0') return false;
    current = current.parentElement;
  }
  const rect = el.getBoundingClientRect();
  if ((rect.width > 0 && rect.height > 0) || el.getClientRects().length > 0) return true;
  // jsdom has no layout engine. Keep DOM-focused unit tests useful without
  // weakening visibility semantics in the real browser.
  if (/jsdom/i.test(window.navigator.userAgent)) {
    if (['input', 'textarea', 'select', 'button', 'a'].includes(element.tagName.toLowerCase())) return true;
    return Boolean(getCleanText(element) || element.children.length > 0);
  }
  return false;
}

function getCleanText(element: Element | null | undefined): string {
  return (element?.textContent || '').replace(/\s+/g, ' ').trim();
}

export function extractPageOverview(): any {
  return {
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    headings: Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter(isVisibleElement)
      .map(getCleanText)
      .filter(Boolean)
      .slice(0, 50),
    text: document.body.innerText?.replace(/\s+/g, ' ').trim().slice(0, 12000) || '',
  };
}

function normalizeTableRows(rows: string[][]): { headers: string[]; rows: string[][] } {
  if (rows.length === 0) return { headers: [], rows: [] };
  const [first, ...rest] = rows;
  return { headers: first, rows: rest };
}

function extractHtmlTables(): any[] {
  return Array.from(document.querySelectorAll('table'))
    .filter(isVisibleElement)
    .map((table, index) => {
      const rows = Array.from(table.querySelectorAll('tr'))
        .map((row) => Array.from(row.querySelectorAll('th,td')).map(getCleanText).filter(Boolean))
        .filter((row) => row.length > 0);
      const normalized = normalizeTableRows(rows);
      return {
        title: `Table ${index + 1}`,
        headers: normalized.headers,
        rows: normalized.rows,
        rowCount: normalized.rows.length,
        columnCount: normalized.headers.length || normalized.rows[0]?.length || 0,
        selector: generateSelector(table),
      };
    })
    .filter((table) => table.headers.length || table.rows.length);
}

function extractAntdTables(): any[] {
  return Array.from(document.querySelectorAll('.ant-table'))
    .filter(isVisibleElement)
    .map((table, index) => {
      const headers = Array.from(table.querySelectorAll('.ant-table-thead th'))
        .map(getCleanText)
        .filter(Boolean);
      const rows = Array.from(table.querySelectorAll('.ant-table-tbody tr'))
        .map((row) => Array.from(row.querySelectorAll('td')).map(getCleanText))
        .filter((row) => row.some(Boolean));
      return {
        title: `AntD Table ${index + 1}`,
        headers,
        rows,
        rowCount: rows.length,
        columnCount: headers.length || rows[0]?.length || 0,
        selector: generateSelector(table),
      };
    })
    .filter((table) => table.headers.length || table.rows.length);
}

function extractRoleTables(): any[] {
  return Array.from(document.querySelectorAll('[role="table"],[role="grid"]'))
    .filter(isVisibleElement)
    .map((table, index) => {
      const rows = Array.from(table.querySelectorAll('[role="row"]'))
        .map((row) => Array.from(row.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"]')).map(getCleanText).filter(Boolean))
        .filter((row) => row.length > 0);
      const normalized = normalizeTableRows(rows);
      return {
        title: `Role Table ${index + 1}`,
        headers: normalized.headers,
        rows: normalized.rows,
        rowCount: normalized.rows.length,
        columnCount: normalized.headers.length || normalized.rows[0]?.length || 0,
        selector: generateSelector(table),
      };
    })
    .filter((table) => table.headers.length || table.rows.length);
}

export function extractPageTables(): any {
  const tables = [...extractHtmlTables(), ...extractAntdTables(), ...extractRoleTables()];
  return {
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    tables,
  };
}

function getInputValue(element: Element): string {
  const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (typeof input.value === 'string') return input.value;
  return getCleanText(element);
}

export function extractPageFields(): any {
  const fields: any[] = [];
  const pushField = (label: string, value: string, element: Element, confidence: number) => {
    const cleanLabel = label.replace(/[：:]\s*$/, '').trim();
    const cleanValue = value.trim();
    if (!cleanLabel || !cleanValue || cleanLabel === cleanValue) return;
    if (fields.some((item) => item.label === cleanLabel && item.value === cleanValue)) return;
    fields.push({
      label: cleanLabel.slice(0, 80),
      value: cleanValue.slice(0, 500),
      selector: generateSelector(element),
      confidence,
    });
  };

  Array.from(document.querySelectorAll('label')).forEach((label) => {
    const text = getCleanText(label);
    const forId = label.getAttribute('for');
    const target = forId ? document.getElementById(forId) : label.querySelector('input,textarea,select');
    if (target) pushField(text, getInputValue(target), target, 0.95);
  });

  Array.from(document.querySelectorAll('dt')).forEach((dt) => {
    const dd = dt.nextElementSibling;
    if (dd?.tagName.toLowerCase() === 'dd') pushField(getCleanText(dt), getCleanText(dd), dd, 0.9);
  });

  Array.from(document.querySelectorAll('tr')).forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th,td'));
    if (cells.length === 2) pushField(getCleanText(cells[0]), getCleanText(cells[1]), cells[1], 0.82);
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/^(.{2,30})[：:]\s*(.{1,160})$/);
    const parent = node.parentElement;
    if (match && parent && isVisibleElement(parent)) {
      pushField(match[1], match[2], parent, 0.72);
    }
  }

  return {
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    fields: fields.slice(0, 200),
  };
}

export function extractPageLists(): any {
  const lists = Array.from(document.querySelectorAll('ul,ol'))
    .filter(isVisibleElement)
    .map((list, index) => ({
      title: `List ${index + 1}`,
      items: Array.from(list.querySelectorAll('li')).map(getCleanText).filter(Boolean).slice(0, 200),
      selector: generateSelector(list),
    }))
    .filter((list) => list.items.length > 0)
    .slice(0, 30);

  return {
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    lists,
  };
}

export function extractPageStructuredData(): any {
  const overview = extractPageOverview();
  return {
    url: overview.url,
    title: overview.title,
    capturedAt: Date.now(),
    headings: overview.headings,
    fields: extractPageFields().fields,
    tables: extractPageTables().tables,
    lists: extractPageLists().lists,
  };
}

/**
 * 查询元素
 */
async function queryElements(args: any): Promise<any> {
  let elements: Element[] = [];

  if (args.selector) {
    elements = Array.from(document.querySelectorAll(args.selector));
  } else if (args.text) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    const found = new Set<Element>();
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent?.includes(args.text)) {
        const parent = node.parentElement;
        if (parent) {
          found.add(parent);
        }
      }
    }
    elements = Array.from(found);
  }

  const limit = args.limit || 10;
  const results = elements.slice(0, limit).map(el => ({
    tag: el.tagName.toLowerCase(),
    text: el.textContent?.substring(0, 100) || '',
    selector: generateSelector(el),
    attributes: Array.from(el.attributes).reduce((acc, attr) => {
      acc[attr.name] = attr.value;
      return acc;
    }, {} as Record<string, string>),
  }));

  return { elements: results, count: elements.length };
}

/**
 * 生成选择器
 */
function generateSelector(element: Element): string {
  if (element.id) return `#${element.id}`;
  if (element.className) {
    const classes = element.className.split(' ').filter(c => c).join('.');
    if (classes) return `${element.tagName.toLowerCase()}.${classes}`;
  }
  return element.tagName.toLowerCase();
}

/**
 * 滚动页面
 */
async function scrollPage(args: any): Promise<any> {
  const { direction, pixels, behavior = 'smooth' } = args;

  const scrollOptions: ScrollToOptions = { behavior };

  switch (direction) {
    case 'up':
      window.scrollBy({ ...scrollOptions, top: -(pixels || 500) });
      break;
    case 'down':
      window.scrollBy({ ...scrollOptions, top: pixels || 500 });
      break;
    case 'top':
      window.scrollTo({ ...scrollOptions, top: 0 });
      break;
    case 'bottom':
      window.scrollTo({ ...scrollOptions, top: document.body.scrollHeight });
      break;
    default:
      throw new Error(`未知的滚动方向: ${direction}`);
  }

  await new Promise(resolve => setTimeout(resolve, 300)); // 等待滚动完成

  return { success: true, message: `已滚动到${direction}` };
}

/**
 * 等待元素出现
 */
async function waitForElement(args: any): Promise<any> {
  const { selector, timeout = 5000 } = args;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const element = resolveTargetElement(args);
      if (element) {
        resolve({ success: true, message: '元素已出现', selector: selector || generateSelector(element) });
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`等待元素超时: ${selector}`));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

/**
 * 截图 ,得放在 background script 中实现
 */
async function takeScreenshot(args: any): Promise<any> {
  const { format = 'png', quality = 90 } = args;
  
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'CAPTURE_VISIBLE_TAB',
      format,
      quality
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response?.error || '截图失败'));
        return;
      }
      resolve({ 
        success: true, 
        message: '截图成功', 
        dataUrl: response.dataUrl 
      });
    });
  });
}
