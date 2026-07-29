import type {
  BrowserObservation,
  ComputerUseAction,
  ComputerUseDownloadResult,
  ComputerUseErrorMessage,
  ComputerUseFinishedMessage,
  ComputerUsePhase,
  ComputerUsePhaseEvidence,
  ComputerUsePhaseMemory,
  ComputerUseIntent,
  ComputerUsePageContext,
  ComputerUsePlan,
  ComputerUseNeedsConfirmationMessage,
  ComputerUseProgressMessage,
  ComputerUseRunState,
  ComputerUseResumeCheckpoint,
  ComputerUseTaskPlan,
  ObservedElement,
  PlannedStep,
} from '../../../shared/automation/automationTypes';
import { buildComputerUsePageContext } from '../observation/pageContextBuilder';
import { createComputerUsePlan } from '../planning/computerUsePlanner';
import { understandComputerUseIntent } from '../planning/computerUseIntent';
import { verifyComputerUseStep } from '../verification/verifyComputerUseStep';
import { extractTablesFromComputerUseResult, summarizeExtractedTables } from '../../../shared/automation/computerUseResults';
import { resolvePlannedStepTarget } from '../resolution/targetResolver';
import {
  evaluatePhaseActionCompletion,
  getDownloadResult,
  getPhaseFinishEvidence,
  isLatestDownloadOpened,
  isPhaseTargetReached,
} from '../verification/phaseCompletion';
import { buildSearchUrl } from '../planning/computerUseTaskParser';
import { resolveBrowserUseActionTool } from '../actions/browserUseActionRegistry';
import { evaluatePhaseObservationGate } from '../observation/phaseObservationGate';
import { executeNavigationAwareAction } from '../resolution/navigationCoordinator';
import type { BrowserUseSession } from './browserUseSession';
import { executeBrowserUseTabAction, type BrowserUseTabActionDeps } from '../actions/browserUseTabActions';
import { resolvePlannedStepVariables } from './browserUseVariables';
import {
  BrowserUseFailure,
  fingerprintComputerUseContext,
  waitForStableBrowserState,
} from './browserUseReadiness';
import {
  createBrowserUseTargetLease,
  revalidateBrowserUseTargetLease,
} from './browserUseTargetLease';
import { validateBrowserUseOutcome } from './browserUseOutcomeValidator';

export type ComputerUseRunnerDeps = {
  tabId: number;
  runId: string;
  goal: string;
  maxSteps: number;
  startUrl?: string;
  allowHighRisk?: boolean;
  signal: AbortSignal;
  navigate: (tabId: number, url: string, waitFor: 'complete' | 'domcontentloaded' | 'none', timeoutMs: number, signal: AbortSignal) => Promise<void>;
  executeBrowserTool: (tabId: number, toolName: string, args: any) => Promise<any>;
  executeDownloadAction?: (input: { action: ComputerUseAction; pageUrl?: string; tabId: number }) => Promise<unknown>;
  tabSession?: BrowserUseSession;
  tabActionDeps?: BrowserUseTabActionDeps;
  understandIntent?: (input: { goal: string }) => Promise<ComputerUseIntent>;
  createPlan?: (input: {
    intent: ComputerUseIntent;
    context: ComputerUsePageContext;
    history: ComputerUseHistoryEntry[];
    phase?: ComputerUsePhase;
    runState?: ComputerUseRunState;
    phaseMemory?: ComputerUsePhaseMemory;
  }) => Promise<ComputerUsePlan>;
  planNextAction?: (input: {
    goal: string;
    stepIndex: number;
    observation: BrowserObservation;
    history: Array<{ action?: ComputerUseAction; result?: unknown }>;
  }) => Promise<ComputerUseAction>;
  confirmAction: (message: ComputerUseNeedsConfirmationMessage) => Promise<boolean>;
  emit: (msg: ComputerUseProgressMessage | ComputerUseNeedsConfirmationMessage | ComputerUseFinishedMessage | ComputerUseErrorMessage) => void;
  resumeCheckpoint?: ComputerUseResumeCheckpoint;
};

type ComputerUseHistoryEntry = {
  action?: ComputerUseAction;
  result?: unknown;
  verification?: unknown;
  plan?: ComputerUsePlan;
  intent?: ComputerUseIntent;
  beforeObservation?: BrowserObservation;
  afterObservation?: BrowserObservation;
  phase?: ComputerUsePhase;
  phaseIndex?: number;
  phaseResult?: unknown;
  downloadResult?: ComputerUseDownloadResult;
};

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function looksHighRisk(action: ComputerUseAction): boolean {
  if (action.highRisk === true) return true;
  const text = [
    action.reason,
    action.text,
    action.value,
    action.expect,
    action.summary,
    action.selector,
  ].filter(Boolean).join(' ');
  // Export/download is an explicitly requested Browser Use capability. Treating
  // every later reference to a downloaded file as high risk would pause safe
  // navigation such as opening that file in the document center.
  return /(提交|删除|支付|购买|下单|发送|确认|保存|修改|submit|delete|pay|buy|send|confirm|save|update)/i.test(text);
}

function actionNeedsFreshTarget(action: ComputerUseAction): boolean {
  return ![
    'finish', 'wait', 'scroll', 'extract_table', 'press_key', 'keyboard_shortcut',
    'open_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward', 'reload',
  ].includes(action.action) && action.x === undefined && action.y === undefined;
}

function plannedStepToAction(step: PlannedStep): ComputerUseAction {
  const actionText = step.action === 'type'
    ? step.value
    : step.target?.text;
  return {
    action: step.action,
    reason: step.rationale,
    elementId: step.target?.elementId,
    selector: step.target?.selector,
    parentPath: step.target?.parentPath,
    tabId: step.target?.tabId,
    x: step.target?.x,
    y: step.target?.y,
    text: actionText,
    // Keep the resolved href as a navigation hint for ordinary link clicks too.
    // The content action still performs the click; BrowserUseSession uses this
    // URL only to identify a noopener/noreferrer result tab reliably.
    url: step.action === 'open_tab'
      ? step.target?.href || step.value || step.target?.text
      : step.action === 'click'
        ? step.target?.href
        : undefined,
    value: step.value,
    key: step.action === 'press_key' || step.action === 'keyboard_shortcut' ? step.value : undefined,
    expect: step.verify?.value,
    highRisk: step.highRisk,
    summary: step.summary,
  };
}

function isDataCompletionIntent(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'data_extraction'
    || intent.taskType === 'download'
    || intent.desiredOutput === 'table_data'
    || intent.desiredOutput === 'download_file'
    || /(列表|表格|数据|导出|下载|提取|获取|读取)/i.test(intent.rawGoal);
}

