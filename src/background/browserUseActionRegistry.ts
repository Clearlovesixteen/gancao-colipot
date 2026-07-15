import type { BrowserActionType, ComputerUseAction } from '../shared/automationTypes';

export type BrowserUseActionDescriptor = {
  type: BrowserActionType;
  toolName: string;
  scope?: 'browser' | 'content' | 'runner';
  risk: 'low' | 'medium' | 'high';
  mayOpenNewTab?: boolean;
  buildArgs: (action: ComputerUseAction) => Record<string, unknown>;
};

const identityArgs = (action: ComputerUseAction): Record<string, unknown> => ({ ...action });

const descriptors: BrowserUseActionDescriptor[] = [
  { type: 'open_tab', toolName: 'open_tab', scope: 'browser', risk: 'low', mayOpenNewTab: true, buildArgs: identityArgs },
  { type: 'switch_tab', toolName: 'switch_tab', scope: 'browser', risk: 'low', buildArgs: identityArgs },
  { type: 'close_tab', toolName: 'close_tab', scope: 'browser', risk: 'medium', buildArgs: identityArgs },
  { type: 'go_back', toolName: 'go_back', scope: 'browser', risk: 'low', buildArgs: identityArgs },
  { type: 'go_forward', toolName: 'go_forward', scope: 'browser', risk: 'low', buildArgs: identityArgs },
  { type: 'reload', toolName: 'reload', scope: 'browser', risk: 'low', buildArgs: identityArgs },
  { type: 'click', toolName: 'click_element', scope: 'content', risk: 'low', mayOpenNewTab: true, buildArgs: identityArgs },
  { type: 'double_click', toolName: 'click_element', risk: 'low', mayOpenNewTab: true, buildArgs: (action) => ({ ...action, clickCount: 2 }) },
  { type: 'right_click', toolName: 'click_element', risk: 'medium', buildArgs: (action) => ({ ...action, button: 'right' }) },
  { type: 'click_by_coordinate', toolName: 'click_by_coordinate', risk: 'medium', mayOpenNewTab: true, buildArgs: identityArgs },
  { type: 'type', toolName: 'type_text', risk: 'low', buildArgs: (action) => ({ ...action, clear: true }) },
  { type: 'clear_input', toolName: 'clear_input', risk: 'low', buildArgs: identityArgs },
  { type: 'focus', toolName: 'focus_element', risk: 'low', buildArgs: identityArgs },
  { type: 'keyboard_shortcut', toolName: 'keyboard_shortcut', risk: 'medium', buildArgs: identityArgs },
  { type: 'press_key', toolName: 'press_key', risk: 'low', mayOpenNewTab: true, buildArgs: identityArgs },
  { type: 'select_option', toolName: 'select_option', risk: 'low', buildArgs: identityArgs },
  { type: 'check', toolName: 'check_element', risk: 'low', buildArgs: (action) => ({ ...action, checked: action.value !== 'false' }) },
  { type: 'hover', toolName: 'hover_element', risk: 'low', buildArgs: identityArgs },
  { type: 'drag', toolName: 'drag_element', risk: 'medium', buildArgs: identityArgs },
  { type: 'scroll', toolName: 'scroll_page', risk: 'low', buildArgs: identityArgs },
  {
    type: 'wait',
    toolName: 'wait',
    risk: 'low',
    buildArgs: identityArgs,
  },
  {
    type: 'wait_for_element',
    toolName: 'wait_for_element',
    risk: 'low',
    buildArgs: identityArgs,
  },
  { type: 'upload_file', toolName: 'upload_file', risk: 'medium', buildArgs: identityArgs },
  { type: 'download_file', toolName: 'download_file', risk: 'medium', buildArgs: identityArgs },
  { type: 'extract_table', toolName: 'extract_page_tables', risk: 'low', buildArgs: identityArgs },
];

const registry = new Map(descriptors.map((descriptor) => [descriptor.type, descriptor]));

export function getBrowserUseActionDescriptor(type: BrowserActionType): BrowserUseActionDescriptor {
  const descriptor = registry.get(type);
  if (!descriptor) throw new Error(`不支持的 Browser Use 动作: ${type}`);
  return descriptor;
}

export function resolveBrowserUseActionTool(action: ComputerUseAction): {
  descriptor: BrowserUseActionDescriptor;
  toolName: string;
  args: Record<string, unknown>;
} {
  if (action.action === 'finish') throw new Error('finish 不是可执行的浏览器动作');
  if (action.action === 'wait' && (action.selector || action.elementId || action.text)) {
    const waitForElementDescriptor = getBrowserUseActionDescriptor('wait_for_element');
    return {
      descriptor: waitForElementDescriptor,
      toolName: waitForElementDescriptor.toolName,
      args: waitForElementDescriptor.buildArgs(action),
    };
  }
  const descriptor = getBrowserUseActionDescriptor(action.action);
  if (action.action === 'wait_for_element' && !action.selector && !action.elementId && !action.text) {
    const waitDescriptor = getBrowserUseActionDescriptor('wait');
    return { descriptor: waitDescriptor, toolName: waitDescriptor.toolName, args: waitDescriptor.buildArgs(action) };
  }
  return {
    descriptor,
    toolName: descriptor.toolName,
    args: descriptor.buildArgs(action),
  };
}

export function listBrowserUseActions(): BrowserUseActionDescriptor[] {
  return [...descriptors];
}
