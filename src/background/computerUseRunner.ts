import type {
  BrowserObservation,
  ComputerUseAction,
  ComputerUseDownloadResult,
  ComputerUseErrorMessage,
  ComputerUseFinishedMessage,
  ComputerUsePhase,
  ComputerUsePhaseMemory,
  ComputerUseIntent,
  ComputerUsePageContext,
  ComputerUsePlan,
  ComputerUseNeedsConfirmationMessage,
  ComputerUseProgressMessage,
  ComputerUseRunState,
  ComputerUseTaskPlan,
  PlannedStep,
} from '../shared/automationTypes';
import { buildComputerUsePageContext } from './pageContextBuilder';
import { createComputerUsePlan } from './computerUsePlanner';
import { understandComputerUseIntent } from './computerUseIntent';
import { verifyComputerUseStep } from './verifyComputerUseStep';
import { extractTablesFromComputerUseResult, summarizeExtractedTables } from '../shared/computerUseResults';

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
  executeDownloadAction?: (input: { action: ComputerUseAction; pageUrl?: string }) => Promise<unknown>;
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
  return /(提交|删除|支付|购买|下单|发送|确认|保存|导出|下载|修改|submit|delete|pay|buy|send|confirm|save|export|download)/i.test(text);
}

function actionToTool(action: ComputerUseAction): { toolName: string; args: any } {
  if (action.action === 'click') {
    return { toolName: 'click_element', args: action };
  }
  if (action.action === 'double_click') {
    return { toolName: 'click_element', args: { ...action, clickCount: 2 } };
  }
  if (action.action === 'right_click') {
    return { toolName: 'click_element', args: { ...action, button: 'right' } };
  }
  if (action.action === 'click_by_coordinate') {
    return { toolName: 'click_by_coordinate', args: action };
  }
  if (action.action === 'type') {
    return { toolName: 'type_text', args: { ...action, clear: true } };
  }
  if (action.action === 'clear_input') {
    return { toolName: 'clear_input', args: action };
  }
  if (action.action === 'focus') {
    return { toolName: 'focus_element', args: action };
  }
  if (action.action === 'keyboard_shortcut') {
    return { toolName: 'keyboard_shortcut', args: action };
  }
  if (action.action === 'press_key') {
    return { toolName: 'press_key', args: action };
  }
  if (action.action === 'select_option') {
    return { toolName: 'select_option', args: action };
  }
  if (action.action === 'check') {
    return { toolName: 'check_element', args: { ...action, checked: action.value !== 'false' } };
  }
  if (action.action === 'hover') {
    return { toolName: 'hover_element', args: action };
  }
  if (action.action === 'drag') {
    return { toolName: 'drag_element', args: action };
  }
  if (action.action === 'scroll') {
    return { toolName: 'scroll_page', args: action };
  }
  if (action.action === 'wait' || action.action === 'wait_for_element') {
    return action.selector || action.elementId
      ? { toolName: 'wait_for_element', args: action }
      : { toolName: 'wait', args: action };
  }
  if (action.action === 'upload_file') {
    return { toolName: 'upload_file', args: action };
  }
  if (action.action === 'download_file') {
    return { toolName: 'download_file', args: action };
  }
  if (action.action === 'extract_table') {
    return { toolName: 'extract_page_tables', args: action };
  }
  throw new Error(`不支持的动作: ${action.action}`);
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
    x: step.target?.x,
    y: step.target?.y,
    text: actionText,
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

function includesCompact(text: string, target?: string): boolean {
  const haystack = compactText(text);
  const needle = compactText(target);
  return Boolean(needle && haystack.includes(needle));
}

function actionTouchesPhaseLeaf(action: ComputerUseAction, phase: ComputerUsePhase): boolean {
  const leaf = phase.navigationPath?.[phase.navigationPath.length - 1] || phase.targets?.[phase.targets.length - 1];
  if (!leaf) return true;
  const actionText = compactText(action.text);
  const leafText = compactText(leaf);
  if (!actionText || !leafText) return false;
  return actionText === leafText || (actionText.includes(leafText) && actionText.length <= leafText.length + 8);
}

function isNavigationPhaseReached(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  const path = (phase.navigationPath?.length ? phase.navigationPath : phase.targets || []).filter(Boolean);
  if (!path.length) return true;
  const leaf = path[path.length - 1];
  const parents = path.slice(0, -1);
  const activeLeafWithParent = context.observation.elements.some((element) => {
    if (!element.active || !includesCompact(`${element.text} ${element.context || ''} ${element.parentText || ''}`, leaf)) return false;
    if (!parents.length) return true;
    const contextText = `${element.text} ${element.context || ''} ${element.parentText || ''}`;
    return parents.some((parent) => includesCompact(contextText, parent));
  });
  if (activeLeafWithParent) return true;

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

function getPhaseTargets(phase: ComputerUsePhase, runState?: ComputerUseRunState): string[] {
  const targets = [
    ...(phase.targets || []),
    ...(phase.navigationPath || []),
  ];
  const downloadName = runState?.downloadResult?.filename || runState?.downloadResult?.assetTitle;
  if (phase.type === 'click_latest_download' && downloadName) {
    targets.push(downloadName);
    const basename = String(downloadName).split(/[\\/]/).filter(Boolean).pop();
    if (basename) targets.push(basename);
  }
  return targets.filter(Boolean);
}

function isPhaseTargetReached(phase: ComputerUsePhase, context: ComputerUsePageContext, runState?: ComputerUseRunState): boolean {
  if (phase.type === 'navigate_to_page') return isNavigationPhaseReached(phase, context);
  const targets = getPhaseTargets(phase, runState);
  if (!targets.length) return false;
  const evidence = phase.type === 'open_page_or_center' || phase.type === 'click_latest_download'
    ? getStrongPageEvidenceText(context)
    : getPageEvidenceText(context);
  return targets.some((target) => includesCompact(evidence, target));
}

function isLatestDownloadOpened(phase: ComputerUsePhase, before: ComputerUsePageContext, after: ComputerUsePageContext, runState: ComputerUseRunState): boolean {
  const targets = getPhaseTargets(phase, runState);
  if (!targets.length) return false;
  const changed = before.observation.url !== after.observation.url
    || before.observation.title !== after.observation.title
    || before.observation.elements.length !== after.observation.elements.length;
  return changed && isPhaseTargetReached(phase, after, runState);
}

function getDownloadResult(result: unknown): ComputerUseDownloadResult | undefined {
  const data = normalizeToolResult(result) as ComputerUseDownloadResult | undefined;
  if (!data || typeof data !== 'object') return undefined;
  return data;
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
  if (!download) return fallback;
  const fileText = download.filename || download.assetTitle || '下载文件';
  const assetText = download.savedToDocumentCenter && download.assetId
    ? `，资料 ID：${download.assetId}`
    : download.needsManualImport
      ? '，但未能自动入库内容，需要手动导入'
      : '';
  const partial = download.status === 'partial' || !download.savedToDocumentCenter ? '（部分完成）' : '';
  return `自动操作完成${partial}：已导出文件：${fileText}${assetText}。`;
}

function getPhaseFinishEvidence(input: {
  phase: ComputerUsePhase;
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  history: ComputerUseHistoryEntry[];
  runState: ComputerUseRunState;
}): { ok: boolean; reason?: string } {
  const lastResult = input.history[input.history.length - 1]?.result;
  if (input.phase.type === 'wait') return { ok: true };
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

function isBlockingFinishSummary(summary: string): boolean {
  return /(未找到|无法|不能|不足|缺少|需要用户|需要先|请补充|请确认|验证码|登录页|无权限|权限不足)/i.test(summary);
}

export class ComputerUseRunner {
  private readonly history: ComputerUseHistoryEntry[] = [];
  private readonly phaseMemories = new Map<string, ComputerUsePhaseMemory>();
  private failureCount = 0;

  constructor(private readonly deps: ComputerUseRunnerDeps) {}

  private getPhaseMemory(phase: ComputerUsePhase): ComputerUsePhaseMemory {
    const phaseId = phase.id || `${phase.type}:${phase.goal}`;
    let memory = this.phaseMemories.get(phaseId);
    if (!memory) {
      memory = { phaseId, attempts: 0, failedCandidates: [] };
      this.phaseMemories.set(phaseId, memory);
    }
    return memory;
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

  async run(): Promise<void> {
    try {
      if (this.deps.startUrl) {
        await this.deps.navigate(this.deps.tabId, this.deps.startUrl, 'complete', 30000, this.deps.signal);
      }

      const baseIntent = this.deps.understandIntent
        ? await this.deps.understandIntent({ goal: this.deps.goal })
        : await understandComputerUseIntent({ goal: this.deps.goal });
      const taskPlan = baseIntent.taskPlan || getSinglePhaseTaskPlan(baseIntent);
      const runState: ComputerUseRunState = {
        currentPhaseIndex: 0,
        completedPhases: [],
        warnings: [],
      };

      let stepIndex = 0;
      for (let phaseIndex = 0; phaseIndex < taskPlan.phases.length; phaseIndex += 1) {
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
          const context = await buildComputerUsePageContext({
            tabId: this.deps.tabId,
            intent,
            phase,
            executeBrowserTool: this.deps.executeBrowserTool,
          });

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
              phaseMemory,
            },
          });

          const plan = this.deps.createPlan
            ? await this.deps.createPlan({ intent, context, history: this.history, phase, runState, phaseMemory })
            : await createComputerUsePlan({ intent, context, history: this.history, phase, runState, phaseMemory });
          const plannedStep = plan.steps[0];
          if (!plannedStep) throw new Error('Computer Use 规划结果没有步骤');
          const action = plannedStepToAction(plannedStep);
          const chosenElement = action.elementId
            ? context.observation.elements.find((element) => element.elementId === action.elementId)
            : action.selector
              ? context.observation.elements.find((element) => element.selector === action.selector || element.selectors?.includes(action.selector || ''))
              : undefined;

          if (action.action === 'finish') {
            const summary = action.summary || plan.needsUserInput || plan.summary || action.reason || '任务完成';
            const hasExecutedStep = this.history.some((item) => item.action);
            const completedDownload = runState.downloadResult ? makeDownloadSummary(runState.downloadResult) : makeDownloadSummary(this.history[this.history.length - 1]?.result);
            const completedExtract = makeExtractedTableSummary(this.history[this.history.length - 1]?.result);
            if (
              taskPlan.phases.length === 1
              && isDataCompletionIntent(intent)
              && (!hasExecutedStep || (!completedDownload && !completedExtract))
              && /^(finish|done|完成|任务完成|已完成)$/i.test(String(summary).trim())
            ) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: '自动操作没有执行：规划器过早结束，未点击目标入口，也未提取到列表数据。请重试或补充目标页面位置。',
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
            if (taskPlan.phases.length === 1 && isDataCompletionIntent(intent) && !completedDownload && !completedExtract && isBlockingFinishSummary(summary)) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: summary,
                steps: this.history,
                lastObservation: context.observation,
                intent,
                plan,
                phaseIndex,
                phaseType: phase.type,
                phaseGoal: phase.goal,
                phase,
                runState,
              });
              return;
            }
            if (isBlockingFinishSummary(summary)) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: `阶段「${phase.goal}」失败：${summary}`,
                steps: this.history,
                lastObservation: context.observation,
                intent,
                plan,
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

            runState.completedPhases.push({ phase, success: true, summary });
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
            result: { planSummary: plan.summary, rationale: plannedStep.rationale },
          });

          const tool = actionToTool(action);
          const waitMs = Number(action.timeoutMs || action.value || phase.waitMs || 1000);
          const result = tool.toolName === 'wait'
            ? await new Promise((resolve) => setTimeout(() => resolve({ success: true, message: '等待完成' }), Math.max(0, waitMs)))
            : tool.toolName === 'download_file' && this.deps.executeDownloadAction
              ? await this.deps.executeDownloadAction({ action, pageUrl: context.observation.url })
              : await this.deps.executeBrowserTool(this.deps.tabId, tool.toolName, tool.args);

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
          });

          const afterContext = await buildComputerUsePageContext({
            tabId: this.deps.tabId,
            intent,
            phase,
            executeBrowserTool: this.deps.executeBrowserTool,
          });
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

          if (!verification.success) {
            this.failureCount += 1;
            phaseMemory.attempts += 1;
            this.rememberFailedCandidate(phaseMemory, action, verification.reason || verification.warning || '校验失败');
            if (verification.blocking || this.failureCount >= 3) {
              this.deps.emit({
                type: 'COMPUTER_USE_ERROR',
                runId: this.deps.runId,
                goal: this.deps.goal,
                error: `阶段「${phase.goal}」停在第 ${stepIndex + 1} 步：${verification.reason || '校验失败'}。请补充上下文或手动处理后重试。`,
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
                result: { phaseMemory },
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
              result: { verification, phaseMemory },
            });
            stepIndex += 1;
            continue;
          }

          this.failureCount = 0;

          const completedByAction = phase.type === 'navigate_to_page'
            ? action.action === 'click' && actionTouchesPhaseLeaf(action, phase) && isNavigationPhaseReached(phase, afterContext)
            : phase.type === 'download_file'
              ? action.action === 'download_file' && isSuccessfulDownloadResult(result)
              : phase.type === 'wait'
                ? action.action === 'wait'
                : phase.type === 'open_page_or_center'
                  ? action.action === 'click' && isPhaseTargetReached(phase, afterContext, runState)
                  : phase.type === 'click_latest_download'
                    ? action.action === 'click' && isLatestDownloadOpened(phase, context, afterContext, runState)
                    : isDataCompletionIntent(intent)
                      ? Boolean(
                        (action.action === 'download_file' && isSuccessfulDownloadResult(result))
                        || (action.action === 'extract_table' && makeExtractedTableSummary(result, afterContext.observation.title))
                      )
                      : action.action !== 'wait';

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
          });

          if (action.action === 'extract_table' && isDataCompletionIntent(intent) && !isDownloadCompletionIntent(intent)) {
            const summary = makeExtractedTableSummary(result, afterContext.observation.title);
            if (summary && taskPlan.phases.length === 1) {
              this.deps.emit({
                type: 'COMPUTER_USE_FINISHED',
                runId: this.deps.runId,
                goal: this.deps.goal,
                summary,
                steps: this.history,
                runState,
              });
              return;
            }
          }

          if (completedByAction) {
            const summary = makePhaseSummary(phase, result);
            runState.completedPhases.push({ phase, success: true, summary, result });
            phaseCompleted = true;
          }
          stepIndex += 1;
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
        error: error?.message || 'Computer Use 执行失败',
      });
    }
  }
}