function isDownloadCompletionIntent(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'download'
    || intent.desiredOutput === 'download_file'
    || /(导出|下载|download|export)/i.test(intent.rawGoal);
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

function getSinglePhaseTaskPlan(intent: ComputerUseIntent): ComputerUseTaskPlan {
  const phaseType: ComputerUsePhase['type'] = intent.taskType === 'download' || intent.desiredOutput === 'download_file'
    ? 'download_file'
    : intent.navigationPath?.length
      ? 'navigate_to_page'
      : 'generic';
  return {
    rawGoal: intent.rawGoal,
    summary: intent.objective || intent.rawGoal,
    phases: [{
      id: 'single_phase',
      type: phaseType,
      goal: intent.objective || intent.rawGoal,
      targets: intent.navigationPath?.length ? intent.navigationPath : intent.entities,
      navigationPath: intent.navigationPath,
    }],
  };
}

function buildPhaseIntent(base: ComputerUseIntent, phase: ComputerUsePhase): ComputerUseIntent {
  if (phase.type === 'open_site') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'navigation',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      startUrl: phase.startUrl || base.startUrl,
      siteName: phase.siteName || base.siteName,
      navigationPath: phase.navigationPath,
    };
  }

  if (phase.type === 'search') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'search',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      startUrl: phase.startUrl || base.startUrl,
      siteName: phase.siteName || base.siteName,
      query: phase.query || base.query,
      navigationPath: phase.navigationPath,
    };
  }

  if (phase.type === 'select_collection_item') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'search',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      query: phase.query || base.query,
      targetResultIndex: phase.ordinal || base.targetResultIndex,
      navigationPath: phase.navigationPath,
    };
  }

  if (phase.type === 'download_file') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'download',
      desiredOutput: 'download_file',
      entities: phase.targets?.length ? phase.targets : base.entities,
      navigationPath: phase.navigationPath || base.navigationPath,
    };
  }

  if (phase.type === 'fill_form') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'form',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      navigationPath: phase.navigationPath,
    };
  }

  if (phase.type === 'click_action') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'form',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      navigationPath: phase.navigationPath,
    };
  }

  if (phase.type === 'navigate_to_page') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'navigation',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : base.entities,
      navigationPath: phase.navigationPath || base.navigationPath,
    };
  }

  if (phase.type === 'open_page_or_center' || phase.type === 'click_latest_download') {
    return {
      ...base,
      rawGoal: phase.goal,
      objective: phase.goal,
      taskType: 'navigation',
      desiredOutput: 'page_state',
      entities: phase.targets?.length ? phase.targets : [],
      navigationPath: phase.navigationPath,
    };
  }

  return {
    ...base,
    rawGoal: phase.goal,
    objective: phase.goal,
    entities: phase.targets?.length ? phase.targets : base.entities,
    navigationPath: phase.navigationPath || base.navigationPath,
  };
}

function compactText(text?: string): string {
  return String(text || '').replace(/\s+/g, '').trim();
}

function actionTouchesPhaseLeaf(action: ComputerUseAction, phase: ComputerUsePhase): boolean {
  const leaf = phase.navigationPath?.[phase.navigationPath.length - 1] || phase.targets?.[phase.targets.length - 1];
  if (!leaf) return true;
  const actionText = compactText(action.text);
  const leafText = compactText(leaf);
  if (!actionText || !leafText) return false;
  return actionText === leafText || (actionText.includes(leafText) && actionText.length <= leafText.length + 8);
}

function actionParentPathMatchesPhase(action: ComputerUseAction, phase: ComputerUsePhase): boolean {
  const phaseParents = (phase.navigationPath || []).slice(0, -1).map(compactText).filter(Boolean);
  if (!phaseParents.length) return true;
  const actionParents = (action.parentPath || []).map(compactText).filter(Boolean);
  if (!actionParents.length) return false;
  return phaseParents.every((parent) => actionParents.some((item) => item === parent || item.includes(parent) || parent.includes(item)));
}

function pageRouteChanged(before: ComputerUsePageContext, after: ComputerUsePageContext): boolean {
  const beforeUrl = before.observation.url || '';
  const afterUrl = after.observation.url || '';
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) return false;
  try {
    const beforeParsed = new URL(beforeUrl);
    const afterParsed = new URL(afterUrl);
    return beforeParsed.origin !== afterParsed.origin
      || beforeParsed.pathname !== afterParsed.pathname
      || beforeParsed.hash !== afterParsed.hash;
  } catch {
    return beforeUrl !== afterUrl;
  }
}

function samePath(left?: string[], right?: string[]): boolean {
  const a = (left || []).map(compactText).filter(Boolean);
  const b = (right || []).map(compactText).filter(Boolean);
  return a.length > 0 && a.length === b.length && a.every((item, index) => item === b[index]);
}

function phaseTargetsForEvidence(phase: ComputerUsePhase): string[] {
  return [
    ...(phase.navigationPath || []),
    ...(phase.targets || []),
    phase.query,
    phase.siteName,
  ].filter((value): value is string => Boolean(value));
}

function activeTextsFromContext(context: ComputerUsePageContext): string[] {
  return Array.from(new Set([
    ...context.observation.elements
      .filter((element) => element.active)
      .map((element) => [element.text, element.context, element.parentText].filter(Boolean).join(' ')),
    ...(context.collections || []).flatMap((collection) => collection.items
      .filter((item) => item.active)
      .map((item) => [collection.title, item.text, item.context, item.parentText, item.parentPath?.join(' ')].filter(Boolean).join(' '))),
  ].map((value) => value.trim()).filter(Boolean))).slice(0, 30);
}

function visibleActionPurposesFromContext(context: ComputerUsePageContext): string[] {
  return Array.from(new Set([
    ...context.actionCandidates.map((element) => element.purpose || 'generic'),
    ...(context.collections || []).flatMap((collection) => collection.type === 'action_group'
      ? collection.items.map((item) => String(item.purpose || item.metadata?.purpose || 'generic'))
      : []),
  ].filter(Boolean))).slice(0, 30);
}

function evidenceText(context: ComputerUsePageContext): string {
  return [
    context.observation.title,
    context.observation.url,
    context.pageTextPreview,
    context.structuredData?.headings?.join(' '),
    activeTextsFromContext(context).join(' '),
    (context.collections || []).flatMap((collection) => collection.items.slice(0, 40).map((item) => [
      collection.title,
      item.text,
      item.context,
      item.parentText,
      item.parentPath?.join(' '),
    ].filter(Boolean).join(' '))).join(' '),
  ].filter(Boolean).join(' ');
}

function buildPhaseEvidence(input: {
  phase: ComputerUsePhase;
  before?: ComputerUsePageContext;
  after: ComputerUsePageContext;
  action?: ComputerUseAction;
}): ComputerUsePhaseEvidence {
  const text = evidenceText(input.after);
  const targets = phaseTargetsForEvidence(input.phase);
  const matchedTargets = targets.filter((target) => compactText(text).includes(compactText(target)));
  const navigationPath = input.phase.navigationPath || [];
  const navigationReached = input.phase.type === 'navigate_to_page' && (
    isPhaseTargetReached(input.phase, input.after)
    || (
      input.before
      && input.action
      && actionTouchesPhaseLeaf(input.action, input.phase)
      && actionParentPathMatchesPhase(input.action, input.phase)
      && pageRouteChanged(input.before, input.after)
    )
  );
  return {
    urlBefore: input.before?.observation.url,
    urlAfter: input.after.observation.url,
    titleAfter: input.after.observation.title,
    routeChanged: input.before ? pageRouteChanged(input.before, input.after) : undefined,
    activeTexts: activeTextsFromContext(input.after),
    matchedTargets,
    matchedNavigationPath: navigationReached ? navigationPath : undefined,
    visibleActionPurposes: visibleActionPurposesFromContext(input.after),
  };
}

function hasCompletedNavigationPath(runState: ComputerUseRunState, expectedPath: string[]): boolean {
  return runState.completedPhases.some((item) => (
    item.success
    && item.phase.type === 'navigate_to_page'
    && samePath(item.evidence?.matchedNavigationPath || item.phase.navigationPath || item.phase.targets, expectedPath)
  ));
}

function looksUnstable(context: ComputerUsePageContext): boolean {
  const text = [
    context.pageTextPreview,
    context.observation.elements.slice(0, 50).map((element) => element.text || element.context).join(' '),
  ].join(' ');
  return /(加载中|请稍候|loading|spinner|skeleton)/i.test(text)
    || !context.observation.url
    || /^about:(blank|newtab)/i.test(context.observation.url);
}

function makePhaseSummary(phase: ComputerUsePhase, result?: unknown): string {
  const download = getDownloadResult(result);
  if (download?.filename || download?.downloadId) {
    return download.savedToDocumentCenter && download.assetId
      ? `已下载并入库：${download.filename || download.assetTitle || '下载文件'}`
      : `已触发下载：${download.filename || '下载文件'}`;
  }
  return phase.goal;
}

