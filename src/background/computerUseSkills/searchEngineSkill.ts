import type {
  BrowserObservation,
  ComputerUseAction,
  ComputerUseErrorMessage,
  ComputerUseFinishedMessage,
  ComputerUseProgressMessage,
  ComputerUseTaskIntent,
  ObservedElement,
} from '../../shared/automationTypes';
import { buildSearchUrl } from '../computerUseTaskParser';

type SearchSkillDeps = {
  tabId: number;
  runId: string;
  goal: string;
  intent: ComputerUseTaskIntent;
  signal: AbortSignal;
  navigate: (tabId: number, url: string, waitFor: 'complete' | 'domcontentloaded' | 'none', timeoutMs: number, signal: AbortSignal) => Promise<void>;
  executeBrowserTool: (tabId: number, toolName: string, args: any) => Promise<any>;
  emit: (msg: ComputerUseProgressMessage | ComputerUseFinishedMessage | ComputerUseErrorMessage) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function bestSearchInput(observation: BrowserObservation) {
  const stateId = observation.pageState?.searchInputId || observation.pageState?.mainInputId;
  if (stateId) return observation.elements.find((element) => element.elementId === stateId);
  return observation.elements
    .filter((element) => element.purpose === 'search_input' || element.role === 'textbox')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
}

function bestSearchButton(observation: BrowserObservation) {
  const stateId = observation.pageState?.searchButtonId || observation.pageState?.primaryButtonId;
  if (stateId) return observation.elements.find((element) => element.elementId === stateId);
  return observation.elements
    .filter((element) => element.purpose === 'search_button' || element.role === 'button')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
}

function isSearchResultObservation(observation: BrowserObservation, query: string): boolean {
  const decodedUrl = decodeURIComponent(observation.url || '');
  if (observation.pageState?.kind === 'result_page' && decodedUrl.includes(query)) return true;
  if (/[?&](wd|q|search_query)=/i.test(decodedUrl) && decodedUrl.includes(query)) return true;
  const title = observation.title || '';
  return title.includes(query) && /(搜索|search|百度|bing|google|youtube)/i.test(title);
}

function safeUrl(value?: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isNavigationLikeResultText(text: string): boolean {
  const normalized = text.trim();
  return /^(新闻|网页|贴吧|知道|图片|视频|地图|文库|资讯|购物|更多|设置|登录|百度首页|上一页|下一页|\d+)$/i.test(normalized)
    || /hao\s*123/i.test(normalized);
}

function getResultAreaMinY(observation: BrowserObservation): number {
  const searchInput = observation.elements
    .filter((element) => element.purpose === 'search_input' || element.elementId === observation.pageState?.searchInputId)
    .sort((a, b) => a.bbox.y - b.bbox.y)[0];
  if (searchInput) return searchInput.bbox.y + searchInput.bbox.height + 35;
  return Math.max(90, Math.round(observation.viewport.height * 0.1));
}

function isLikelySearchChrome(element: ObservedElement, observation: BrowserObservation): boolean {
  const selectorText = [element.selector, ...(element.selectors || [])].join(' ');
  const href = safeUrl(element.href);
  if (element.bbox.y < getResultAreaMinY(observation)) return true;
  if (/(^|[#.\s_-])(s-top|u1|head|header|nav|toolbar|tabs?|foot|footer|setting|user|login)([#.\s_-]|$)/i.test(selectorText)) return true;
  if (href && /(hao123\.com|passport\.baidu\.com|help\.baidu\.com)/i.test(href.hostname)) return true;
  return false;
}

function resultSelectorBoost(element: ObservedElement): number {
  const selectorText = [element.selector, ...(element.selectors || [])].join(' ');
  if (/(^|[#.\s_-])(content_left|results?|search-results?|b_results|rso)([#.\s_-]|$)/i.test(selectorText)) return 60;
  if (/\bh3\b/i.test(selectorText)) return 20;
  return 0;
}

function scoreSearchResultLink(element: ObservedElement, observation: BrowserObservation): number {
  const href = safeUrl(element.href);
  const current = safeUrl(observation.url);
  const text = (element.text || '').trim();
  if (!href || !/^https?:$/i.test(href.protocol)) return -1;
  if (!text || isNavigationLikeResultText(text)) return -1;
  if (href.href === observation.url) return -1;
  if (isLikelySearchChrome(element, observation)) return -1;

  let score = 0;
  if (element.tag === 'a' || element.role === 'link') score += 20;
  if (text.length >= 6) score += 12;
  if (element.bbox.y > 80) score += 6;
  score += resultSelectorBoost(element);

  if (current && href.hostname !== current.hostname) score += 30;
  if (/\.baidu\.com$/i.test(href.hostname) && href.pathname === '/link') score += 45;
  if (/\.google\./i.test(href.hostname) && href.pathname === '/url' && href.searchParams.get('q')) score += 45;
  if (/bing\.com$/i.test(current?.hostname || '') && !/bing\.com$/i.test(href.hostname)) score += 35;

  if (/(cache|translate|preferences|account|login|passport|help|support)/i.test(href.href)) score -= 30;
  if (/hao\s*123/i.test(decodeURIComponent(href.href))) return -1;
  if (element.bbox.width <= 8 || element.bbox.height <= 8) score -= 20;
  return score;
}

function nthSearchResultLink(observation: BrowserObservation, index: number): ObservedElement | undefined {
  return observation.elements
    .filter((element) => element.visible && element.enabled && (element.tag === 'a' || element.role === 'link'))
    .map((element) => ({ element, score: scoreSearchResultLink(element, observation) }))
    .filter((item) => item.score >= 25)
    .sort((a, b) => b.score - a.score || a.element.bbox.y - b.element.bbox.y || a.element.bbox.x - b.element.bbox.x)[Math.max(0, index - 1)]?.element;
}

function hasLeftSearchResults(before: BrowserObservation, after: BrowserObservation, query: string): boolean {
  if (!after?.url) return false;
  if (after.url !== before.url && !isSearchResultObservation(after, query)) return true;
  if (after.title && before.title && after.title !== before.title && !/(搜索|百度|bing|google|youtube)/i.test(after.title)) return true;
  return false;
}

function formatSearchResultLabel(index: number): string {
  return index === 1 ? '第一个搜索结果' : `第${index}个搜索结果`;
}

async function waitForSearchResultNavigation(input: {
  deps: SearchSkillDeps;
  before: BrowserObservation;
  query: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<BrowserObservation> {
  const timeoutMs = input.timeoutMs ?? 6000;
  const intervalMs = input.intervalMs ?? 500;
  const startedAt = Date.now();
  let lastObservation = input.before;

  while (Date.now() - startedAt <= timeoutMs) {
    await sleep(intervalMs);
    try {
      const observed = normalizeToolResult(await input.deps.executeBrowserTool(input.deps.tabId, 'observe_page', {
        includeScreenshot: false,
        limit: 120,
      })) as BrowserObservation;
      if (!observed?.url) continue;
      lastObservation = observed;
      if (hasLeftSearchResults(input.before, lastObservation, input.query)) {
        return lastObservation;
      }
    } catch {
      // 页面跳转过程中 content script 可能短暂不可用，继续等待下一次观察。
    }
  }

  return lastObservation;
}

async function clickFirstSearchResultIfRequested(input: {
  deps: SearchSkillDeps;
  observation: BrowserObservation;
  query: string;
  stepIndex: number;
  steps: Array<{ action?: ComputerUseAction; result?: unknown }>;
}): Promise<{ handled: boolean; observation: BrowserObservation }> {
  const { deps, query, steps } = input;
  let { observation } = input;
  if (deps.intent.postSearchAction !== 'click_first_result') {
    return { handled: false, observation };
  }

  const targetIndex = Math.max(1, Number(deps.intent.targetResultIndex || 1));
  const targetLabel = formatSearchResultLabel(targetIndex);
  const directClickAction: ComputerUseAction = {
    action: 'click',
    reason: `点击${targetLabel}`,
    expect: `打开${targetLabel}页面`,
  };
  deps.emit({
    type: 'COMPUTER_USE_PROGRESS',
    runId: deps.runId,
    goal: deps.goal,
    stepIndex: input.stepIndex,
    state: 'acting',
    observation,
    action: directClickAction,
  });
  const directClickResult = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'click_search_result', {
    index: targetIndex,
  }));
  if (directClickResult?.success) {
    const clickedText = String(directClickResult.text || targetLabel);
    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: input.stepIndex + 1,
      state: 'verifying',
      action: { ...directClickAction, text: clickedText },
      result: directClickResult,
    });
    observation = await waitForSearchResultNavigation({ deps, before: input.observation, query });
    if (hasLeftSearchResults(input.observation, observation, query)) {
      deps.emit({
        type: 'COMPUTER_USE_FINISHED',
        runId: deps.runId,
        goal: deps.goal,
        summary: `已搜索 ${query}，并点击${targetLabel}：${clickedText}`,
        steps: [
          ...steps,
          { action: { ...directClickAction, text: clickedText }, result: { click: directClickResult, url: observation.url, title: observation.title } },
        ],
      });
      return { handled: true, observation };
    }
    throw new Error(`已尝试点击${targetLabel}，但页面仍停留在搜索结果页：${observation.title || observation.url}`);
  }

  const resultLink = nthSearchResultLink(observation, targetIndex);
  if (!resultLink) {
    throw new Error(directClickResult?.error || `已进入搜索结果页，但未识别到可点击的${targetLabel}。`);
  }

  const clickFirstResultAction: ComputerUseAction = {
    action: 'click',
    elementId: resultLink.elementId,
    selector: resultLink.selector,
    text: resultLink.text,
    reason: `点击${targetLabel}：${resultLink.text}`,
    expect: `打开${targetLabel}页面`,
  };
  deps.emit({
    type: 'COMPUTER_USE_PROGRESS',
    runId: deps.runId,
    goal: deps.goal,
    stepIndex: input.stepIndex,
    state: 'acting',
    observation,
    action: clickFirstResultAction,
  });
  const clickFirstResult = await deps.executeBrowserTool(deps.tabId, 'click_element', clickFirstResultAction);

  deps.emit({
    type: 'COMPUTER_USE_PROGRESS',
    runId: deps.runId,
    goal: deps.goal,
    stepIndex: input.stepIndex + 1,
    state: 'verifying',
    action: clickFirstResultAction,
    result: clickFirstResult,
  });
  observation = await waitForSearchResultNavigation({ deps, before: input.observation, query });

  if (!hasLeftSearchResults(input.observation, observation, query)) {
    throw new Error(`已尝试点击${targetLabel}，但页面仍停留在搜索结果页：${observation.title || observation.url}`);
  }

  deps.emit({
    type: 'COMPUTER_USE_FINISHED',
    runId: deps.runId,
    goal: deps.goal,
    summary: `已搜索 ${query}，并点击${targetLabel}：${resultLink.text}`,
    steps: [
      ...steps,
      { action: clickFirstResultAction, result: { click: clickFirstResult, url: observation.url, title: observation.title } },
    ],
  });
  return { handled: true, observation };
}

export async function runSearchEngineSkill(deps: SearchSkillDeps): Promise<void> {
  try {
    const query = deps.intent.query?.trim();
    if (!query) throw new Error('搜索任务缺少关键词');
    if (!deps.intent.startUrl) throw new Error('搜索任务缺少起始网址');

    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: 0,
      state: 'acting',
      action: { action: 'click', reason: `打开搜索页面：${deps.intent.startUrl}` },
    });
    await deps.navigate(deps.tabId, deps.intent.startUrl, 'complete', 30000, deps.signal);

    if (deps.signal.aborted) throw new Error('已停止');
    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: 1,
      state: 'observing',
    });
    let observation = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'observe_page', {
      includeScreenshot: false,
      limit: 120,
    })) as BrowserObservation;

    if (observation.pageState?.hasCaptcha) {
      throw new Error('当前页面出现验证码/安全验证，请手动完成后再继续自动操作。');
    }

    const input = bestSearchInput(observation);
    if (!input) {
      const fallbackUrl = buildSearchUrl(deps.intent);
      if (!fallbackUrl) throw new Error('未找到搜索输入框，也无法构造搜索结果 URL。');
      deps.emit({
        type: 'COMPUTER_USE_PROGRESS',
        runId: deps.runId,
        goal: deps.goal,
        stepIndex: 2,
        state: 'recovering',
        observation,
        action: { action: 'click', reason: '未找到搜索框，改为直接打开搜索结果页' },
      });
      await deps.navigate(deps.tabId, fallbackUrl, 'complete', 30000, deps.signal);
      observation = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'observe_page', { limit: 80 })) as BrowserObservation;
      const steps = [{ action: { action: 'click' as const, reason: '直接打开搜索结果页' }, result: { url: observation.url } }];
      const postAction = await clickFirstSearchResultIfRequested({
        deps,
        observation,
        query,
        stepIndex: 4,
        steps,
      });
      if (postAction.handled) return;
      deps.emit({
        type: 'COMPUTER_USE_FINISHED',
        runId: deps.runId,
        goal: deps.goal,
        summary: isSearchResultObservation(observation, query) ? `已搜索：${query}` : `已打开搜索结果页：${query}`,
        steps,
      });
      return;
    }

    const typeAction: ComputerUseAction = {
      action: 'type',
      elementId: input.elementId,
      selector: input.selector,
      text: query,
      reason: `输入搜索关键词：${query}`,
      expect: `搜索框内容为 ${query}`,
    };
    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: 2,
      state: 'acting',
      observation,
      action: typeAction,
    });
    const typeResult = await deps.executeBrowserTool(deps.tabId, 'type_text', { ...typeAction, clear: true });

    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: 3,
      state: 'verifying',
      action: typeAction,
      result: typeResult,
    });
    observation = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'observe_page', {
      includeScreenshot: false,
      limit: 120,
    })) as BrowserObservation;
    const typedInput = bestSearchInput(observation);
    if (typedInput?.value !== query) {
      throw new Error(`搜索关键词输入后校验失败，当前输入框内容为：${typedInput?.value || '空'}`);
    }

    const button = bestSearchButton(observation);
    const clickAction: ComputerUseAction | undefined = button ? {
      action: 'click',
      elementId: button.elementId,
      selector: button.selector,
      reason: `点击搜索按钮：${button.text || button.value || button.selector}`,
      expect: '进入搜索结果页',
    } : undefined;

    if (clickAction) {
      deps.emit({
        type: 'COMPUTER_USE_PROGRESS',
        runId: deps.runId,
        goal: deps.goal,
        stepIndex: 4,
        state: 'acting',
        observation,
        action: clickAction,
      });
      await deps.executeBrowserTool(deps.tabId, 'click_element', clickAction);
      await sleep(1500);
    }

    deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: deps.runId,
      goal: deps.goal,
      stepIndex: 5,
      state: 'verifying',
      action: clickAction || { action: 'press_key', key: 'Enter', reason: '校验搜索结果' },
    });
    observation = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'observe_page', {
      includeScreenshot: false,
      limit: 80,
    })) as BrowserObservation;

    if (!isSearchResultObservation(observation, query)) {
      const fallbackUrl = buildSearchUrl(deps.intent);
      if (!fallbackUrl) throw new Error('点击搜索后未进入结果页，且无法构造搜索结果 URL。');
      deps.emit({
        type: 'COMPUTER_USE_PROGRESS',
        runId: deps.runId,
        goal: deps.goal,
        stepIndex: 6,
        state: 'recovering',
        observation,
        action: { action: 'click', reason: '点击后未检测到结果页，改为直接打开搜索结果页' },
      });
      await deps.navigate(deps.tabId, fallbackUrl, 'complete', 30000, deps.signal);
      observation = normalizeToolResult(await deps.executeBrowserTool(deps.tabId, 'observe_page', {
        includeScreenshot: false,
        limit: 120,
      })) as BrowserObservation;
    }

    const steps = [
      { action: typeAction, result: typeResult },
      ...(clickAction ? [{ action: clickAction, result: { url: observation.url } }] : []),
    ];
    const postAction = await clickFirstSearchResultIfRequested({
      deps,
      observation,
      query,
      stepIndex: 7,
      steps,
    });
    if (postAction.handled) return;

    deps.emit({
      type: 'COMPUTER_USE_FINISHED',
      runId: deps.runId,
      goal: deps.goal,
      summary: isSearchResultObservation(observation, query)
        ? `搜索完成：${query}`
        : `已执行搜索动作，请检查当前页面：${observation.title || observation.url}`,
      steps,
    });
  } catch (error: any) {
    deps.emit({
      type: 'COMPUTER_USE_ERROR',
      runId: deps.runId,
      goal: deps.goal,
      error: error?.message || '搜索自动操作失败',
    });
  }
}
