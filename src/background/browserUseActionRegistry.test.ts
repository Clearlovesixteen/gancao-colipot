import { describe, expect, it } from 'vitest';
import { listBrowserUseActions, resolveBrowserUseActionTool } from './browserUseActionRegistry';

describe('browserUseActionRegistry', () => {
  it('registers every executable Browser Use action once', () => {
    const actions = listBrowserUseActions();
    expect(new Set(actions.map((item) => item.type)).size).toBe(actions.length);
    expect(actions.map((item) => item.type)).toEqual(expect.arrayContaining([
      'click', 'type', 'select_option', 'download_file', 'extract_table', 'wait_for_element',
      'open_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward', 'reload',
    ]));
    expect(actions.filter((item) => item.scope === 'browser').map((item) => item.type)).toEqual([
      'open_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward', 'reload',
    ]);
  });

  it('normalizes click, type and check arguments', () => {
    expect(resolveBrowserUseActionTool({ action: 'double_click', elementId: 'a' })).toMatchObject({
      toolName: 'click_element',
      args: { elementId: 'a', clickCount: 2 },
    });
    expect(resolveBrowserUseActionTool({ action: 'type', text: 'hello' })).toMatchObject({
      toolName: 'type_text',
      args: { text: 'hello', clear: true },
    });
    expect(resolveBrowserUseActionTool({ action: 'check', value: 'false' })).toMatchObject({
      toolName: 'check_element',
      args: { checked: false },
    });
  });

  it('falls back to timed wait when wait_for_element has no target', () => {
    expect(resolveBrowserUseActionTool({ action: 'wait_for_element', timeoutMs: 500 })).toMatchObject({
      toolName: 'wait',
    });
  });

  it('uses wait_for_element when a wait action includes a target', () => {
    expect(resolveBrowserUseActionTool({ action: 'wait', text: '加载完成' })).toMatchObject({
      toolName: 'wait_for_element',
    });
  });
});
