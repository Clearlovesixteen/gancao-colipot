import type {
  ComputerUseAction,
  ComputerUseDownloadResult,
  ComputerUseIntent,
  ComputerUsePageContext,
  ComputerUsePhase,
  ComputerUseRunState,
} from '../shared/automationTypes';
import { extractTablesFromComputerUseResult, summarizeExtractedTables } from '../shared/computerUseResults';

type PhaseHistoryEntry = {
  action?: ComputerUseAction;
  result?: unknown;
  verification?: unknown;
};

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function compactText(text?: string): string {
  return String(text || '').replace(/\s+/g, '').trim();
}

function samePath(left?: string[], right?: string[]): boolean {
  const a = (left || []).map(compactText).filter(Boolean);
  const b = (right || []).map(compactText).filter(Boolean);
  return a.length > 0 && a.length === b.length && a.every((item, index) => item === b[index]);
}

function includesCompact(text: string, target?: string): boolean {
  const haystack = compactText(text);
  const needle = compactText(target);
  return Boolean(needle && haystack.includes(needle));
}

function isFileCenterTarget(target?: string): boolean {
  return /(文件中心|filecenter|file-center|文件列表)/i.test(String(target || ''));
}

function hasFileCenterRoute(context: ComputerUsePageContext): boolean {
  return /file[-_]?center|fileCenter|files/i.test(context.observation.url || '');
}

function hasFileListEvidence(context: ComputerUsePageContext): boolean {
  return Boolean((context.collections || []).some((collection) => collection.type === 'file_list' && collection.items.length > 0))
    || /(搜索文件名|文件名称|文件大小|下载时间|文件中心)/.test(context.pageTextPreview || '');
}

