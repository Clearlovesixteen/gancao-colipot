import type { ComputerUseIntent, ComputerUsePhase, ComputerUseTaskIntent, ComputerUseTaskPlan } from '../shared/automationTypes';
import { compileComputerUseTaskPlan } from './taskPlanCompiler';

type IntentLLM = (input: {
  system: string;
  user: unknown;
}) => Promise<unknown>;

const DATA_KEYWORDS = /(列表|表格|数据|导出|下载|提取|获取|读取|报表)/i;
const DOWNLOAD_KEYWORDS = /(导出|下载|download|export)/i;
const FORM_KEYWORDS = /(填写|填表|输入|选择|勾选|上传|新增|编辑)/i;
const NAVIGATION_KEYWORDS = /(打开|进入|跳转|访问|点击|菜单|页面)/i;
const STANDALONE_PAGE_TARGETS = ['文件中心', '我的应用', '测试库'];
const EXPLICIT_PATH_SEPARATOR = /(中的|里的|里面的|下的|>|\/)/;
const PHASE_TYPES: ComputerUsePhase['type'][] = [
  'open_site',
  'search',
  'select_collection_item',
  'extract_data',
  'click_action',
  'fill_form',
  'navigate_to_page',
  'download_file',
  'open_page_or_center',
  'wait',
  'click_latest_download',
  'generic',
];

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => (value || '').trim()).filter(Boolean)));
}

function extractOrdinal(text: string): number | undefined {
  const arabic = text.match(/第\s*(\d+)\s*(?:个|条|行|项|结果|数据)?/);
  if (arabic) return Math.max(1, Number(arabic[1]));
  const chineseMap: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const chinese = text.match(/第\s*([一二两三四五六七八九十])\s*(?:个|条|行|项|结果|数据)?/);
  if (chinese?.[1]) return chineseMap[chinese[1]];
  if (/(第一条|第一行|第一项|首条|首行|首个)/.test(text)) return 1;
  return undefined;
}

function extractQuotedEntities(goal: string): string[] {
  const entities: string[] = [];
  const patterns = [/“([^”]+)”/g, /"([^"]+)"/g, /'([^']+)'/g, /`([^`]+)`/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(goal))) {
      entities.push(match[1]);
    }
  }
  return entities;
}

function normalizeBusinessEntity(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^(请|帮我)\s*/, '');
  normalized = normalized.replace(/^(自动操作[:：]?|自动|操作[:：]?)\s*/, '');
  normalized = normalized.replace(/^(导出|下载|提取|获取|读取|打开|进入|查看)\s*/, '');
  normalized = normalized.replace(/(的)?(列表数据|列表|表格|数据|页面|菜单)$/, '');
  return normalized.trim();
}

function compactText(text?: string): string {
  return String(text || '').replace(/\s+/g, '').trim();
}

function hasExplicitPathSeparator(goal: string): boolean {
  return EXPLICIT_PATH_SEPARATOR.test(goal);
}

function isStandaloneOpenPageTarget(target?: string): boolean {
  const value = compactText(target);
  if (!value) return false;
  return STANDALONE_PAGE_TARGETS.some((item) => compactText(item) === value)
    || /中心$/.test(value);
}

function extractDirectActionTarget(goal: string): string | undefined {
  const direct = goal.match(/(?:点击|打开|进入|查看|访问)\s*([^，。；;]+?)(?:，|。|；|;|$)/);
  return direct?.[1] ? normalizeBusinessEntity(direct[1]) : undefined;
}

function extractStandaloneOpenPageTarget(goal: string): string | undefined {
  const target = extractDirectActionTarget(goal);
  return isStandaloneOpenPageTarget(target) ? target : undefined;
}

function sanitizeNavigationPath(path: string[], goal: string): string[] {
  const values = uniqueNonEmpty(path.map(normalizeBusinessEntity))
    .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value));
  if (!values.length) return [];

  const joined = compactText(values.join(''));
  const standaloneTarget = extractStandaloneOpenPageTarget(goal);
  if (standaloneTarget && compactText(standaloneTarget) === joined) return [];

  if (!hasExplicitPathSeparator(goal) && values.some((value) => compactText(value).length <= 1)) {
    return [];
  }

  return values;
}

