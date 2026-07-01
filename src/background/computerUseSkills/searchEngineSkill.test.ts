import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUseTaskIntent, ObservedElement } from '../../shared/automationTypes';
import { runSearchEngineSkill } from './searchEngineSkill';

function element(partial: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: partial.elementId || 'el_1',
    role: partial.role || 'link',
    tag: partial.tag || 'a',
    text: partial.text || '',
    selector: partial.selector || '#x',
    selectors: partial.selectors || [partial.selector || '#x'],
    bbox: partial.bbox || { x: 100, y: 120, width: 300, height: 32 },
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    value: partial.value,
    href: partial.href,
    purpose: partial.purpose || 'generic',
    score: partial.score || 0.5,
  };
}

function observation(partial: Partial<BrowserObservation>): BrowserObservation {
  return {
    success: true,
    url: partial.url || 'https://www.baidu.com/',
    title: partial.title || '百度一下',
    viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
    elements: partial.elements || [],
    pageState: partial.pageState,
    capturedAt: Date.now(),
  };
}

describe('runSearchEngineSkill', () => {
  it('continues to click the first search result when requested', async () => {
    const intent: ComputerUseTaskIntent = {
      rawGoal: '打开百度输入java,然后搜索，再点击第一个结果',
      actionType: 'search',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: 'java',
      postSearchAction: 'click_first_result',
      targetResultIndex: 1,
      riskLevel: 'medium',
    };
    const input = element({
      elementId: 'kw',
      role: 'textbox',
      tag: 'input',
      selector: '#kw',
      purpose: 'search_input',
      score: 0.98,
      value: '',
    });
    const typedInput = { ...input, value: 'java' };
    const button = element({
      elementId: 'su',
      role: 'button',
      tag: 'input',
      selector: '#su',
      text: '百度一下',
      purpose: 'search_button',
      score: 0.98,
    });
    const firstResult = element({
      elementId: 'result_1',
      role: 'link',
      tag: 'a',
      selector: '#content_left h3 a',
      text: 'Java 官方文档',
      href: 'https://www.baidu.com/link?url=abc',
      bbox: { x: 160, y: 180, width: 420, height: 30 },
    });

    const observations = [
      observation({
        elements: [input, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        elements: [typedInput, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=java',
        title: 'java_百度搜索',
        elements: [element({ text: '新闻', href: 'https://www.baidu.com/s?rtt=1' }), firstResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false },
      }),
      observation({
        url: 'https://docs.oracle.com/javase/',
        title: 'Java Documentation',
        elements: [],
      }),
    ];
    const clicks: any[] = [];
    const firstResultClicks: any[] = [];
    const emitted: any[] = [];

    await runSearchEngineSkill({
      tabId: 1,
      runId: 'run_1',
      goal: intent.rawGoal,
      intent,
      signal: new AbortController().signal,
      navigate: async () => {},
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return observations.shift();
        if (toolName === 'type_text') return { success: true };
        if (toolName === 'click_element') {
          clicks.push(args);
          return { success: true };
        }
        if (toolName === 'click_search_result') {
          firstResultClicks.push(args);
          return { success: true, text: 'Java 官方文档', href: 'https://docs.oracle.com/javase/' };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
      emit: (message) => emitted.push(message),
    });

    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toEqual(expect.objectContaining({ elementId: 'su' }));
    expect(firstResultClicks).toEqual([expect.objectContaining({ index: 1 })]);
    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(finished?.summary).toContain('并点击第一个搜索结果');
    expect(finished?.steps).toHaveLength(3);
  });

  it('does not treat hao123 navigation link as the first search result', async () => {
    const intent: ComputerUseTaskIntent = {
      rawGoal: '打开百度搜索菜鸟，再点击第一个结果',
      actionType: 'search',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: '菜鸟',
      postSearchAction: 'click_first_result',
      targetResultIndex: 1,
      riskLevel: 'medium',
    };
    const input = element({
      elementId: 'kw',
      role: 'textbox',
      tag: 'input',
      selector: '#kw',
      purpose: 'search_input',
      score: 0.98,
      value: '',
      bbox: { x: 130, y: 18, width: 620, height: 44 },
    });
    const typedInput = { ...input, value: '菜鸟' };
    const button = element({
      elementId: 'su',
      role: 'button',
      tag: 'input',
      selector: '#su',
      text: '百度一下',
      purpose: 'search_button',
      score: 0.98,
      bbox: { x: 760, y: 18, width: 100, height: 44 },
    });
    const hao123 = element({
      elementId: 'nav_hao123',
      text: 'hao123',
      href: 'https://www.hao123.com/',
      selector: '#s-top-left a:nth-child(2)',
      bbox: { x: 520, y: 34, width: 56, height: 20 },
    });
    const firstResult = element({
      elementId: 'result_cainiao',
      text: '菜鸟集团-电商物流行业的全球领导者',
      href: 'https://www.baidu.com/link?url=cainiao',
      selector: '#content_left .result h3 a',
      bbox: { x: 150, y: 126, width: 390, height: 26 },
    });

    const observations = [
      observation({
        elements: [input, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        elements: [typedInput, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=%E8%8F%9C%E9%B8%9F',
        title: '菜鸟_百度搜索',
        elements: [typedInput, hao123, firstResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
      observation({
        url: 'https://www.cainiao.com/',
        title: '菜鸟集团',
        elements: [],
      }),
    ];
    const clicks: any[] = [];
    const firstResultClicks: any[] = [];

    await runSearchEngineSkill({
      tabId: 1,
      runId: 'run_hao123',
      goal: intent.rawGoal,
      intent,
      signal: new AbortController().signal,
      navigate: async () => {},
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return observations.shift();
        if (toolName === 'type_text') return { success: true };
        if (toolName === 'click_element') {
          clicks.push(args);
          return { success: true };
        }
        if (toolName === 'click_search_result') {
          firstResultClicks.push(args);
          return { success: true, text: '菜鸟集团-电商物流行业的全球领导者', href: 'https://www.cainiao.com/' };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
      emit: () => {},
    });

    expect(clicks).toHaveLength(1);
    expect(firstResultClicks).toEqual([expect.objectContaining({ index: 1 })]);
  });

  it('does not fallback to a second click when direct search result click stays on results page', async () => {
    const intent: ComputerUseTaskIntent = {
      rawGoal: '打开百度，搜索123，点击第一个搜索结果',
      actionType: 'search',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: '123',
      postSearchAction: 'click_first_result',
      targetResultIndex: 1,
      riskLevel: 'medium',
    };
    const input = element({
      elementId: 'kw',
      role: 'textbox',
      tag: 'input',
      selector: '#kw',
      purpose: 'search_input',
      score: 0.98,
      value: '',
    });
    const typedInput = { ...input, value: '123' };
    const button = element({
      elementId: 'su',
      role: 'button',
      tag: 'input',
      selector: '#su',
      text: '百度一下',
      purpose: 'search_button',
      score: 0.98,
    });
    const fallbackResult = element({
      elementId: 'fallback_result',
      role: 'link',
      tag: 'a',
      selector: '#content_left h3 a',
      text: '123 官方信息',
      href: 'https://www.baidu.com/link?url=real-first-result',
      bbox: { x: 150, y: 180, width: 300, height: 30 },
    });

    const observations = [
      observation({
        elements: [input, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        elements: [typedInput, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=123',
        title: '123_百度搜索',
        elements: [typedInput, fallbackResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=123',
        title: '123_百度搜索',
        elements: [typedInput, fallbackResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
    ];
    const clicks: any[] = [];
    const firstResultClicks: any[] = [];
    const emitted: any[] = [];

    await runSearchEngineSkill({
      tabId: 1,
      runId: 'run_no_double_click',
      goal: intent.rawGoal,
      intent,
      signal: new AbortController().signal,
      navigate: async () => {},
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return observations.shift();
        if (toolName === 'type_text') return { success: true };
        if (toolName === 'click_element') {
          clicks.push(args);
          return { success: true };
        }
        if (toolName === 'click_search_result') {
          firstResultClicks.push(args);
          return { success: true, text: 'hao123_上网从这里开始', href: 'https://www.baidu.com/link?url=from_pc_logon_hao123' };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
      emit: (message) => emitted.push(message),
    });

    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toEqual(expect.objectContaining({ elementId: 'su' }));
    expect(firstResultClicks).toEqual([expect.objectContaining({ index: 1 })]);
    const error = emitted.find((message) => message.type === 'COMPUTER_USE_ERROR');
    expect(error?.error).toContain('页面仍停留在搜索结果页');
    expect(emitted.some((message) => message.type === 'COMPUTER_USE_FINISHED')).toBe(false);
  }, 10000);

  it('waits for delayed navigation after clicking the first search result', async () => {
    const intent: ComputerUseTaskIntent = {
      rawGoal: '打开百度，输入菜鸟，然后点击第一个搜索结果',
      actionType: 'search',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: '菜鸟',
      postSearchAction: 'click_first_result',
      targetResultIndex: 1,
      riskLevel: 'medium',
    };
    const input = element({
      elementId: 'kw',
      role: 'textbox',
      tag: 'input',
      selector: '#kw',
      purpose: 'search_input',
      score: 0.98,
      value: '',
    });
    const typedInput = { ...input, value: '菜鸟' };
    const button = element({
      elementId: 'su',
      role: 'button',
      tag: 'input',
      selector: '#su',
      text: '百度一下',
      purpose: 'search_button',
      score: 0.98,
    });
    const firstResult = element({
      elementId: 'result_cainiao',
      role: 'link',
      tag: 'a',
      selector: '#content_left h3 a',
      text: '菜鸟集团-电商物流行业的全球领导者',
      href: 'https://www.baidu.com/link?url=cainiao',
      bbox: { x: 150, y: 180, width: 390, height: 30 },
    });

    const observations = [
      observation({
        elements: [input, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        elements: [typedInput, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=%E8%8F%9C%E9%B8%9F',
        title: '菜鸟_百度搜索',
        elements: [typedInput, firstResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=%E8%8F%9C%E9%B8%9F',
        title: '菜鸟_百度搜索',
        elements: [typedInput, firstResult],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
      observation({
        url: 'https://www.cainiao.com/',
        title: '自动化仓储选菜鸟',
        elements: [],
      }),
    ];
    const emitted: any[] = [];

    await runSearchEngineSkill({
      tabId: 1,
      runId: 'run_delayed_navigation',
      goal: intent.rawGoal,
      intent,
      signal: new AbortController().signal,
      navigate: async () => {},
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return observations.shift();
        if (toolName === 'type_text') return { success: true };
        if (toolName === 'click_element') return { success: true };
        if (toolName === 'click_search_result') {
          return { success: true, text: '菜鸟集团-电商物流行业的全球领导者', href: 'https://www.baidu.com/link?url=cainiao' };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
      emit: (message) => emitted.push(message),
    });

    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(finished?.summary).toContain('菜鸟集团-电商物流行业的全球领导者');
    expect(finished?.steps.at(-1)?.result).toEqual(expect.objectContaining({
      url: 'https://www.cainiao.com/',
      title: '自动化仓储选菜鸟',
    }));
    expect(emitted.some((message) => message.type === 'COMPUTER_USE_ERROR')).toBe(false);
  });

  it('clicks the requested search result index', async () => {
    const intent: ComputerUseTaskIntent = {
      rawGoal: '打开百度，输入甘草医生，然后进入第三个搜索结果',
      actionType: 'search',
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      query: '甘草医生',
      postSearchAction: 'click_first_result',
      targetResultIndex: 3,
      riskLevel: 'medium',
    };
    const input = element({
      elementId: 'kw',
      role: 'textbox',
      tag: 'input',
      selector: '#kw',
      purpose: 'search_input',
      score: 0.98,
      value: '',
    });
    const typedInput = { ...input, value: '甘草医生' };
    const button = element({
      elementId: 'su',
      role: 'button',
      tag: 'input',
      selector: '#su',
      text: '百度一下',
      purpose: 'search_button',
      score: 0.98,
    });

    const observations = [
      observation({
        elements: [input, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        elements: [typedInput, button],
        pageState: { kind: 'search_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw', searchButtonId: 'su' },
      }),
      observation({
        url: 'https://www.baidu.com/s?wd=%E7%94%98%E8%8D%89%E5%8C%BB%E7%94%9F',
        title: '甘草医生_百度搜索',
        elements: [typedInput],
        pageState: { kind: 'result_page', hasModal: false, hasCaptcha: false, hasLoginSignal: false, searchInputId: 'kw' },
      }),
      observation({
        url: 'https://example.com/third-result',
        title: '第三个结果',
        elements: [],
      }),
    ];
    const firstResultClicks: any[] = [];
    const emitted: any[] = [];

    await runSearchEngineSkill({
      tabId: 1,
      runId: 'run_third_result',
      goal: intent.rawGoal,
      intent,
      signal: new AbortController().signal,
      navigate: async () => {},
      executeBrowserTool: async (_tabId, toolName, args) => {
        if (toolName === 'observe_page') return observations.shift();
        if (toolName === 'type_text') return { success: true };
        if (toolName === 'click_element') return { success: true };
        if (toolName === 'click_search_result') {
          firstResultClicks.push(args);
          return { success: true, text: '第三个自然结果', href: 'https://example.com/third-result' };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
      emit: (message) => emitted.push(message),
    });

    expect(firstResultClicks).toEqual([expect.objectContaining({ index: 3 })]);
    const finished = emitted.find((message) => message.type === 'COMPUTER_USE_FINISHED');
    expect(finished?.summary).toContain('第3个搜索结果');
    expect(finished?.summary).toContain('第三个自然结果');
  });
});
