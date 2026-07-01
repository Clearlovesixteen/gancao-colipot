import type {
  BrowserObservation,
  ComputerUsePhase,
  ComputerUseIntent,
  ComputerUsePageContext,
  ObservedElement,
} from '../shared/automationTypes';

type ExecuteBrowserTool = (tabId: number, toolName: string, args: any) => Promise<any>;

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function isDataIntent(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'data_extraction'
    || intent.taskType === 'download'
    || intent.desiredOutput === 'table_data'
    || intent.desiredOutput === 'download_file'
    || /(列表|表格|数据|导出|下载|提取|获取|读取)/i.test(intent.rawGoal);
}

function shouldCollectStructuredContext(intent: ComputerUseIntent, phase?: ComputerUsePhase): boolean {
  if (!phase) return isDataIntent(intent);
  return phase.type === 'extract_data'
    || (!phase.type && isDataIntent(intent));
}

function compact(text?: string): string {
  return (text || '').replace(/\s+/g, '').trim();
}

function includesTarget(text: string | undefined, targets: string[]): boolean {
  const haystack = compact(text);
  return targets.some((target) => {
    const needle = compact(target);
    return Boolean(needle && haystack.includes(needle));
  });
}

function navigationPriority(element: ObservedElement, targets: string[]): number {
  let score = 0;
  if (includesTarget(element.text, targets)) score += 100;
  if (includesTarget(element.context, targets)) score += 20;
  if ((element.text || '').length <= 20) score += 10;
  if (/leaf|nav-item|sidebar-handle|sidebar-text/i.test(`${element.selector || ''} ${element.context || ''}`)) score += 8;
  if (element.enabled) score += 3;
  if (element.clickable) score += 2;
  score += element.score || 0;
  return score;
}

function getNavigationCandidates(elements: ObservedElement[], targets: string[] = []): ObservedElement[] {
  return elements
    .filter((element) => ['menu_item', 'navigation_item'].includes(element.purpose || '') && element.visible)
    .map((element, index) => ({ element, index, priority: navigationPriority(element, targets) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((item) => item.element)
    .slice(0, 80);
}

function getActionCandidates(elements: ObservedElement[]): ObservedElement[] {
  return elements
    .filter((element) => ['download_button', 'submit_button', 'search_button', 'login_button'].includes(element.purpose || '') && element.visible && element.enabled)
    .slice(0, 60);
}

export async function buildComputerUsePageContext(input: {
  tabId: number;
  intent: ComputerUseIntent;
  phase?: ComputerUsePhase;
  executeBrowserTool: ExecuteBrowserTool;
}): Promise<ComputerUsePageContext> {
  const observation = normalizeToolResult(await input.executeBrowserTool(input.tabId, 'observe_page', {
    includeScreenshot: false,
    limit: 160,
  })) as BrowserObservation;

  let structuredData: ComputerUsePageContext['structuredData'] | undefined;
  let pageTextPreview = '';
  let tableCandidates: unknown[] = [];

  if (shouldCollectStructuredContext(input.intent, input.phase)) {
    const [structured, tables, pageInfo] = await Promise.all([
      input.executeBrowserTool(input.tabId, 'extract_page_structured_data', {}).then(normalizeToolResult).catch(() => null),
      input.executeBrowserTool(input.tabId, 'extract_page_tables', {}).then(normalizeToolResult).catch(() => null),
      input.executeBrowserTool(input.tabId, 'get_page_info', { include_html: false }).then(normalizeToolResult).catch(() => null),
    ]);

    structuredData = structured ? {
      headings: Array.isArray(structured.headings) ? structured.headings.slice(0, 30) : [],
      fields: Array.isArray(structured.fields) ? structured.fields.slice(0, 80) : [],
      tables: Array.isArray(structured.tables) ? structured.tables.slice(0, 10) : [],
      lists: Array.isArray(structured.lists) ? structured.lists.slice(0, 20) : [],
    } : undefined;
    tableCandidates = Array.isArray(tables?.tables)
      ? tables.tables.slice(0, 10)
      : Array.isArray(structured?.tables)
        ? structured.tables.slice(0, 10)
        : [];
    pageTextPreview = typeof pageInfo?.text === 'string' ? pageInfo.text.slice(0, 4000) : '';
  }

  return {
    observation,
    structuredData,
    pageTextPreview,
    navigationCandidates: getNavigationCandidates(observation.elements, [
      ...(input.intent.navigationPath || []),
      ...(input.intent.entities || []),
    ]),
    tableCandidates,
    actionCandidates: getActionCandidates(observation.elements),
  };
}