function extractBusinessEntities(goal: string): string[] {
  const entities = extractQuotedEntities(goal);
  const navigationPath = extractNavigationPath(goal);
  entities.push(...navigationPath);
  if (!navigationPath.length) {
    const directTarget = extractDirectActionTarget(goal);
    if (directTarget) entities.push(directTarget);
  }
  return uniqueNonEmpty(entities
    .map(normalizeBusinessEntity)
    .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value)));
}

function extractNavigationPath(goal: string): string[] {
  const path: string[] = [];
  const arrowPath = goal.match(/(?:导出|下载|提取|获取|读取|打开|进入|查看)?\s*([^，。；;>\/]+?)\s*(?:>|\/)\s*([^，。；;>\/]+?)(?:的)?(?:列表数据|列表|表格|数据|页面|菜单)?(?:，|。|；|;|$)/);
  if (arrowPath?.[1]) path.push(arrowPath[1]);
  if (arrowPath?.[2]) path.push(arrowPath[2]);

  if (!path.length) {
    const modulePage = goal.match(/(?:导出|下载|提取|获取|读取|打开|进入|查看)?\s*([^，。；;]+?)\s*(?:中的|里的|里面的|下的)\s*([^，。；;]+?)(?:的)?(?:列表数据|列表|表格|数据|页面|菜单)?(?:，|。|；|;|$)/);
    if (modulePage?.[1]) path.push(modulePage[1]);
    if (modulePage?.[2]) path.push(modulePage[2]);
  }

  if (!path.length) {
    const bareMiddlePath = goal.match(/(?:导出|下载|提取|获取|读取|打开|进入|查看)?\s*([^，。；;中]+?)\s*中\s*([^，。；;]{2,}?)(?:的)?(?:列表数据|列表|表格|数据|页面|菜单)?(?:，|。|；|;|$)/);
    if (bareMiddlePath?.[1]) path.push(bareMiddlePath[1]);
    if (bareMiddlePath?.[2]) path.push(bareMiddlePath[2]);
  }

  return sanitizeNavigationPath(path, goal);
}

function extractWaitMs(goal: string): number | undefined {
  const match = goal.match(/等待\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] || '秒').toLowerCase();
  return unit === 'ms' || unit === '毫秒' ? Math.round(value) : Math.round(value * 1000);
}

function extractExplicitUrl(goal: string): string | undefined {
  const match = goal.match(/https?:\/\/[^\s，。；;、,)\]}>）】》]+/i);
  return match?.[0];
}

function cleanFormValue(value: string): string {
  return value
    .trim()
    .replace(/^(?:为|是|:|：|选择|输入|填写|键入)\s*/i, '')
    .replace(/(?:，|。|；|;|,).+$/g, '')
    .trim();
}

function cleanFormLabel(value: string): string {
  return normalizeBusinessEntity(value)
    .replace(/^(?:然后|再|并且|并|以及)\s*/i, '')
    .replace(/(?:选择|输入|填写|键入)$/i, '')
    .trim();
}

