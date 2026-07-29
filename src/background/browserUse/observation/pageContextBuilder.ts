import type {
  BrowserObservation,
  ComputerUsePhase,
  ComputerUseIntent,
  ComputerUsePageContext,
  ObservedCollection,
  ObservedElement,
} from '../../../shared/automation/automationTypes';
import { buildObservedCollections } from './collectionBuilder';
import { evaluateObservationQuality } from './observationQuality';
import { derivePageSignals } from '../../../shared/context/pageSignals';

type ExecuteBrowserTool = (tabId: number, toolName: string, args: any) => Promise<any>;

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function requireUsableObservation(result: any): BrowserObservation {
  const observation = normalizeToolResult(result);
  if (!observation || observation.success === false || !Array.isArray(observation.elements)) {
    const detail = observation?.error || observation?.message || '页面尚未形成可观察 DOM';
    throw new Error(`PAGE_OBSERVATION_NOT_READY: ${detail}`);
  }
  return {
    ...observation,
    elements: observation.elements,
    // Older content scripts and a document mid-navigation can expose a partial
    // collection shell. Ignore those shells and rebuild semantics from elements.
    collections: Array.isArray(observation.collections)
      ? observation.collections.filter((collection: any) => (
        collection
        && typeof collection.type === 'string'
        && Array.isArray(collection.items)
      ))
      : [],
  } as BrowserObservation;
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
    || phase.type === 'open_page_or_center'
    || phase.type === 'click_latest_download'
    || (!phase.type && isDataIntent(intent));
}

function shouldCollectSearchResults(intent: ComputerUseIntent, phase?: ComputerUsePhase): boolean {
  return phase?.type === 'select_collection_item'
    || phase?.collectionType === 'search_results'
    || intent.taskType === 'search'
    || intent.desiredOutput === 'page_state' && Boolean(intent.query);
}

function buildSearchResultsCollection(result: any): ObservedCollection | null {
  if (result?.reliable === false) return null;
  const results = Array.isArray(result?.results) ? result.results : [];
  const items = results
    .filter((item: any) => item?.elementId || item?.selector || item?.href)
    .map((item: any, index: number) => ({
      index: Number(item.index || index + 1),
      text: String(item.title || item.text || item.href || `搜索结果 ${index + 1}`),
      elementId: item.elementId,
      selector: item.selector,
      href: item.href || item.url,
      context: item.snippet,
      bbox: item.bbox,
      purpose: 'search_result',
      sourceElementIds: item.elementId ? [item.elementId] : undefined,
      metadata: {
        url: item.url || item.href,
        snippet: item.snippet,
        region: item.region,
      },
      confidence: 0.88,
    }));
  if (!items.length) return null;
  return {
    id: 'collection_search_results_tool',
    type: 'search_results',
    title: '自然搜索结果',
    items,
    confidence: 0.9,
    metadata: {
      source: 'get_search_results',
      count: result?.count,
      verifiedNaturalResults: true,
      query: result?.query,
      url: result?.url,
    },
  };
}

function hasSearchResultRouteEvidence(observation: BrowserObservation, query?: string): boolean {
  let decodedUrl = observation.url || '';
  try {
    decodedUrl = decodeURIComponent(decodedUrl);
  } catch {
    // Keep the undecoded URL.
  }
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const hasQueryParameter = /[?&](wd|word|q|query|keyword|search_query)=/i.test(decodedUrl);
  if (!hasQueryParameter) return observation.pageState?.kind === 'result_page';
  return !normalizedQuery || decodedUrl.toLowerCase().includes(normalizedQuery);
}

function mergeCollections(collections: ObservedCollection[]): ObservedCollection[] {
  const merged: ObservedCollection[] = [];
  const seenCollections = new Set<string>();
  for (const collection of collections) {
    if (!collection || !Array.isArray(collection.items)) continue;
    const collectionKey = `${collection.type}:${collection.id}`;
    if (seenCollections.has(collectionKey)) continue;
    seenCollections.add(collectionKey);
    const seenItems = new Set<string>();
    const items = collection.items.filter((item) => {
      const key = `${item.index}:${item.elementId || item.selector || item.href || item.text}`;
      if (seenItems.has(key)) return false;
      seenItems.add(key);
      return true;
    });
    if (items.length) merged.push({ ...collection, items });
  }
  return merged;
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
    .filter((element) => [
      'download_button',
      'submit_button',
      'search_button',
      'save_button',
      'delete_button',
      'danger_button',
      'login_button',
    ].includes(element.purpose || '') && element.visible && element.enabled)
    .slice(0, 60);
}

export async function buildComputerUsePageContext(input: {
  tabId: number;
  intent: ComputerUseIntent;
  phase?: ComputerUsePhase;
  executeBrowserTool: ExecuteBrowserTool;
}): Promise<ComputerUsePageContext> {
  const observation = requireUsableObservation(await input.executeBrowserTool(input.tabId, 'observe_page', {
    includeScreenshot: false,
    limit: 520,
  }));

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

  let searchResultsCollection: ObservedCollection | null = null;
  if (shouldCollectSearchResults(input.intent, input.phase)) {
    const searchResults = await input.executeBrowserTool(input.tabId, 'get_search_results', { limit: 30 })
      .then(normalizeToolResult)
      .catch(() => null);
    searchResultsCollection = buildSearchResultsCollection(searchResults);
  }

  const rawObservationCollections = Array.isArray(observation.collections) ? observation.collections : [];
  const verifiedSearchContext = Boolean(searchResultsCollection)
    || hasSearchResultRouteEvidence(observation, input.phase?.query || input.intent.query);
  const collections = mergeCollections([
    ...rawObservationCollections.filter((collection) => collection.type !== 'search_results' || verifiedSearchContext),
    ...(searchResultsCollection ? [searchResultsCollection] : []),
    ...buildObservedCollections({ observation, tableCandidates, phase: input.phase })
      .filter((collection) => collection.type !== 'search_results' || verifiedSearchContext),
  ]);
  const observationQuality = evaluateObservationQuality({ observation, collections });
  const enrichedObservation: BrowserObservation = {
    ...observation,
    pageSignals: derivePageSignals({
      pageState: observation.pageState,
      existingSignals: observation.pageSignals,
      textPreview: pageTextPreview,
      title: observation.title,
    }),
    qualityReport: observationQuality,
  };

  return {
    observation: enrichedObservation,
    pageSignals: enrichedObservation.pageSignals || [],
    structuredData,
    pageTextPreview,
    navigationCandidates: getNavigationCandidates(observation.elements, [
      ...(input.intent.navigationPath || []),
      ...(input.intent.entities || []),
    ]),
    tableCandidates,
    actionCandidates: getActionCandidates(observation.elements),
    collections,
    observationQuality,
  };
}