function safeDecodeUrl(value?: string): string {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function isOpenSiteReached(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  if (!phase.startUrl) return false;
  try {
    const expected = new URL(phase.startUrl);
    const actual = new URL(context.observation.url || '');
    return expected.hostname.replace(/^www\./, '') === actual.hostname.replace(/^www\./, '');
  } catch {
    return includesCompact(`${context.observation.url} ${context.observation.title}`, phase.startUrl);
  }
}

function isSearchResultReached(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  const query = phase.query || phase.targets?.[0];
  const decodedUrl = safeDecodeUrl(context.observation.url);
  if (context.observation.pageState?.kind === 'result_page' && (!query || decodedUrl.includes(query))) return true;
  if (/[?&](wd|q|search_query)=/i.test(decodedUrl) && (!query || decodedUrl.includes(query))) return true;
  return Boolean(query && context.observation.title?.includes(query) && /(搜索|search|百度|bing|google|youtube)/i.test(context.observation.title));
}

function isCollectionItemSelected(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  if (phase.collectionType === 'search_results' || phase.query) {
    return !isSearchResultReached(phase, context);
  }
  return isPhaseTargetReached({ ...phase, type: 'open_page_or_center' }, context);
}

function isSuccessfulDownloadResult(result: any): boolean {
  const data = normalizeToolResult(result);
  return data?.success === true && (data.status === 'completed' || data.status === 'partial') && Boolean(data.downloadId || data.filename);
}

function makeDownloadSummary(result: unknown): string | null {
  const data = normalizeToolResult(result);
  if (!isSuccessfulDownloadResult(data)) return null;
  if (data.savedToDocumentCenter && data.assetId) {
    return `已导出文件：${data.filename || data.assetTitle || '下载文件'}，并保存到资料中心（资料 ID：${data.assetId}）。`;
  }
  return `已触发下载：${data.filename || '下载文件'}，但无法自动读取文件内容，请从下载目录手动添加。`;
}

function makeExtractedTableSummary(result: unknown, pageTitle?: string): string | null {
  const summary = summarizeExtractedTables(extractTablesFromComputerUseResult(result));
  if (!summary) return null;
  const page = pageTitle ? `，页面：${pageTitle}` : '';
  return `已提取到 ${summary.tableCount} 个表格，共 ${summary.rowCount} 行${page}。`;
}

function isDataCompletionIntent(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'data_extraction'
    || intent.taskType === 'download'
    || intent.desiredOutput === 'table_data'
    || intent.desiredOutput === 'download_file'
    || /(列表|表格|数据|导出|下载|提取|获取|读取)/i.test(intent.rawGoal);
}

function isNavigationPhaseReached(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  const path = (phase.navigationPath?.length ? phase.navigationPath : phase.targets || []).filter(Boolean);
  if (!path.length) return true;
  const leaf = path[path.length - 1];
  const parents = path.slice(0, -1);

  const activeLeafWithParent = context.observation.elements.some((element) => {
    if (!element.active) return false;
    const elementText = compactText(element.text);
    const leafText = compactText(leaf);
    const textMatchesLeaf = elementText === leafText || (elementText.includes(leafText) && elementText.length <= leafText.length + 8);
    if (!textMatchesLeaf) return false;
    if (!parents.length) return true;
    const contextText = `${element.text} ${element.context || ''} ${element.parentText || ''}`;
    return parents.some((parent) => includesCompact(contextText, parent));
  });
  if (activeLeafWithParent) return true;

  const activeEvidence = [
    ...context.observation.elements
      .filter((element) => element.active)
      .map((element) => ({
        text: element.text,
        evidence: [element.text, element.context, element.parentText, element.href].filter(Boolean).join(' '),
      })),
    ...(context.collections || []).flatMap((collection) => collection.items
      .filter((item) => item.active)
      .map((item) => ({
        text: item.text,
        evidence: [
          collection.title,
          item.text,
          item.context,
          item.parentText,
          item.parentPath?.join(' '),
          item.href,
        ].filter(Boolean).join(' '),
      }))),
  ];
  const activeLeaf = activeEvidence.some((item) => {
    const itemText = compactText(item.text);
    const leafText = compactText(leaf);
    return itemText === leafText || (itemText.includes(leafText) && itemText.length <= leafText.length + 8);
  });
  const activeParents = parents.length === 0 || parents.every((parent) => (
    activeEvidence.some((item) => includesCompact(item.evidence, parent))
  ));
  if (activeLeaf && activeParents) return true;

  const pageChrome = [
    context.observation.title,
    context.observation.url,
    context.structuredData?.headings?.join(' '),
  ].filter(Boolean).join(' ');
  return includesCompact(pageChrome, leaf)
    && (!parents.length || parents.some((parent) => includesCompact(pageChrome, parent)));
}

function getPageEvidenceText(context: ComputerUsePageContext): string {
  return [
    context.observation.title,
    context.observation.url,
    context.pageTextPreview,
    context.structuredData?.headings?.join(' '),
    context.observation.elements
      .filter((element) => element.active || element.visible)
      .slice(0, 80)
      .map((element) => [
        element.active ? 'active' : '',
        element.text,
        element.context,
        element.parentText,
        element.href,
      ].filter(Boolean).join(' '))
      .join(' '),
  ].filter(Boolean).join(' ');
}

function getStrongPageEvidenceText(context: ComputerUsePageContext): string {
  return [
    context.observation.title,
    context.observation.url,
    context.pageTextPreview,
    context.structuredData?.headings?.join(' '),
    context.observation.elements
      .filter((element) => element.active)
      .slice(0, 30)
      .map((element) => [
        'active',
        element.text,
        element.context,
        element.parentText,
        element.href,
      ].filter(Boolean).join(' '))
      .join(' '),
  ].filter(Boolean).join(' ');
}

export function getPhaseTargets(phase: ComputerUsePhase, runState?: ComputerUseRunState): string[] {
  const targets = [
    ...(phase.targets || []),
    ...(phase.navigationPath || []),
    phase.query,
  ];
  const downloadName = runState?.downloadResult?.filename || runState?.downloadResult?.assetTitle;
  if (phase.type === 'click_latest_download' && downloadName) {
    targets.push(downloadName);
    const basename = String(downloadName).split(/[\\/]/).filter(Boolean).pop();
    if (basename) targets.push(basename);
  }
  return targets.filter((target): target is string => Boolean(target));
}

export function isPhaseTargetReached(phase: ComputerUsePhase, context: ComputerUsePageContext, runState?: ComputerUseRunState): boolean {
  if (phase.type === 'open_site') return isOpenSiteReached(phase, context);
  if (phase.type === 'search') return isSearchResultReached(phase, context);
  if (phase.type === 'select_collection_item') return isCollectionItemSelected(phase, context);
  if (phase.type === 'navigate_to_page') {
    const path = phase.navigationPath?.length ? phase.navigationPath : phase.targets || [];
    if (runState?.completedPhases.some((item) => (
      item.success
      && item.phase.type === 'navigate_to_page'
      && samePath(item.evidence?.matchedNavigationPath || item.phase.navigationPath || item.phase.targets, path)
    ))) {
      return true;
    }
    return isNavigationPhaseReached(phase, context);
  }
  const targets = getPhaseTargets(phase, runState);
  if (!targets.length) return false;
  if (phase.type === 'open_page_or_center' && targets.some(isFileCenterTarget)) {
    return hasFileCenterRoute(context) || hasFileListEvidence(context);
  }
  const evidence = phase.type === 'open_page_or_center' || phase.type === 'click_latest_download'
    ? getStrongPageEvidenceText(context)
    : getPageEvidenceText(context);
  return targets.some((target) => includesCompact(evidence, target));
}

export function isLatestDownloadOpened(phase: ComputerUsePhase, before: ComputerUsePageContext, after: ComputerUsePageContext, runState: ComputerUseRunState): boolean {
  const targets = getPhaseTargets(phase, runState);
  if (!targets.length) return false;
  const changed = before.observation.url !== after.observation.url
    || before.observation.title !== after.observation.title
    || before.observation.elements.length !== after.observation.elements.length;
  return changed && isPhaseTargetReached(phase, after, runState);
}

export function getPhaseFinishEvidence(input: {
  phase: ComputerUsePhase;
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  history: PhaseHistoryEntry[];
  runState: ComputerUseRunState;
}): { ok: boolean; reason?: string } {
  const lastResult = input.history[input.history.length - 1]?.result;
  if (input.phase.type === 'wait') return { ok: true };
  if (input.phase.type === 'open_site') {
    return isOpenSiteReached(input.phase, input.context)
      ? { ok: true }
      : { ok: false, reason: '当前 URL/title 未进入目标站点。' };
  }
  if (input.phase.type === 'search') {
    return isSearchResultReached(input.phase, input.context)
      ? { ok: true }
      : { ok: false, reason: '未进入包含目标关键词的搜索结果页。' };
  }
  if (input.phase.type === 'select_collection_item') {
    return isCollectionItemSelected(input.phase, input.context)
      ? { ok: true }
      : { ok: false, reason: '点击后仍停留在搜索结果页，未进入目标结果。' };
  }
  if (input.phase.type === 'navigate_to_page') {
    return isNavigationPhaseReached(input.phase, input.context)
      ? { ok: true }
      : { ok: false, reason: '未看到目标导航处于选中状态，也未在页面标题/URL 中看到目标页证据。' };
  }
  if (input.phase.type === 'download_file') {
    return input.runState.downloadResult || makeDownloadSummary(lastResult)
      ? { ok: true }
      : { ok: false, reason: '未捕获到下载完成或部分下载结果。' };
  }
  if (input.phase.type === 'fill_form') {
    const expectedValues = input.phase.formValues?.map((item) => item.value).filter(Boolean) || [];
    if (!expectedValues.length) return { ok: false, reason: '缺少要填写的字段和值。' };
    const text = getPageEvidenceText(input.context);
    return expectedValues.some((value) => includesCompact(text, value))
      ? { ok: true }
      : { ok: true, reason: '字段填写动作已执行，但当前观察结果未暴露字段值。' };
  }
  if (input.phase.type === 'click_action') {
    return input.history.some((item) => item.action?.action === 'click')
      ? { ok: true }
      : { ok: false, reason: '当前阶段还没有点击目标动作按钮。' };
  }
  if (input.phase.type === 'extract_data') {
    return makeExtractedTableSummary(lastResult, input.context.observation.title)
      ? { ok: true }
      : { ok: false, reason: '未提取到真实表格数据。' };
  }
  if (input.phase.type === 'open_page_or_center') {
    return isPhaseTargetReached(input.phase, input.context, input.runState)
      ? { ok: true }
      : { ok: false, reason: '未在当前页面看到目标入口/页面已打开的正向证据。' };
  }
  if (input.phase.type === 'click_latest_download') {
    return isPhaseTargetReached(input.phase, input.context, input.runState)
      ? { ok: true }
      : { ok: false, reason: '未看到刚下载文件已打开或处于选中状态。' };
  }
  if (isDataCompletionIntent(input.intent)) {
    return makeDownloadSummary(lastResult) || makeExtractedTableSummary(lastResult, input.context.observation.title)
      ? { ok: true }
      : { ok: false, reason: '数据/导出类阶段没有交付下载文件或表格数据。' };
  }
  return input.history.some((item) => item.action)
    ? { ok: true }
    : { ok: false, reason: '当前阶段没有执行过可验证动作。' };
}

export function getDownloadResult(result: unknown): ComputerUseDownloadResult | undefined {
  const data = normalizeToolResult(result) as ComputerUseDownloadResult | undefined;
  if (!data || typeof data !== 'object') return undefined;
  return data;
}