function finalSummary(runState: ComputerUseRunState, fallback: string): string {
  const download = runState.downloadResult;
  if (!download) {
    const extracted = [...runState.completedPhases]
      .reverse()
      .map((item) => makeExtractedTableSummary(item.result))
      .find(Boolean);
    return extracted || fallback;
  }
  const fileText = download.filename || download.assetTitle || '下载文件';
  const opened = runState.completedPhases.some((item) => item.phase.type === 'click_latest_download')
    ? '，并已打开刚下载文件'
    : '';
  const assetText = download.savedToDocumentCenter && download.assetId
    ? `，资料 ID：${download.assetId}`
    : download.needsManualImport
      ? '，但未能自动入库内容，需要手动导入'
      : '';
  const partial = download.status === 'partial' || !download.savedToDocumentCenter ? '（部分完成）' : '';
  return `自动操作完成${partial}：已导出文件：${fileText}${assetText}${opened}。`;
}

function safeDecodeUrl(value?: string): string {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function isSearchResultObservation(observation: BrowserObservation, query?: string): boolean {
  const decodedUrl = safeDecodeUrl(observation.url);
  const normalizedQuery = String(query || '').trim();
  if (observation.pageState?.kind === 'result_page' && (!normalizedQuery || decodedUrl.includes(normalizedQuery))) return true;
  if (/[?&](wd|word|q|query|keyword|search_query)=/i.test(decodedUrl) && (!normalizedQuery || decodedUrl.includes(normalizedQuery))) return true;
  return Boolean(normalizedQuery && observation.title?.includes(normalizedQuery) && /(搜索|search|百度|bing|google|youtube)/i.test(observation.title));
}

function hasNaturalSearchResults(context: ComputerUsePageContext): boolean {
  return Boolean((context.collections || []).some((collection) => (
    collection.type === 'search_results'
    && collection.items.length > 0
    && collection.metadata?.verifiedNaturalResults === true
  )));
}

function isSearchResultContext(context: ComputerUsePageContext, query?: string): boolean {
  return isSearchResultObservation(context.observation, query) || hasNaturalSearchResults(context);
}

function getSearchBlocker(context: ComputerUsePageContext): string | undefined {
  const state = context.observation.pageState;
  if (state?.hasCaptcha) return '搜索站点要求完成验证码或安全验证，扩展不能代替用户通过验证。';
  if (state?.hasPermissionDenied || state?.kind === 'permission_page') return '搜索结果页返回了权限不足页面。';
  if (state?.kind === 'login_page' && !state.searchInputId && !state.mainInputId) return '搜索站点要求先登录。';
  return undefined;
}

function hasDownloadCandidate(context: ComputerUsePageContext): boolean {
  return context.actionCandidates.some((element) => element.purpose === 'download_button')
    || Boolean((context.collections || []).some((collection) => (
      collection.type === 'action_group'
      && collection.items.some((item) => item.purpose === 'download_button' || item.metadata?.purpose === 'download_button')
    )));
}

function validatePhasePreconditions(input: {
  phase: ComputerUsePhase;
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  runState: ComputerUseRunState;
}): { ok: boolean; reason?: string; missing?: string[] } {
  if (input.phase.type === 'download_file') {
    const expectedPath = input.phase.navigationPath?.length
      ? input.phase.navigationPath
      : input.phase.collectionType === 'table_row_group' || input.phase.ordinal
        ? []
      : input.intent.navigationPath || [];
    if (expectedPath.length) {
      const reached = hasCompletedNavigationPath(input.runState, expectedPath) || isPhaseTargetReached({
        ...input.phase,
        type: 'navigate_to_page',
        targets: expectedPath,
        navigationPath: expectedPath,
      }, input.context, input.runState);
      if (!reached && !hasDownloadCandidate(input.context)) {
        return {
          ok: false,
          missing: ['target_page', 'download_button'],
          reason: `尚未进入目标页面「${expectedPath.join(' > ')}」，且当前页面没有真实导出/下载按钮。`,
        };
      }
    }
  }

  if (input.phase.type === 'click_latest_download' && !input.runState.downloadResult) {
    return {
      ok: false,
      missing: ['download_result'],
      reason: '点击刚下载文件前缺少下载结果：前序 download_file 阶段没有产生可用的文件名或下载记录。',
    };
  }

  return { ok: true };
}

function normalizedDestinationUrl(value?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value.trim();
  }
}

function hasLeftSearchResults(
  before: BrowserObservation,
  after: BrowserObservation,
  query?: string,
  expectedUrl?: string,
): boolean {
  if (!after?.url) return false;
  const actualDestination = normalizedDestinationUrl(after.url);
  const expectedDestination = normalizedDestinationUrl(expectedUrl);
  if (expectedDestination && actualDestination === expectedDestination) return true;
  if (after.url !== before.url) {
    try {
      if (new URL(after.url).origin !== new URL(before.url).origin) return true;
    } catch {
      // Fall through to the semantic search-page check for non-standard URLs.
    }
  }
  if (after.url !== before.url && !isSearchResultObservation(after, query)) return true;
  if (after.title && before.title && after.title !== before.title && !/(搜索|百度|bing|google|youtube)/i.test(after.title)) return true;
  return false;
}

function bestSearchInput(observation: BrowserObservation): ObservedElement | undefined {
  const stateId = observation.pageState?.searchInputId || observation.pageState?.mainInputId;
  if (stateId) return observation.elements.find((element) => element.elementId === stateId);
  return observation.elements
    .filter((element) => element.purpose === 'search_input' || element.role === 'textbox')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
}

function bestSearchButton(observation: BrowserObservation): ObservedElement | undefined {
  const stateId = observation.pageState?.searchButtonId || observation.pageState?.primaryButtonId;
  if (stateId) return observation.elements.find((element) => element.elementId === stateId);
  return observation.elements
    .filter((element) => element.purpose === 'search_button' || element.role === 'button')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
}

export class ComputerUseRunner {
  private readonly history: ComputerUseHistoryEntry[] = [];
  private readonly phaseMemories = new Map<string, ComputerUsePhaseMemory>();
  private failureCount = 0;

  constructor(private readonly deps: ComputerUseRunnerDeps) {}

  private get tabId(): number {
    return this.deps.tabSession?.getCurrentTabId() || this.deps.tabId;
  }

  private async syncBrowserSession(runState?: ComputerUseRunState, expectedUrl?: string): Promise<void> {
    if (!this.deps.tabSession) return;
    const synced = await this.deps.tabSession.syncAfterAction({
      expectedUrl,
      allowActiveNewTab: true,
    });
    if (!runState) return;
    runState.browserSession = synced.snapshot;
    if (synced.switched) {
      runState.warnings = [
        ...(runState.warnings || []),
        `Browser Use 已接管新标签页 ${synced.currentTabId}`,
      ];
    }
  }

  private async executeAction(action: ComputerUseAction, runState: ComputerUseRunState, pageUrl?: string): Promise<unknown> {
    const tool = resolveBrowserUseActionTool(action);
    const waitMs = Number(action.timeoutMs || action.value || 1000);
    if (tool.toolName === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
      return { success: true, message: '等待完成' };
    }
    const tabId = this.tabId;
    if (tool.descriptor.scope === 'browser') {
      if (!this.deps.tabSession || !this.deps.tabActionDeps) {
        throw new Error(`Browser Use 标签页动作不可用：${action.action}`);
      }
      const result = await executeBrowserUseTabAction({
        action,
        session: this.deps.tabSession,
        deps: this.deps.tabActionDeps,
      });
      runState.browserSession = this.deps.tabSession.snapshot();
      return result;
    }
    const outcome = await executeNavigationAwareAction({
      mayNavigate: Boolean(tool.descriptor.mayOpenNewTab),
      execute: async () => (
        tool.toolName === 'download_file' && this.deps.executeDownloadAction
          ? await this.deps.executeDownloadAction({ action, pageUrl, tabId })
          : await this.deps.executeBrowserTool(tabId, tool.toolName, tool.args)
      ),
      synchronize: tool.descriptor.mayOpenNewTab
        ? async () => await this.syncBrowserSession(runState, action.url)
        : undefined,
    });
    if (outcome.warning && !runState.warnings?.includes(outcome.warning)) {
      runState.warnings = [...(runState.warnings || []), outcome.warning];
    }
    return outcome.result;
  }