function extractFormValues(goal: string): NonNullable<ComputerUsePhase['formValues']> {
  const results: NonNullable<ComputerUsePhase['formValues']> = [];
  const seen = new Set<string>();
  const segments = goal.split(/[，。；;,]/).map((item) => item.trim()).filter(Boolean);

  const push = (label: string, value: string, control: 'input' | 'select') => {
    const cleanLabel = cleanFormLabel(label);
    const cleanValue = cleanFormValue(value);
    if (!cleanLabel || !cleanValue) return;
    if (/^(打开|进入|访问|点击|下载|导出|等待|搜索|查询)$/.test(cleanLabel)) return;
    const key = `${cleanLabel}:${cleanValue}:${control}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ label: cleanLabel, value: cleanValue, control });
  };

  for (const segment of segments) {
    const selectAfterVerb = segment.match(/(?:选择|选中|选为)\s*([^：:为是]+?)\s*(?:为|是|:|：)\s*(.+)$/);
    if (selectAfterVerb?.[1] && selectAfterVerb?.[2]) {
      push(selectAfterVerb[1], selectAfterVerb[2], 'select');
      continue;
    }

    const selectBeforeVerb = segment.match(/(.+?)\s*(?:选择|选中|选为)\s*(.+)$/);
    if (selectBeforeVerb?.[1] && selectBeforeVerb?.[2]) {
      push(selectBeforeVerb[1], selectBeforeVerb[2], 'select');
      continue;
    }

    const inputMatch = segment.match(/(?:输入|填写|键入)\s*([^：:为是]+?)\s*(?:为|是|:|：)\s*(.+)$/);
    if (inputMatch?.[1] && inputMatch?.[2]) {
      push(inputMatch[1], inputMatch[2], 'input');
    }
  }

  return results;
}

function extractClickActionTargets(goal: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /(?:点击|点|按下)\s*(搜索|查询|筛选|下载|导出|确定|提交|保存)(?:按钮)?/g,
    /(下载)\s*(?:第[一二三四五六七八九十\d]+条|第一条|首条|第一行)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(goal))) {
      if (match[1]) targets.push(match[1]);
    }
  }
  return uniqueNonEmpty(targets);
}

function hasFormSearchIntent(goal: string): boolean {
  return extractFormValues(goal).length > 0 && /(点击|点|按下).{0,8}(搜索|查询|筛选)/.test(goal);
}

function buildTaskPlan(goal: string, intent: Omit<ComputerUseIntent, 'taskPlan'>): ComputerUseTaskPlan | undefined {
  const phases: ComputerUsePhase[] = [];
  const navigationPath = intent.navigationPath || [];
  const searchQuery = intent.query?.trim();
  const explicitUrl = extractExplicitUrl(goal);
  const formValues = extractFormValues(goal);
  const clickActionTargets = extractClickActionTargets(goal);
  const isFormWorkflow = formValues.length > 0 || clickActionTargets.length > 0;

  if (explicitUrl && isFormWorkflow) {
    const urlIndex = goal.indexOf(explicitUrl);
    const beforeUrlGoal = urlIndex >= 0 ? goal.slice(0, urlIndex) : '';
    const afterUrlGoal = urlIndex >= 0 ? goal.slice(urlIndex + explicitUrl.length) : goal;
    if (navigationPath.length && DOWNLOAD_KEYWORDS.test(beforeUrlGoal)) {
      phases.push({
        id: 'navigate_to_target_page',
        type: 'navigate_to_page',
        goal: `进入 ${navigationPath.join(' > ')}`,
        targets: navigationPath,
        navigationPath,
      });
      phases.push({
        id: 'download_file_before_open_url',
        type: 'download_file',
        goal: '点击真实导出/下载按钮并等待下载完成',
        targets: uniqueNonEmpty([...navigationPath, '导出', '下载']),
        navigationPath,
      });
    }
    phases.push({
      id: 'open_explicit_url',
      type: 'open_site',
      goal: `打开${explicitUrl}`,
      targets: [explicitUrl],
      startUrl: explicitUrl,
    });
    for (const [index, formValue] of formValues.entries()) {
      phases.push({
        id: `fill_form_${index + 1}`,
        type: 'fill_form',
        goal: `${formValue.control === 'select' ? '选择' : '输入'}${formValue.label}：${formValue.value}`,
        targets: [formValue.label],
        formValues: [formValue],
      });
    }
    if (clickActionTargets.some((target) => /(搜索|查询|筛选)/.test(target))) {
      phases.push({
        id: 'click_search_action',
        type: 'click_action',
        goal: '点击搜索/查询按钮',
        targets: ['搜索', '查询'],
      });
    }
    if (DOWNLOAD_KEYWORDS.test(afterUrlGoal)) {
      const ordinal = extractOrdinal(afterUrlGoal);
      phases.push({
        id: 'download_file_after_form',
        type: 'download_file',
        goal: ordinal
          ? `下载第${ordinal}条数据`
          : '点击真实导出/下载按钮并等待下载完成',
        targets: uniqueNonEmpty(['下载', '导出']),
        ordinal,
        collectionType: ordinal ? 'table_row_group' : undefined,
      });
    }
    return {
      rawGoal: goal,
      summary: phases.map((phase) => phase.goal).join(' -> '),
      phases,
    };
  }

  if (intent.taskType === 'search' && searchQuery && intent.startUrl) {
    phases.push({
      id: 'open_search_site',
      type: 'open_site',
      goal: `打开${intent.siteName || intent.startUrl}`,
      targets: [intent.siteName || intent.startUrl],
      startUrl: intent.startUrl,
      siteName: intent.siteName,
    });
    phases.push({
      id: 'search_query',
      type: 'search',
      goal: `搜索 ${searchQuery}`,
      targets: [searchQuery],
      query: searchQuery,
      startUrl: intent.startUrl,
      siteName: intent.siteName,
    });
    if (intent.postSearchAction === 'click_first_result' || intent.targetResultIndex) {
      const ordinal = Math.max(1, Number(intent.targetResultIndex || 1));
      phases.push({
        id: 'select_search_result',
        type: 'select_collection_item',
        goal: `点击第${ordinal}个搜索结果`,
        targets: [`第${ordinal}个搜索结果`],
        query: searchQuery,
        ordinal,
        collectionType: 'search_results',
      });
    }
    return {
      rawGoal: goal,
      summary: phases.map((phase) => phase.goal).join(' -> '),
      phases,
    };
  }

  const hasDownload = intent.taskType === 'download' || intent.desiredOutput === 'download_file' || DOWNLOAD_KEYWORDS.test(goal);
  const hasFileCenter = /文件中心/.test(goal);
  const standaloneOpenTarget = extractStandaloneOpenPageTarget(goal);
  const hasLatestDownloadTarget = /(刚刚下载|刚下载|最近下载|最新下载|下载的文件|刚才下载)/.test(goal);
  const waitMs = extractWaitMs(goal);

  if (!hasDownload && !hasFileCenter && !standaloneOpenTarget && !hasLatestDownloadTarget && !waitMs) return undefined;

  if (navigationPath.length) {
    phases.push({
      id: 'navigate_to_target_page',
      type: 'navigate_to_page',
      goal: `进入 ${navigationPath.join(' > ')}`,
      targets: navigationPath,
      navigationPath,
    });
  }

  if (hasDownload) {
    phases.push({
      id: 'download_file',
      type: 'download_file',
      goal: '点击真实导出/下载按钮并等待下载完成',
      targets: uniqueNonEmpty([...navigationPath, '导出', '下载']),
      navigationPath,
    });
  }

  if (standaloneOpenTarget || hasFileCenter) {
    const target = standaloneOpenTarget || '文件中心';
    phases.push({
      id: target === '文件中心' ? 'open_file_center' : 'open_page_or_center',
      type: 'open_page_or_center',
      goal: `打开${target}`,
      targets: [target],
    });
  }

  if (waitMs) {
    phases.push({
      id: 'wait_after_download',
      type: 'wait',
      goal: `等待 ${waitMs}ms`,
      waitMs,
    });
  }

  if (hasLatestDownloadTarget) {
    phases.push({
      id: 'click_latest_download',
      type: 'click_latest_download',
      goal: '点击刚刚下载的文件',
      targets: ['刚刚下载的文件'],
      usesDownloadResult: true,
    });
  }

  if (!phases.length) return undefined;

  return {
    rawGoal: goal,
    summary: phases.map((phase) => phase.goal).join(' -> '),
    phases,
  };
}

export function inferComputerUseIntentByRule(goal: string, taskIntent?: ComputerUseTaskIntent): ComputerUseIntent {
  const rawGoal = goal.trim();
  const isSearch = taskIntent?.actionType === 'search';
  const isData = DATA_KEYWORDS.test(rawGoal);
  const isDownload = DOWNLOAD_KEYWORDS.test(rawGoal);
  const isForm = FORM_KEYWORDS.test(rawGoal);
  const isNavigation = NAVIGATION_KEYWORDS.test(rawGoal);

  const taskType: ComputerUseIntent['taskType'] = isSearch
    ? 'search'
    : isDownload
      ? 'download'
      : isData
        ? 'data_extraction'
        : isNavigation
          ? 'navigation'
          : isForm
            ? 'form'
            : 'generic';

  const baseIntent: Omit<ComputerUseIntent, 'taskPlan'> = {
    rawGoal,
    taskType,
    objective: rawGoal,
    entities: extractBusinessEntities(rawGoal),
    desiredOutput: isDownload
      ? 'download_file'
      : isData
        ? 'table_data'
        : undefined,
    startUrl: taskIntent?.startUrl,
    siteName: taskIntent?.siteName,
    query: taskIntent?.query,
    postSearchAction: taskIntent?.postSearchAction,
    targetResultIndex: taskIntent?.targetResultIndex,
    riskLevel: taskIntent?.riskLevel || (isDownload ? 'high' : 'low'),
    navigationPath: extractNavigationPath(rawGoal),
  };
  return {
    ...baseIntent,
    taskPlan: buildTaskPlan(rawGoal, baseIntent),
  };
}

function normalizeIntent(raw: unknown, goal: string, fallback: ComputerUseIntent): ComputerUseIntent {
  if (!raw || typeof raw !== 'object') return fallback;
  const data = raw as Partial<ComputerUseIntent>;
  const taskTypes: ComputerUseIntent['taskType'][] = ['search', 'navigation', 'form', 'data_extraction', 'download', 'generic'];
  const outputs: NonNullable<ComputerUseIntent['desiredOutput']>[] = ['page_state', 'table_data', 'download_file', 'summary'];
  const riskLevels: ComputerUseIntent['riskLevel'][] = ['low', 'medium', 'high'];
  const llmEntities = Array.isArray(data.entities)
    ? data.entities
      .map(String)
      .map(normalizeBusinessEntity)
      .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value))
    : [];
  const llmPath = Array.isArray(data.navigationPath)
    ? data.navigationPath
      .map(String)
      .map(normalizeBusinessEntity)
      .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value))
    : [];
  const fallbackPath = sanitizeNavigationPath(fallback.navigationPath || [], goal);
  const normalizedLlmPath = sanitizeNavigationPath(llmPath, goal);
  const navigationPath = (normalizedLlmPath.length ? normalizedLlmPath : fallbackPath).slice(0, 6);
  const llmTaskPlan = normalizeTaskPlan(data.taskPlan, goal);
  const taskType = taskTypes.includes(data.taskType as any)
    ? data.taskType as ComputerUseIntent['taskType']
    : fallback.taskType;
  const desiredOutput = outputs.includes(data.desiredOutput as any) ? data.desiredOutput : fallback.desiredOutput;
  const riskLevel = riskLevels.includes(data.riskLevel as any) ? data.riskLevel as ComputerUseIntent['riskLevel'] : fallback.riskLevel;
  const entities = uniqueNonEmpty([...fallback.entities, ...llmEntities]).slice(0, 12);
  const baseForPlan: Omit<ComputerUseIntent, 'taskPlan'> = {
    rawGoal: goal,
    taskType,
    objective: typeof data.objective === 'string' && data.objective.trim() ? data.objective.trim() : fallback.objective,
    entities,
    desiredOutput,
    startUrl: typeof data.startUrl === 'string' && data.startUrl.trim()
      ? data.startUrl.trim()
      : fallback.startUrl,
    siteName: typeof data.siteName === 'string' && data.siteName.trim()
      ? data.siteName.trim()
      : fallback.siteName,
    query: typeof data.query === 'string' && data.query.trim()
      ? data.query.trim()
      : fallback.query,
    postSearchAction: data.postSearchAction === 'click_first_result'
      ? 'click_first_result'
      : fallback.postSearchAction,
    targetResultIndex: Number.isFinite(Number(data.targetResultIndex))
      ? Math.max(1, Number(data.targetResultIndex))
      : fallback.targetResultIndex,
    riskLevel,
    ambiguity: Array.isArray(data.ambiguity) ? data.ambiguity.map(String).filter(Boolean).slice(0, 5) : fallback.ambiguity,
    navigationPath,
  };
  const compiled = compileComputerUseTaskPlan({
    goal,
    normalizedIntent: baseForPlan,
    fallbackIntent: fallback,
    llmTaskPlan,
    generatedTaskPlan: buildTaskPlan(goal, baseForPlan),
  });

  return {
    ...baseForPlan,
    ...compiled.intentPatch,
    taskPlan: compiled.taskPlan,
  };
}

function normalizeTaskPlan(raw: unknown, goal: string): ComputerUseTaskPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as Partial<ComputerUseTaskPlan>;
  if (!Array.isArray(data.phases)) return undefined;

  const phases: ComputerUsePhase[] = [];
  data.phases.forEach((phaseLike, index) => {
    if (!phaseLike || typeof phaseLike !== 'object') return;
    const phase = phaseLike as Partial<ComputerUsePhase>;
    if (!PHASE_TYPES.includes(phase.type as any)) return;
    const phaseType = phase.type as ComputerUsePhase['type'];
    const targets = Array.isArray(phase.targets)
      ? uniqueNonEmpty(phase.targets.map(String).map(normalizeBusinessEntity))
      : undefined;
    const navigationPath = sanitizeNavigationPath(
      Array.isArray(phase.navigationPath) ? phase.navigationPath.map(String) : [],
      goal
    );
    if (phaseType === 'navigate_to_page' && !navigationPath.length) return;
    const formValues = Array.isArray((phase as any).formValues)
      ? (phase as any).formValues
        .map((item: any) => ({
          label: typeof item?.label === 'string' ? item.label.trim() : '',
          value: typeof item?.value === 'string' ? item.value.trim() : '',
          control: item?.control === 'select' || item?.control === 'checkbox' ? item.control : 'input',
        }))
        .filter((item: any) => item.label && item.value)
        .slice(0, 8)
      : undefined;
    phases.push({
      id: typeof phase.id === 'string' && phase.id.trim() ? phase.id.trim() : `${phaseType}_${index}`,
      type: phaseType,
      goal: typeof phase.goal === 'string' && phase.goal.trim() ? phase.goal.trim() : targets?.join(' > ') || phaseType,
      targets,
      navigationPath: navigationPath.length ? navigationPath : undefined,
      startUrl: typeof phase.startUrl === 'string' && phase.startUrl.trim() ? phase.startUrl.trim() : undefined,
      siteName: typeof phase.siteName === 'string' && phase.siteName.trim() ? phase.siteName.trim() : undefined,
      query: typeof phase.query === 'string' && phase.query.trim() ? phase.query.trim() : undefined,
      ordinal: Number.isFinite(Number(phase.ordinal)) ? Math.max(1, Number(phase.ordinal)) : undefined,
      collectionType: typeof phase.collectionType === 'string' ? phase.collectionType as any : undefined,
      formValues,
      waitMs: typeof phase.waitMs === 'number' && phase.waitMs > 0 ? phase.waitMs : undefined,
      usesDownloadResult: phase.usesDownloadResult === true,
    });
  });

  if (!phases.length) return undefined;
  return {
    rawGoal: typeof data.rawGoal === 'string' && data.rawGoal.trim() ? data.rawGoal.trim() : goal,
    summary: typeof data.summary === 'string' && data.summary.trim()
      ? data.summary.trim()
      : phases.map((phase) => phase.goal).join(' -> '),
    phases,
  };
}

export async function understandComputerUseIntent(input: {
  goal: string;
  taskIntent?: ComputerUseTaskIntent;
  callLLM?: IntentLLM;
}): Promise<ComputerUseIntent> {
  const fallback = inferComputerUseIntentByRule(input.goal, input.taskIntent);
  if (!input.callLLM) return fallback;

  try {
    const raw = await input.callLLM({
      system: [
        '你是浏览器自动操作的意图识别器，只输出 JSON。',
        '不要生成具体点击路径，不要写死业务系统路径。',
        'taskType 只能是 search,navigation,form,data_extraction,download,generic。',
        '只有用户明确表达层级关系时才输出 navigationPath，例如“X中的Y / X里的Y / X下的Y / X > Y”。',
        '不要拆分完整功能名，例如“文件中心 / 数据中心 / 帮助中心 / 我的应用”。',
        '打开顶部入口或独立页面入口时，输出 open_page_or_center 阶段，不要输出 navigate_to_page。',
        'ruleFallback 仅供参考；如果 fallback.navigationPath 明显把完整词拆坏，不要照抄。',
      ].join('\n'),
      user: {
        goal: input.goal,
        ruleFallback: fallback,
      },
    });
    return normalizeIntent(raw, input.goal, fallback);
  } catch {
    return fallback;
  }
}
