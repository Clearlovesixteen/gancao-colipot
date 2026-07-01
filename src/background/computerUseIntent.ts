import type { ComputerUseIntent, ComputerUsePhase, ComputerUseTaskIntent, ComputerUseTaskPlan } from '../shared/automationTypes';

type IntentLLM = (input: {
  system: string;
  user: unknown;
}) => Promise<unknown>;

const DATA_KEYWORDS = /(列表|表格|数据|导出|下载|提取|获取|读取|报表)/i;
const DOWNLOAD_KEYWORDS = /(导出|下载|download|export)/i;
const FORM_KEYWORDS = /(填写|填表|输入|选择|勾选|上传|新增|编辑)/i;
const NAVIGATION_KEYWORDS = /(打开|进入|跳转|访问|点击|菜单|页面)/i;

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => (value || '').trim()).filter(Boolean)));
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

function extractBusinessEntities(goal: string): string[] {
  const entities = extractQuotedEntities(goal);
  const navigationPath = extractNavigationPath(goal);
  entities.push(...navigationPath);
  return uniqueNonEmpty(entities
    .map(normalizeBusinessEntity)
    .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value)));
}

function extractNavigationPath(goal: string): string[] {
  const path: string[] = [];
  const modulePage = goal.match(/(?:导出|下载|提取|获取|读取|打开|进入|查看)?\s*([^，。；;]+?)\s*(?:中|里的|里面的|下的)\s*([^，。；;]+?)(?:的)?(?:列表数据|列表|表格|数据|页面|菜单)?(?:，|。|；|;|$)/);
  if (modulePage?.[1]) path.push(modulePage[1]);
  if (modulePage?.[2]) path.push(modulePage[2]);
  if (path.length === 0) {
    const afterVerb = goal.match(/(?:点击|打开|进入|查看)\s*([^，。；;]+?)(?:，|。|；|;|$)/);
    if (afterVerb?.[1]) path.push(afterVerb[1]);
  }
  return uniqueNonEmpty(path
    .map(normalizeBusinessEntity)
    .filter((value) => value && !/^(列表|表格|数据|页面|菜单)$/.test(value)));
}

function extractWaitMs(goal: string): number | undefined {
  const match = goal.match(/等待\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] || '秒').toLowerCase();
  return unit === 'ms' || unit === '毫秒' ? Math.round(value) : Math.round(value * 1000);
}

function buildTaskPlan(goal: string, intent: Omit<ComputerUseIntent, 'taskPlan'>): ComputerUseTaskPlan | undefined {
  const phases: ComputerUsePhase[] = [];
  const navigationPath = intent.navigationPath || [];
  const hasDownload = intent.taskType === 'download' || intent.desiredOutput === 'download_file' || DOWNLOAD_KEYWORDS.test(goal);
  const hasFileCenter = /文件中心/.test(goal);
  const hasLatestDownloadTarget = /(刚刚下载|刚下载|最近下载|最新下载|下载的文件|刚才下载)/.test(goal);
  const waitMs = extractWaitMs(goal);

  if (!hasDownload && !hasFileCenter && !hasLatestDownloadTarget && !waitMs) return undefined;

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

  if (hasFileCenter) {
    phases.push({
      id: 'open_file_center',
      type: 'open_page_or_center',
      goal: '打开文件中心',
      targets: ['文件中心'],
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
  const navigationPath = uniqueNonEmpty([...(fallback.navigationPath || []), ...llmPath]).slice(0, 6);
  return {
    rawGoal: goal,
    taskType: taskTypes.includes(data.taskType as any) ? data.taskType as ComputerUseIntent['taskType'] : fallback.taskType,
    objective: typeof data.objective === 'string' && data.objective.trim() ? data.objective.trim() : fallback.objective,
    entities: uniqueNonEmpty([...fallback.entities, ...llmEntities]).slice(0, 12),
    desiredOutput: outputs.includes(data.desiredOutput as any) ? data.desiredOutput : fallback.desiredOutput,
    startUrl: typeof data.startUrl === 'string' && data.startUrl.trim() ? data.startUrl.trim() : fallback.startUrl,
    riskLevel: riskLevels.includes(data.riskLevel as any) ? data.riskLevel as ComputerUseIntent['riskLevel'] : fallback.riskLevel,
    ambiguity: Array.isArray(data.ambiguity) ? data.ambiguity.map(String).filter(Boolean).slice(0, 5) : fallback.ambiguity,
    navigationPath,
    taskPlan: buildTaskPlan(goal, {
      rawGoal: goal,
      taskType: taskTypes.includes(data.taskType as any) ? data.taskType as ComputerUseIntent['taskType'] : fallback.taskType,
      objective: typeof data.objective === 'string' && data.objective.trim() ? data.objective.trim() : fallback.objective,
      entities: uniqueNonEmpty([...fallback.entities, ...llmEntities]).slice(0, 12),
      desiredOutput: outputs.includes(data.desiredOutput as any) ? data.desiredOutput : fallback.desiredOutput,
      startUrl: typeof data.startUrl === 'string' && data.startUrl.trim() ? data.startUrl.trim() : fallback.startUrl,
      riskLevel: riskLevels.includes(data.riskLevel as any) ? data.riskLevel as ComputerUseIntent['riskLevel'] : fallback.riskLevel,
      ambiguity: Array.isArray(data.ambiguity) ? data.ambiguity.map(String).filter(Boolean).slice(0, 5) : fallback.ambiguity,
      navigationPath,
    }) || fallback.taskPlan,
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
        '如果用户目标中有“X中Y / X里的Y / X下的Y”，navigationPath 输出为 ["X","Y"]。',
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
