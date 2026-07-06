import type {
  ComputerUseIntent,
  ComputerUsePhase,
  ComputerUsePhaseSource,
  ComputerUseTaskPlan,
} from '../shared/automationTypes';

export type TaskPlanCompileInput = {
  goal: string;
  normalizedIntent: Omit<ComputerUseIntent, 'taskPlan'>;
  fallbackIntent: ComputerUseIntent;
  llmTaskPlan?: ComputerUseTaskPlan;
  generatedTaskPlan?: ComputerUseTaskPlan;
};

export type TaskPlanCompileResult = {
  taskPlan?: ComputerUseTaskPlan;
  intentPatch?: Partial<ComputerUseIntent>;
};

function hasPhase(plan: ComputerUseTaskPlan | undefined, type: ComputerUsePhase['type']): boolean {
  return Boolean(plan?.phases.some((phase) => phase.type === type));
}

function hasSearchContract(plan?: ComputerUseTaskPlan): boolean {
  return hasPhase(plan, 'open_site') && hasPhase(plan, 'search');
}

function hasFormWorkflowContract(plan?: ComputerUseTaskPlan): boolean {
  return hasPhase(plan, 'fill_form') || (hasPhase(plan, 'click_action') && hasPhase(plan, 'open_site'));
}

function clonePhase(phase: ComputerUsePhase, source: ComputerUsePhaseSource, repairReason?: string): ComputerUsePhase {
  return {
    ...phase,
    targets: phase.targets ? [...phase.targets] : undefined,
    navigationPath: phase.navigationPath ? [...phase.navigationPath] : undefined,
    source: phase.source || source,
    repairReason: phase.repairReason || repairReason,
  };
}

function clonePlan(
  plan: ComputerUseTaskPlan | undefined,
  source: ComputerUsePhaseSource,
  repairReason?: string
): ComputerUseTaskPlan | undefined {
  if (!plan?.phases.length) return undefined;
  return {
    ...plan,
    phases: plan.phases.map((phase) => clonePhase(phase, source, repairReason)),
    source: plan.source || source,
    repairReason: plan.repairReason || repairReason,
  };
}

function phaseKey(phase: ComputerUsePhase): string {
  return [
    phase.type,
    phase.goal,
    (phase.navigationPath || []).join('>'),
    phase.query,
    phase.ordinal,
    (phase.targets || []).join('|'),
  ].filter(Boolean).join(':');
}

function firstPhase(plan: ComputerUseTaskPlan | undefined, type: ComputerUsePhase['type']): ComputerUsePhase | undefined {
  return plan?.phases.find((phase) => phase.type === type);
}

function insertBeforeFirst(
  phases: ComputerUsePhase[],
  phase: ComputerUsePhase,
  predicate: (phase: ComputerUsePhase) => boolean
): ComputerUsePhase[] {
  if (phases.some((item) => phaseKey(item) === phaseKey(phase))) return phases;
  const index = phases.findIndex(predicate);
  if (index < 0) return [...phases, phase];
  return [...phases.slice(0, index), phase, ...phases.slice(index)];
}

function insertWaitPhase(phases: ComputerUsePhase[], waitPhase: ComputerUsePhase): ComputerUsePhase[] {
  if (phases.some((phase) => phase.type === 'wait')) return phases;
  return insertBeforeFirst(phases, waitPhase, (phase) => phase.type === 'click_latest_download');
}

function summarize(phases: ComputerUsePhase[]): string {
  return phases.map((phase) => phase.goal).join(' -> ');
}

function withPlanMetadata(
  plan: ComputerUseTaskPlan,
  source: ComputerUseTaskPlan['source'],
  repairReason?: string
): ComputerUseTaskPlan {
  return {
    ...plan,
    summary: summarize(plan.phases),
    source,
    repairReason: repairReason || plan.repairReason,
  };
}

function fillDownloadNavigation(
  phases: ComputerUsePhase[],
  navigationPath: string[],
  reason: string
): ComputerUsePhase[] {
  if (!navigationPath.length) return phases;
  return phases.map((phase) => {
    if (phase.type !== 'download_file') return phase;
    if (phase.navigationPath?.length) return phase;
    return {
      ...phase,
      navigationPath,
      targets: Array.from(new Set([...(navigationPath || []), ...(phase.targets || []), '导出', '下载'])),
      source: phase.source || 'repair',
      repairReason: phase.repairReason || reason,
    };
  });
}

function normalizePhaseContracts(phases: ComputerUsePhase[]): ComputerUsePhase[] {
  return phases.filter((phase) => {
    if (phase.type === 'open_site') return Boolean(phase.startUrl || phase.siteName || phase.targets?.length);
    if (phase.type === 'search') return Boolean(phase.query || phase.targets?.length);
    if (phase.type === 'select_collection_item') return Boolean(phase.collectionType || phase.ordinal || phase.targets?.length);
    if (phase.type === 'fill_form') return Boolean(phase.formValues?.length || phase.targets?.length);
    if (phase.type === 'navigate_to_page') return Boolean(phase.navigationPath?.length || phase.targets?.length);
    if (phase.type === 'open_page_or_center') return Boolean(phase.targets?.length || phase.goal);
    if (phase.type === 'click_latest_download') return phase.usesDownloadResult === true || /刚|最近|最新|下载/.test(phase.goal);
    return true;
  });
}

function deterministicSearchPatch(fallback: ComputerUseIntent): Partial<ComputerUseIntent> {
  return {
    taskType: 'search',
    desiredOutput: 'page_state',
    startUrl: fallback.startUrl,
    siteName: fallback.siteName,
    query: fallback.query,
    postSearchAction: fallback.postSearchAction,
    targetResultIndex: fallback.targetResultIndex,
    riskLevel: fallback.riskLevel,
  };
}