  private getPhaseMemory(phase: ComputerUsePhase): ComputerUsePhaseMemory {
    const phaseId = phase.id || `${phase.type}:${phase.goal}`;
    let memory = this.phaseMemories.get(phaseId);
    if (!memory) {
      memory = { phaseId, attempts: 0, failedCandidates: [] };
      this.phaseMemories.set(phaseId, memory);
    }
    return memory;
  }

  private async waitForSearchResultContext(input: {
    intent: ComputerUseIntent;
    phase: ComputerUsePhase;
    initial?: ComputerUsePageContext;
    attempts?: number;
  }): Promise<ComputerUsePageContext> {
    let context = input.initial || await this.observePhase(input.intent, input.phase);
    const attempts = Math.max(1, input.attempts ?? 7);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const blocker = getSearchBlocker(context);
      if (blocker) throw new Error(blocker);
      if (isSearchResultContext(context, input.phase.query || input.intent.query)) return context;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        context = await this.observePhase(input.intent, input.phase);
      }
    }
    return context;
  }

  private async waitForCollectionItemContext(input: {
    intent: ComputerUseIntent;
    phase: ComputerUsePhase;
    collectionType: NonNullable<ComputerUsePhase['collectionType']>;
    ordinal: number;
    attempts?: number;
  }): Promise<ComputerUsePageContext> {
    const attempts = Math.max(1, input.attempts ?? 9);
    let context = await this.observePhase(input.intent, input.phase);
    let previousFingerprint = '';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const blocker = getSearchBlocker(context);
      if (blocker) throw new Error(blocker);
      const collection = (context.collections || []).find((item) => item.type === input.collectionType);
      const requestedItemExists = Boolean(collection?.items.some((item) => Number(item.index) === input.ordinal));
      const verifiedSearchCollection = input.collectionType !== 'search_results'
        || collection?.metadata?.verifiedNaturalResults === true;
      const fingerprint = requestedItemExists && verifiedSearchCollection
        ? collection!.items
          .slice(0, Math.max(input.ordinal, 5))
          .map((item) => `${item.index}:${item.href || item.text || item.elementId}`)
          .join('|')
        : '';
      // Dynamic search pages often expose skeletons or stale home-page modules for
      // one paint. Require the same ordered result set twice before clicking.
      if (fingerprint && fingerprint === previousFingerprint) return context;
      previousFingerprint = fingerprint;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        context = await this.observePhase(input.intent, input.phase);
      }
    }
    return context;
  }

  private rememberFailedCandidate(memory: ComputerUsePhaseMemory, action: ComputerUseAction, reason?: string): void {
    const elementId = action.elementId || undefined;
    const selector = action.selector || undefined;
    const text = action.text || action.value || action.reason || undefined;
    const existing = memory.failedCandidates.find((candidate) => (
      candidate.action === action.action
      && (
        (elementId && candidate.elementId === elementId)
        || (selector && candidate.selector === selector)
        || (!elementId && !selector && text && candidate.text === text)
      )
    ));
    if (existing) {
      existing.count += 1;
      existing.reason = reason || existing.reason;
      return;
    }
    memory.failedCandidates.push({
      action: action.action,
      elementId,
      selector,
      text,
      reason,
      count: 1,
    });
  }

  private async observePhase(intent: ComputerUseIntent, phase: ComputerUsePhase): Promise<ComputerUsePageContext> {
    return await buildComputerUsePageContext({
      tabId: this.tabId,
      intent,
      phase,
      executeBrowserTool: this.deps.executeBrowserTool,
    });
  }

  private async observeAfterAction(
    intent: ComputerUseIntent,
    phase: ComputerUsePhase,
    runState: ComputerUseRunState,
    action?: ComputerUseAction,
  ): Promise<ComputerUsePageContext> {
    const ready = await waitForStableBrowserState({
      observe: async () => await this.observePhase(intent, phase),
      synchronize: async () => await this.syncBrowserSession(runState),
      isReady: (context) => Boolean(
        context.observation.url
        && !/^about:(blank|newtab)/i.test(context.observation.url)
        && !looksUnstable(context)
      ),
      fingerprint: (context) => fingerprintComputerUseContext(context, phase),
      attempts: 12,
      stableSamples: action?.action === 'extract_table' ? 1 : 2,
      delayMs: 250,
      signal: this.deps.signal,
      description: `阶段「${phase.goal}」动作后的页面`,
    });
    return ready.value;
  }

  private async observeStablePhase(
    intent: ComputerUseIntent,
    phase: ComputerUsePhase,
    runState: ComputerUseRunState
  ): Promise<ComputerUsePageContext> {
    const ready = await waitForStableBrowserState({
      observe: async () => await this.observePhase(intent, phase),
      synchronize: async () => await this.syncBrowserSession(runState),
      isReady: (context) => Boolean(
        context.observation.url
        && !/^about:(blank|newtab)/i.test(context.observation.url)
        && !looksUnstable(context)
      ),
      fingerprint: (context) => fingerprintComputerUseContext(context, phase),
      attempts: 12,
      stableSamples: 2,
      delayMs: 150,
      signal: this.deps.signal,
      description: `阶段「${phase.goal}」执行前页面`,
    });
    return ready.value;
  }

  private emitPhaseProgress(input: {
    stepIndex: number;
    state: ComputerUseProgressMessage['state'];
    phaseIndex: number;
    phase: ComputerUsePhase;
    intent: ComputerUseIntent;
    runState: ComputerUseRunState;
    observation?: BrowserObservation;
    action?: ComputerUseAction;
    result?: unknown;
    beforeObservation?: BrowserObservation;
    afterObservation?: BrowserObservation;
    targetResolution?: ComputerUseProgressMessage['targetResolution'];
  }): void {
    this.deps.emit({
      type: 'COMPUTER_USE_PROGRESS',
      runId: this.deps.runId,
      goal: this.deps.goal,
      stepIndex: input.stepIndex,
      state: input.state,
      observation: input.observation,
      action: input.action,
      intent: input.intent,
      phaseIndex: input.phaseIndex,
      phaseType: input.phase.type,
      phaseGoal: input.phase.goal,
      phase: input.phase,
      runState: input.runState,
      beforeObservation: input.beforeObservation,
      afterObservation: input.afterObservation,
      targetResolution: input.targetResolution,
      result: input.result,
    });
  }

  private async runOpenSitePhase(input: {
    phase: ComputerUsePhase;
    intent: ComputerUseIntent;
    phaseIndex: number;
    stepIndex: number;
    runState: ComputerUseRunState;
  }): Promise<number> {
    const startUrl = input.phase.startUrl || input.intent.startUrl;
    if (!startUrl) throw new Error(`阶段「${input.phase.goal}」缺少起始网址。`);
    const action: ComputerUseAction = {
      action: input.phase.openInNewTab ? 'open_tab' : 'click',
      reason: `打开页面：${startUrl}`,
      url: input.phase.openInNewTab ? startUrl : undefined,
      expect: `进入 ${startUrl}`,
    };
    this.emitPhaseProgress({
      stepIndex: input.stepIndex,
      state: 'acting',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      action,
    });
    if (input.phase.openInNewTab) {
      await this.executeAction(action, input.runState);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      await this.deps.navigate(this.tabId, startUrl, 'complete', 30000, this.deps.signal);
      await this.syncBrowserSession(input.runState);
    }
    const afterContext = await this.observePhase(input.intent, input.phase);
    const result = { success: true, url: afterContext.observation.url, title: afterContext.observation.title };
    this.history.push({
      action,
      result,
      verification: { success: true },
      intent: input.intent,
      afterObservation: afterContext.observation,
      phase: input.phase,
      phaseIndex: input.phaseIndex,
    });
    input.runState.completedPhases.push({
      phase: input.phase,
      success: true,
      summary: input.phase.goal,
      result,
      evidence: buildPhaseEvidence({ phase: input.phase, after: afterContext, action }),
    });
    this.emitPhaseProgress({
      stepIndex: input.stepIndex,
      state: 'done',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: afterContext.observation,
      action,
      result,
      afterObservation: afterContext.observation,
    });
    return input.stepIndex + 1;
  }

  private async runSearchPhase(input: {
    phase: ComputerUsePhase;
    intent: ComputerUseIntent;
    phaseIndex: number;
    stepIndex: number;
    runState: ComputerUseRunState;
  }): Promise<number> {
    const query = input.phase.query || input.intent.query || input.phase.targets?.[0];
    if (!query) throw new Error(`阶段「${input.phase.goal}」缺少搜索关键词。`);
    let stepIndex = input.stepIndex;
    let context = await this.observePhase(input.intent, input.phase);
    this.emitPhaseProgress({
      stepIndex,
      state: 'planning',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: context.observation,
      result: { summary: `准备搜索：${query}` },
    });

    const inputElement = bestSearchInput(context.observation);
    if (!inputElement) {
      const fallbackUrl = buildSearchUrl({
        rawGoal: input.intent.rawGoal,
        startUrl: input.phase.startUrl || input.intent.startUrl,
        siteName: input.phase.siteName || input.intent.siteName,
        actionType: 'search',
        query,
        riskLevel: input.intent.riskLevel,
      });
      if (!fallbackUrl) throw new Error(`阶段「${input.phase.goal}」未找到搜索输入框，也无法构造搜索结果 URL。`);
      const fallbackAction: ComputerUseAction = {
        action: 'click',
        reason: `未找到搜索框，直接打开搜索结果页：${fallbackUrl}`,
        expect: `进入 ${query} 搜索结果页`,
      };
      this.emitPhaseProgress({
        stepIndex,
        state: 'recovering',
        phaseIndex: input.phaseIndex,
        phase: input.phase,
        intent: input.intent,
        runState: input.runState,
        observation: context.observation,
        action: fallbackAction,
      });
      await this.deps.navigate(this.tabId, fallbackUrl, 'complete', 30000, this.deps.signal);
      await this.syncBrowserSession(input.runState);
      const afterContext = await this.waitForSearchResultContext({ intent: input.intent, phase: input.phase });
      if (!isSearchResultContext(afterContext, query)) {
        throw new Error(`阶段「${input.phase.goal}」未能进入搜索结果页。`);
      }
      const result = { success: true, url: afterContext.observation.url, title: afterContext.observation.title };
      this.history.push({
        action: fallbackAction,
        result,
        verification: { success: true },
        intent: input.intent,
        beforeObservation: context.observation,
        afterObservation: afterContext.observation,
        phase: input.phase,
        phaseIndex: input.phaseIndex,
      });
      input.runState.completedPhases.push({
        phase: input.phase,
        success: true,
        summary: `搜索完成：${query}`,
        result,
        evidence: buildPhaseEvidence({ phase: input.phase, before: context, after: afterContext, action: fallbackAction }),
      });
      this.emitPhaseProgress({
        stepIndex,
        state: 'done',
        phaseIndex: input.phaseIndex,
        phase: input.phase,
        intent: input.intent,
        runState: input.runState,
        observation: afterContext.observation,
        action: fallbackAction,
        result,
        beforeObservation: context.observation,
        afterObservation: afterContext.observation,
      });
      return stepIndex + 1;
    }

    const typeAction: ComputerUseAction = {
      action: 'type',
      elementId: inputElement.elementId,
      selector: inputElement.selector,
      text: query,
      value: query,
      reason: `输入搜索关键词：${query}`,
      expect: `搜索框内容为 ${query}`,
    };
    this.emitPhaseProgress({
      stepIndex,
      state: 'acting',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: context.observation,
      action: typeAction,
    });
    const typeResult = await this.executeAction(typeAction, input.runState, context.observation.url);
    let afterTypeContext = await this.observePhase(input.intent, input.phase);
    this.history.push({
      action: typeAction,
      result: typeResult,
      verification: { success: true },
      intent: input.intent,
      beforeObservation: context.observation,
      afterObservation: afterTypeContext.observation,
      phase: input.phase,
      phaseIndex: input.phaseIndex,
    });
    this.emitPhaseProgress({
      stepIndex,
      state: 'verifying',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: afterTypeContext.observation,
      action: typeAction,
      result: typeResult,
      beforeObservation: context.observation,
      afterObservation: afterTypeContext.observation,
    });
    stepIndex += 1;

    const button = bestSearchButton(afterTypeContext.observation);
    const submitAction: ComputerUseAction = button
      ? {
        action: 'click',
        elementId: button.elementId,
        selector: button.selector,
        text: button.text,
        reason: `点击搜索按钮：${button.text || button.value || button.selector}`,
        expect: '进入搜索结果页',
      }
      : {
        action: 'press_key',
        key: 'Enter',
        reason: '按 Enter 提交搜索',
        expect: '进入搜索结果页',
      };
    this.emitPhaseProgress({
      stepIndex,
      state: 'acting',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: afterTypeContext.observation,
      action: submitAction,
    });
    const submitResult = await this.executeAction(submitAction, input.runState, afterTypeContext.observation.url);
    let afterSubmitContext = await this.waitForSearchResultContext({ intent: input.intent, phase: input.phase });
    if (!isSearchResultContext(afterSubmitContext, query)) {
      const fallbackUrl = buildSearchUrl({
        rawGoal: input.intent.rawGoal,
        startUrl: input.phase.startUrl || input.intent.startUrl,
        siteName: input.phase.siteName || input.intent.siteName,
        actionType: 'search',
        query,
        riskLevel: input.intent.riskLevel,
      });
      if (!fallbackUrl) throw new Error(`阶段「${input.phase.goal}」提交搜索后未进入结果页。`);
      await this.deps.navigate(this.tabId, fallbackUrl, 'complete', 30000, this.deps.signal);
      await this.syncBrowserSession(input.runState);
      afterSubmitContext = await this.waitForSearchResultContext({ intent: input.intent, phase: input.phase, attempts: 5 });
    }
    if (!isSearchResultContext(afterSubmitContext, query)) {
      throw new Error(`阶段「${input.phase.goal}」未能进入搜索结果页。`);
    }
    const result = { success: true, url: afterSubmitContext.observation.url, title: afterSubmitContext.observation.title };
    this.history.push({
      action: submitAction,
      result: submitResult,
      verification: { success: true },
      intent: input.intent,
      beforeObservation: afterTypeContext.observation,
      afterObservation: afterSubmitContext.observation,
      phase: input.phase,
      phaseIndex: input.phaseIndex,
    });
    input.runState.completedPhases.push({
      phase: input.phase,
      success: true,
      summary: `搜索完成：${query}`,
      result,
      evidence: buildPhaseEvidence({ phase: input.phase, before: afterTypeContext, after: afterSubmitContext, action: submitAction }),
    });
    this.emitPhaseProgress({
      stepIndex,
      state: 'done',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: afterSubmitContext.observation,
      action: submitAction,
      result,
      beforeObservation: afterTypeContext.observation,
      afterObservation: afterSubmitContext.observation,
    });
    return stepIndex + 1;
  }

  private async runSelectCollectionItemPhase(input: {
    phase: ComputerUsePhase;
    intent: ComputerUseIntent;
    phaseIndex: number;
    stepIndex: number;
    runState: ComputerUseRunState;
  }): Promise<number> {
    const ordinal = Math.max(1, Number(input.phase.ordinal || input.intent.targetResultIndex || 1));
    const query = input.phase.query || input.intent.query;
    const collectionType = input.phase.collectionType || 'search_results';
    const beforeContext = await this.waitForCollectionItemContext({
      intent: input.intent,
      phase: input.phase,
      collectionType,
      ordinal,
    });
    const observationGate = evaluatePhaseObservationGate({ phase: input.phase, context: beforeContext });
    if (!observationGate.ok) {
      throw new Error(`阶段「${input.phase.goal}」观察质量不足：${observationGate.reason || '搜索结果集合不可靠。'}`);
    }
    const plannedStep: PlannedStep = {
      id: `click_collection_item_${ordinal}`,
      action: 'click',
      target: {
        collectionType,
        ordinal,
        text: input.phase.targets?.[0] || '搜索结果',
      },
      rationale: `点击第${ordinal}个搜索结果`,
      verify: { type: 'page_changed', value: query },
    };
    let targetResolution = resolvePlannedStepTarget({
      step: plannedStep,
      context: beforeContext,
      phase: input.phase,
      runState: input.runState,
      phaseMemory: this.getPhaseMemory(input.phase),
    });
    if (targetResolution.blocked) {
      throw new Error(targetResolution.reason || `未识别到可点击的第${ordinal}个搜索结果。`);
    }
    const targetLease = createBrowserUseTargetLease(targetResolution, beforeContext);
    const freshContext = await this.observePhase(input.intent, input.phase);
    const revalidated = revalidateBrowserUseTargetLease({
      step: targetResolution.step,
      context: freshContext,
      lease: targetLease,
      phase: input.phase,
      runState: input.runState,
      phaseMemory: this.getPhaseMemory(input.phase),
    });
    if (!revalidated.ok) {
      throw new BrowserUseFailure(revalidated.code, revalidated.reason, true, { targetLease });
    }
    targetResolution = revalidated.resolution;
    const resolvedStep = targetResolution.step;
    const action = plannedStepToAction(resolvedStep);
    action.reason = action.reason || `点击第${ordinal}个搜索结果`;
    action.expect = action.expect || `打开第${ordinal}个搜索结果页面`;
    this.emitPhaseProgress({
      stepIndex: input.stepIndex,
      state: 'acting',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: beforeContext.observation,
      action,
      result: { collectionType, ordinal, targetResolution, observationGate },
      targetResolution,
    });
    const clickResult = normalizeToolResult(await this.executeAction({
      ...action,
      waitForElement: false,
    } as ComputerUseAction, input.runState, beforeContext.observation.url));
    await new Promise((resolve) => setTimeout(resolve, 500));
    let afterContext = await this.observeAfterAction(input.intent, input.phase, input.runState, action);
    if (!clickResult?.success) {
      throw new Error(clickResult?.error || `未识别到可点击的第${ordinal}个搜索结果。`);
    }
    if (!hasLeftSearchResults(
      beforeContext.observation,
      afterContext.observation,
      query,
      resolvedStep.target?.href,
    ) && resolvedStep.target?.href) {
      await this.deps.navigate(this.tabId, resolvedStep.target.href, 'complete', 30000, this.deps.signal);
      await this.syncBrowserSession(input.runState);
      afterContext = await this.observeAfterAction(input.intent, input.phase, input.runState, action);
    }
    if (!hasLeftSearchResults(
      beforeContext.observation,
      afterContext.observation,
      query,
      resolvedStep.target?.href,
    )) {
      throw new Error(`已尝试点击第${ordinal}个搜索结果，但页面仍停留在搜索结果页：${afterContext.observation.title || afterContext.observation.url}`);
    }
    this.history.push({
      action: { ...action, text: String(resolvedStep.target?.text || clickResult.text || action.reason) },
      result: clickResult,
      verification: { success: true },
      intent: input.intent,
      beforeObservation: beforeContext.observation,
      afterObservation: afterContext.observation,
      phase: input.phase,
      phaseIndex: input.phaseIndex,
    });
    input.runState.completedPhases.push({
      phase: input.phase,
      success: true,
      summary: `已点击第${ordinal}个搜索结果：${resolvedStep.target?.text || clickResult.text || ''}`.trim(),
      result: clickResult,
      evidence: buildPhaseEvidence({ phase: input.phase, before: beforeContext, after: afterContext, action }),
    });
    this.emitPhaseProgress({
      stepIndex: input.stepIndex,
      state: 'done',
      phaseIndex: input.phaseIndex,
      phase: input.phase,
      intent: input.intent,
      runState: input.runState,
      observation: afterContext.observation,
      action: { ...action, text: String(resolvedStep.target?.text || clickResult.text || action.reason) },
      result: { clickResult, targetResolution },
      beforeObservation: beforeContext.observation,
      afterObservation: afterContext.observation,
    });
    return input.stepIndex + 1;
  }

  async run(): Promise<void> {
    let activeTaskPlan: ComputerUseTaskPlan | undefined;
    let activeRunState: ComputerUseRunState | undefined;
    try {
      if (this.deps.startUrl && !this.deps.resumeCheckpoint) {
        await this.deps.navigate(this.tabId, this.deps.startUrl, 'complete', 30000, this.deps.signal);
        await this.syncBrowserSession();
      }

      const baseIntent = this.deps.understandIntent
        ? await this.deps.understandIntent({ goal: this.deps.goal })
        : await understandComputerUseIntent({ goal: this.deps.goal });
      const checkpoint = this.deps.resumeCheckpoint?.goal === this.deps.goal
        ? this.deps.resumeCheckpoint
        : undefined;
      const taskPlan = checkpoint?.taskPlan || baseIntent.taskPlan || getSinglePhaseTaskPlan(baseIntent);
      activeTaskPlan = taskPlan;
      const runState: ComputerUseRunState = checkpoint
        ? {
          currentPhaseIndex: checkpoint.phaseIndex,
          completedPhases: [...checkpoint.runState.completedPhases],
          downloadResult: checkpoint.runState.downloadResult,
          warnings: [...(checkpoint.runState.warnings || [])],
          browserSession: this.deps.tabSession?.snapshot() || checkpoint.runState.browserSession,
          outputs: { ...(checkpoint.runState.outputs || {}) },
        }
        : {
          currentPhaseIndex: 0,
          completedPhases: [],
          warnings: [],
          browserSession: this.deps.tabSession?.snapshot(),
          outputs: {},
        };
      activeRunState = runState;

      let stepIndex = 0;
      const startPhaseIndex = Math.max(0, Math.min(checkpoint?.phaseIndex || 0, Math.max(0, taskPlan.phases.length - 1)));
      this.deps.emit({
        type: 'COMPUTER_USE_PROGRESS',
        runId: this.deps.runId,
        goal: this.deps.goal,
        stepIndex,
        state: 'observing',
        intent: baseIntent,
        phaseIndex: startPhaseIndex,
        phaseType: taskPlan.phases[startPhaseIndex]?.type,
        phaseGoal: taskPlan.phases[startPhaseIndex]?.goal,
        phase: taskPlan.phases[startPhaseIndex],
        runState,
        result: {
          summary: checkpoint ? '已恢复任务计划，准备继续未完成阶段。' : '任务计划已就绪，准备执行。',
          taskPlan,
        },
      });
      if (checkpoint) {
        this.deps.emit({
          type: 'COMPUTER_USE_PROGRESS',
          runId: this.deps.runId,
          goal: this.deps.goal,
          stepIndex,
          state: 'observing',
          phaseIndex: startPhaseIndex,
          phaseType: taskPlan.phases[startPhaseIndex]?.type,
          phaseGoal: taskPlan.phases[startPhaseIndex]?.goal,
          phase: taskPlan.phases[startPhaseIndex],
          runState,
          result: { summary: `正在从失败阶段继续：${taskPlan.phases[startPhaseIndex]?.goal || '未完成阶段'}` },
        });
      }
      for (let phaseIndex = startPhaseIndex; phaseIndex < taskPlan.phases.length; phaseIndex += 1) {
        const phase = taskPlan.phases[phaseIndex];
        const phaseMemory = this.getPhaseMemory(phase);
        runState.currentPhaseIndex = phaseIndex;
        this.failureCount = 0;

        let phaseCompleted = false;
        while (!phaseCompleted) {
          if (this.deps.signal.aborted) throw new Error('已停止');
          if (stepIndex >= this.deps.maxSteps) {
            this.deps.emit({
              type: 'COMPUTER_USE_ERROR',
              runId: this.deps.runId,
              goal: this.deps.goal,
              error: `自动操作在阶段「${phase.goal}」达到最大步数但没有获得明确完成结果。`,
              steps: this.history,
              lastObservation: this.history[this.history.length - 1]?.afterObservation,
              intent: baseIntent,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
            });
            return;
          }

          const intent = buildPhaseIntent(baseIntent, phase);
          if (phase.type === 'open_site') {
            stepIndex = await this.runOpenSitePhase({ phase, intent, phaseIndex, stepIndex, runState });
            phaseCompleted = true;
            continue;
          }
          if (phase.type === 'search') {
            stepIndex = await this.runSearchPhase({ phase, intent, phaseIndex, stepIndex, runState });
            phaseCompleted = true;
            continue;
          }
          if (phase.type === 'select_collection_item') {
            stepIndex = await this.runSelectCollectionItemPhase({ phase, intent, phaseIndex, stepIndex, runState });
            phaseCompleted = true;
            continue;
          }

          let context = await this.observeStablePhase(intent, phase, runState);
          const precondition = validatePhasePreconditions({ phase, intent, context, runState });
          if (!precondition.ok) {
            this.deps.emit({
              type: 'COMPUTER_USE_ERROR',
              runId: this.deps.runId,
              goal: this.deps.goal,
              error: `阶段「${phase.goal}」前置条件不满足：${precondition.reason || '缺少必要上下文'}`,
              steps: this.history,
              lastObservation: context.observation,
              intent,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
              result: { precondition },
            });
            return;
          }

          let observationGate = evaluatePhaseObservationGate({ phase, context });
          if (!observationGate.ok && observationGate.retryable) {
            await new Promise((resolve) => setTimeout(resolve, 650));
            context = await this.observeStablePhase(intent, phase, runState);
            observationGate = evaluatePhaseObservationGate({ phase, context });
          }
          if (!observationGate.ok) {
            this.deps.emit({
              type: 'COMPUTER_USE_ERROR',
              runId: this.deps.runId,
              goal: this.deps.goal,
              error: `阶段「${phase.goal}」观察质量不足：${observationGate.reason || '缺少可靠的页面语义。'}`,
              steps: this.history,
              lastObservation: context.observation,
              intent,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
              result: { observationGate },
            });
            return;
          }

          this.deps.emit({
            type: 'COMPUTER_USE_PROGRESS',
            runId: this.deps.runId,
            goal: this.deps.goal,
            stepIndex,
            state: 'planning',
            observation: context.observation,
            intent,
            phaseIndex,
            phaseType: phase.type,
            phaseGoal: phase.goal,
            phase,
            runState,
            result: {
              intent,
              taskPlan,
              navigationPath: intent.navigationPath,
              summary: `正在执行阶段：${phase.goal}`,
              navigationCount: context.navigationCandidates.length,
              tableCount: context.tableCandidates.length,
              collections: (context.collections || []).map((collection) => ({
                id: collection.id,
                type: collection.type,
                count: collection.items.length,
                items: collection.items.slice(0, 8).map((item) => ({
                  index: item.index,
                  text: item.text,
                  purpose: item.purpose || item.metadata?.purpose,
                  rowIndex: item.metadata?.rowIndex,
                  actions: item.metadata?.actions,
                })),
              })),
              phaseMemory,
              observationGate,
            },
          });

          const plan = this.deps.createPlan
            ? await this.deps.createPlan({ intent, context, history: this.history, phase, runState, phaseMemory })
            : await createComputerUsePlan({ intent, context, history: this.history, phase, runState, phaseMemory });
          const planDecision = plan.decision;
          let plannedStep = plan.steps[0];
          if (!plannedStep) throw new Error('Computer Use 规划结果没有步骤');
          plannedStep = resolvePlannedStepVariables(plannedStep, runState);
          let targetResolution = resolvePlannedStepTarget({
            step: plannedStep,
            context,
            phase,
            runState,
            phaseMemory,
          });
          if (targetResolution.blocked) {
            this.deps.emit({
              type: 'COMPUTER_USE_ERROR',
              runId: this.deps.runId,
              goal: this.deps.goal,
              error: targetResolution.reason || '无法解析动作目标。',
              steps: this.history,
              lastObservation: context.observation,
              intent,
              plan,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
              result: { targetResolution, phaseMemory },
              targetResolution,
            });
            return;
          }
          plannedStep = targetResolution.step;
          let action = plannedStepToAction(plannedStep);
          let chosenElement = targetResolution.element || (action.elementId
            ? context.observation.elements.find((element) => element.elementId === action.elementId)
            : action.selector
              ? context.observation.elements.find((element) => element.selector === action.selector || element.selectors?.includes(action.selector || ''))
              : undefined);

          if (action.action === 'finish') {
            const summary = action.summary || plan.needsUserInput || plan.summary || action.reason || '任务完成';
            if (planDecision !== 'complete') {
              const blockedReason = plan.blockedReason || plan.needsUserInput || summary;
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: `阶段「${phase.goal}」失败：${blockedReason}`,
                intent,
                plan,
                lastObservation: context.observation,
                phaseIndex,
                phaseType: phase.type,
                phaseGoal: phase.goal,
                phase,
                runState,
              });
              return;
            }

            const finishEvidence = getPhaseFinishEvidence({
              phase,
              intent,
              context,
              history: this.history,
              runState,
            });
            if (!finishEvidence.ok) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: `阶段「${phase.goal}」尚未获得明确完成证据：${finishEvidence.reason || '缺少正向校验结果'}`,
                steps: this.history,
                lastObservation: context.observation,
                intent,
                plan,
                phaseIndex,
                phaseType: phase.type,
                phaseGoal: phase.goal,
                phase,
                runState,
                result: { phaseMemory },
              });
              return;
            }

            runState.completedPhases.push({
              phase,
              success: true,
              summary,
              evidence: buildPhaseEvidence({ phase, after: context, action }),
            });
            this.deps.emit({
              type: 'COMPUTER_USE_PROGRESS',
              runId: this.deps.runId,
              goal: this.deps.goal,
              stepIndex,
              state: 'done',
              observation: context.observation,
              intent,
              plan,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
              result: { summary },
            });
            phaseCompleted = true;
            stepIndex += 1;
            continue;
          }

          if (actionNeedsFreshTarget(action)) {
            const lease = createBrowserUseTargetLease(targetResolution, context);
            const freshContext = await this.observeStablePhase(intent, phase, runState);
            const revalidated = revalidateBrowserUseTargetLease({
              step: plannedStep,
              context: freshContext,
              lease,
              phase,
              runState,
              phaseMemory,
            });
            if (!revalidated.ok) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                errorCode: revalidated.code,
                error: `阶段「${phase.goal}」执行前目标复验失败：${revalidated.reason}`,
                steps: this.history,
                lastObservation: freshContext.observation,
                intent,
                plan,
                phaseIndex,
                phaseType: phase.type,
                phaseGoal: phase.goal,
                phase,
                runState,
                result: { phaseMemory, targetLease: lease },
                targetResolution: revalidated.resolution,
              });
              return;
            }
            context = freshContext;
            targetResolution = revalidated.resolution;
            plannedStep = targetResolution.step;
            action = plannedStepToAction(plannedStep);
            chosenElement = targetResolution.element || (action.elementId
              ? context.observation.elements.find((element) => element.elementId === action.elementId)
              : action.selector
                ? context.observation.elements.find((element) => element.selector === action.selector || element.selectors?.includes(action.selector || ''))
                : undefined);
          }

          if (!this.deps.allowHighRisk && action.action !== 'download_file' && looksHighRisk(action)) {
            const confirmation: ComputerUseNeedsConfirmationMessage = {
              type: 'COMPUTER_USE_NEEDS_CONFIRMATION',
              runId: this.deps.runId,
              stepIndex,
              goal: this.deps.goal,
              action,
              reason: action.reason || '该动作可能修改页面数据，需要确认',
            };
            this.deps.emit(confirmation);
            this.deps.emit({
              type: 'COMPUTER_USE_PROGRESS',
              runId: this.deps.runId,
              goal: this.deps.goal,
              stepIndex,
              state: 'waiting_confirmation',
              observation: context.observation,
              action,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
            });
            const allowed = await this.deps.confirmAction(confirmation);
            if (!allowed) throw new Error('用户取消了高风险动作');
          }

          this.deps.emit({
            type: 'COMPUTER_USE_PROGRESS',
            runId: this.deps.runId,
            goal: this.deps.goal,
            stepIndex,
            state: 'acting',
            observation: context.observation,
            action,
            intent,
            plan,
            chosenElement,
            beforeObservation: context.observation,
            phaseIndex,
            phaseType: phase.type,
            phaseGoal: phase.goal,
            phase,
            runState,
            result: { planSummary: plan.summary, rationale: plannedStep.rationale, targetResolution },
            targetResolution,
          });

          const result = await this.executeAction({
            ...action,
            timeoutMs: action.timeoutMs || (phase.waitMs ? Number(phase.waitMs) : undefined),
          }, runState, context.observation.url);

          this.deps.emit({
            type: 'COMPUTER_USE_PROGRESS',
            runId: this.deps.runId,
            goal: this.deps.goal,
            stepIndex,
            state: 'verifying',
            action,
            intent,
            plan,
            chosenElement,
            beforeObservation: context.observation,
            phaseIndex,
            phaseType: phase.type,
            phaseGoal: phase.goal,
            phase,
            runState,
            result,
            targetResolution,
          });

          const afterContext = await this.observeAfterAction(intent, phase, runState, action);
          const verification = verifyComputerUseStep({
            step: plannedStep,
            result,
            before: context,
            after: afterContext,
          });
          const downloadResult = action.action === 'download_file' ? getDownloadResult(result) : undefined;
          if (downloadResult?.success && (downloadResult.status === 'completed' || downloadResult.status === 'partial')) {
            runState.downloadResult = downloadResult;
            if (downloadResult.status === 'partial' || !downloadResult.savedToDocumentCenter) {
              runState.warnings = [...(runState.warnings || []), downloadResult.message || '下载完成但未能自动入库'];
            }
          }
          this.history.push({
            action,
            result,
            verification,
            plan,
            intent,
            beforeObservation: context.observation,
            afterObservation: afterContext.observation,
            phase,
            phaseIndex,
            downloadResult,
          });

          const phaseCompletion = evaluatePhaseActionCompletion({
            phase,
            intent,
            before: context,
            after: afterContext,
            action,
            result,
            verification,
            history: this.history,
            runState,
          });
          const outcome = validateBrowserUseOutcome({
            verification,
            completion: phaseCompletion,
            action: action.action,
          });

          if (!outcome.ok) {
            this.failureCount += 1;
            phaseMemory.attempts += 1;
            this.rememberFailedCandidate(phaseMemory, action, outcome.reason);
            if (!outcome.retryable || this.failureCount >= 3) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                errorCode: outcome.code,
                error: `阶段「${phase.goal}」停在第 ${stepIndex + 1} 步：${outcome.reason}。请补充上下文或手动处理后重试。`,
                steps: this.history,
                lastObservation: afterContext.observation,
                verification,
                intent,
                plan,
                chosenElement,
                beforeObservation: context.observation,
                afterObservation: afterContext.observation,
                phaseIndex,
                phaseType: phase.type,
                phaseGoal: phase.goal,
                phase,
                runState,
                result: { phaseMemory, phaseCompletion, outcome },
                targetResolution,
              });
              return;
            }
            this.deps.emit({
              type: 'COMPUTER_USE_PROGRESS',
              runId: this.deps.runId,
              goal: this.deps.goal,
              stepIndex,
              state: 'recovering',
              observation: afterContext.observation,
              action,
              intent,
              plan,
              chosenElement,
              beforeObservation: context.observation,
              afterObservation: afterContext.observation,
              verification,
              phaseIndex,
              phaseType: phase.type,
              phaseGoal: phase.goal,
              phase,
              runState,
              result: { verification, phaseMemory, phaseCompletion, outcome },
              targetResolution,
            });
            stepIndex += 1;
            continue;
          }

          this.failureCount = 0;

          this.deps.emit({
            type: 'COMPUTER_USE_PROGRESS',
            runId: this.deps.runId,
            goal: this.deps.goal,
            stepIndex,
            state: 'done',
            observation: afterContext.observation,
            action,
            intent,
            plan,
            chosenElement,
            beforeObservation: context.observation,
            afterObservation: afterContext.observation,
            verification,
            phaseIndex,
            phaseType: phase.type,
            phaseGoal: phase.goal,
            phase,
            runState,
            result: { result, verification },
            targetResolution,
          });

          const summary = makePhaseSummary(phase, result);
          runState.completedPhases.push({
            phase,
            success: true,
            summary,
            result,
            evidence: buildPhaseEvidence({ phase, before: context, after: afterContext, action }),
          });
          phaseCompleted = true;
          stepIndex += 1;
        }

        const completedPhase = [...runState.completedPhases]
          .reverse()
          .find((item) => item.phase.id === phase.id);
        if (completedPhase) {
          runState.outputs = {
            ...(runState.outputs || {}),
            [phase.id]: completedPhase.result ?? completedPhase.summary ?? true,
          };
        }
      }

      this.deps.emit({
        type: 'COMPUTER_USE_FINISHED',
        runId: this.deps.runId,
        goal: this.deps.goal,
        summary: finalSummary(runState, '自动操作完成。'),
        steps: this.history,
        runState,
      });
      return;
    } catch (error: any) {
      this.deps.emit({
        type: 'COMPUTER_USE_ERROR',
        runId: this.deps.runId,
        goal: this.deps.goal,
        errorCode: error instanceof BrowserUseFailure ? error.code : 'ACTION_EXECUTION_FAILED',
        error: error?.message || 'Computer Use 执行失败',
        runState: activeRunState || this.deps.resumeCheckpoint?.runState,
        phaseIndex: activeRunState?.currentPhaseIndex,
        phase: activeTaskPlan?.phases[activeRunState?.currentPhaseIndex || 0],
      });
    }
  }
}