function deterministicFormPatch(fallback: ComputerUseIntent): Partial<ComputerUseIntent> {
  return {
    taskType: 'form',
    desiredOutput: fallback.desiredOutput,
    startUrl: fallback.startUrl,
    siteName: fallback.siteName,
    riskLevel: fallback.riskLevel,
  };
}

function shouldKeepFallbackSearch(fallback: ComputerUseIntent, llmPlan?: ComputerUseTaskPlan): boolean {
  return fallback.taskType === 'search'
    && Boolean(fallback.startUrl)
    && Boolean(fallback.query)
    && hasSearchContract(fallback.taskPlan)
    && !hasSearchContract(llmPlan);
}

function shouldKeepFallbackFormWorkflow(fallback: ComputerUseIntent, llmPlan?: ComputerUseTaskPlan): boolean {
  return hasFormWorkflowContract(fallback.taskPlan)
    && !hasFormWorkflowContract(llmPlan);
}

function choosePrimaryPlan(input: TaskPlanCompileInput): { plan?: ComputerUseTaskPlan; source: ComputerUsePhaseSource } {
  if (input.llmTaskPlan?.phases.length) return { plan: input.llmTaskPlan, source: 'llm' };
  if (input.generatedTaskPlan?.phases.length) return { plan: input.generatedTaskPlan, source: 'generated' };
  if (input.fallbackIntent.taskPlan?.phases.length) return { plan: input.fallbackIntent.taskPlan, source: 'fallback' };
  return { plan: undefined, source: 'generated' };
}

export function compileComputerUseTaskPlan(input: TaskPlanCompileInput): TaskPlanCompileResult {
  if (shouldKeepFallbackFormWorkflow(input.fallbackIntent, input.llmTaskPlan)) {
    return {
      taskPlan: clonePlan(
        input.fallbackIntent.taskPlan,
        'fallback',
        '保留确定性页内表单计划，避免 LLM 将筛选条件误识别为网页搜索。'
      ),
      intentPatch: deterministicFormPatch(input.fallbackIntent),
    };
  }

  if (shouldKeepFallbackSearch(input.fallbackIntent, input.llmTaskPlan)) {
    return {
      taskPlan: clonePlan(
        input.fallbackIntent.taskPlan,
        'fallback',
        '保留确定性搜索计划，避免 LLM generic/single_phase 覆盖可执行搜索链路。'
      ),
      intentPatch: deterministicSearchPatch(input.fallbackIntent),
    };
  }

  const { plan: primaryPlan, source } = choosePrimaryPlan(input);
  const primary = clonePlan(primaryPlan, source);
  if (!primary) {
    return {
      taskPlan: clonePlan(input.fallbackIntent.taskPlan, 'fallback'),
    };
  }

  let phases = [...primary.phases];
  const fallbackNavigate = firstPhase(input.fallbackIntent.taskPlan, 'navigate_to_page')
    || firstPhase(input.generatedTaskPlan, 'navigate_to_page');
  const fallbackDownload = firstPhase(input.fallbackIntent.taskPlan, 'download_file')
    || firstPhase(input.generatedTaskPlan, 'download_file');
  const fallbackWait = firstPhase(input.fallbackIntent.taskPlan, 'wait')
    || firstPhase(input.generatedTaskPlan, 'wait');

  let repaired = false;
  const repairReasons: string[] = [];
  if (!phases.some((phase) => phase.type === 'navigate_to_page') && fallbackNavigate && phases.some((phase) => phase.type === 'download_file')) {
    const repairedNavigate = clonePhase(fallbackNavigate, 'repair', '导出阶段缺少目标页面前置，已插入规则候选中的导航阶段。');
    phases = insertBeforeFirst(phases, repairedNavigate, (phase) => phase.type === 'download_file');
    repaired = true;
    repairReasons.push(repairedNavigate.repairReason || '');
  }

  if (!phases.some((phase) => phase.type === 'download_file') && fallbackDownload && phases.some((phase) => phase.type === 'click_latest_download')) {
    const repairedDownload = clonePhase(fallbackDownload, 'repair', '点击刚下载文件前缺少下载阶段，已插入规则候选中的下载阶段。');
    phases = insertBeforeFirst(phases, repairedDownload, (phase) => phase.type === 'click_latest_download');
    repaired = true;
    repairReasons.push(repairedDownload.repairReason || '');
  }

  if (fallbackWait && !phases.some((phase) => phase.type === 'wait')) {
    const repairedWait = clonePhase(fallbackWait, 'repair', 'LLM 计划缺少低风险等待阶段，已从规则候选补齐。');
    phases = insertWaitPhase(phases, repairedWait);
    repaired = true;
    repairReasons.push(repairedWait.repairReason || '');
  }

  const navigationPath = input.normalizedIntent.navigationPath?.length
    ? input.normalizedIntent.navigationPath
    : input.fallbackIntent.navigationPath || [];
  const beforeFill = JSON.stringify(phases);
  phases = fillDownloadNavigation(phases, navigationPath, '下载阶段继承已识别的业务导航路径。');
  if (JSON.stringify(phases) !== beforeFill) {
    repaired = true;
    repairReasons.push('下载阶段继承已识别的业务导航路径。');
  }

  phases = normalizePhaseContracts(phases);
  return {
    taskPlan: withPlanMetadata(
      {
        ...primary,
        phases,
      },
      repaired ? 'mixed' : primary.source || source,
      repairReasons.filter(Boolean).join('；') || primary.repairReason
    ),
  };
}
