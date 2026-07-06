import type { ComputerUseTaskIntent } from '../shared/automationTypes';

const SITE_ALIASES: Array<{ siteName: string; pattern: RegExp; url: string; searchParam?: string }> = [
  { siteName: 'baidu', pattern: /(?:百度|baidu)/i, url: 'https://www.baidu.com/', searchParam: 'wd' },
  { siteName: 'bing', pattern: /(?:必应|bing)/i, url: 'https://www.bing.com/', searchParam: 'q' },
  { siteName: 'google', pattern: /(?:谷歌|google)/i, url: 'https://www.google.com/', searchParam: 'q' },
  { siteName: 'youtube', pattern: /(?:youtube|油管|yt\b)/i, url: 'https://www.youtube.com/', searchParam: 'search_query' },
  { siteName: 'zhihu', pattern: /(?:知乎|zhihu)/i, url: 'https://www.zhihu.com/' },
  { siteName: 'taobao', pattern: /(?:淘宝|taobao)/i, url: 'https://www.taobao.com/' },
  { siteName: 'jd', pattern: /(?:京东|jd\.com|jingdong)/i, url: 'https://www.jd.com/' },
];

function cleanupUrlCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/[，。；;、,)\]}>）】》]+$/g, '');
}

function normalizeStartUrlCandidate(candidate: string): string | undefined {
  const cleaned = cleanupUrlCandidate(candidate);
  if (!cleaned) return undefined;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^www\./i.test(cleaned) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(cleaned)) {
    return `https://${cleaned}`;
  }
  return undefined;
}

function inferStartTarget(goal: string): { startUrl?: string; siteName?: string; searchParam?: string } {
  const explicitUrl = goal.match(/https?:\/\/[^\s，。；;、,)\]}>）】》]+/i);
  if (explicitUrl?.[0]) {
    const startUrl = normalizeStartUrlCandidate(explicitUrl[0]);
    if (startUrl) return { startUrl };
  }

  const wwwUrl = goal.match(/\bwww\.[a-z0-9.-]+(?:\/[^\s，。；;、,)\]}>）】》]*)?/i);
  if (wwwUrl?.[0]) {
    const startUrl = normalizeStartUrlCandidate(wwwUrl[0]);
    if (startUrl) return { startUrl };
  }

  const openedDomain = goal.match(/(?:打开|访问|进入|跳转到|前往)\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s，。；;、,)\]}>）】》]*)?)/i);
  if (openedDomain?.[1]) {
    const startUrl = normalizeStartUrlCandidate(openedDomain[1]);
    if (startUrl) return { startUrl };
  }

  const alias = SITE_ALIASES.find((item) => item.pattern.test(goal));
  return alias ? { startUrl: alias.url, siteName: alias.siteName, searchParam: alias.searchParam } : {};
}

function stripInstructionNoise(value: string): string {
  return value
    .replace(/^(?:帮我|请|自动|操作|当前页面|在|到|打开|访问|进入|跳转到|前往|百度|必应|谷歌|google|bing|baidu|youtube|油管|yt|搜索|搜|查询|输入|关键词|关键字|内容|为|是|一下|并|然后|再|点击|点|搜索按钮|按钮|：|:|\s)+/i, '')
    .replace(/(?:，|。|；|;|,).+$/g, '')
    .replace(/(?:然后|再|并且|并).+$/g, '')
    .replace(/(?:然后|再)?(?:点击|点)(?:一下)?(?:搜索|查询|百度一下)?(?:按钮)?$/i, '')
    .replace(/(?:搜索|查询)$/i, '')
    .trim();
}

function inferSearchQuery(goal: string): string | undefined {
  const patterns = [
    /(?:输入|键入|填写)\s*([^，。；;,]+?)(?:，|。|；|;|,|$)/i,
    /(?:关键词|关键字)\s*(?:是|为|:|：)?\s*([^，。；;,]+?)(?:，|。|；|;|,|$)/i,
    /(?:搜索|搜一下|搜|查询)\s*([^，。；;,]+?)(?:，|。|；|;|,|$)/i,
  ];

  for (const pattern of patterns) {
    const matched = goal.match(pattern);
    if (matched?.[1]) {
      const query = stripInstructionNoise(matched[1]);
      if (query) return query;
    }
  }

  const searchSiteMatch = goal.match(/(?:百度|必应|谷歌|google|bing|baidu).*?(?:搜索|搜|查询)?\s*([^，。；;,]+?)(?:，|。|；|;|,|$)/i);
  if (searchSiteMatch?.[1]) {
    const query = stripInstructionNoise(searchSiteMatch[1]);
    if (query && !/(打开|访问|进入|点击|搜索)/.test(query)) return query;
  }

  return undefined;
}

function inferPostSearchAction(goal: string): Pick<ComputerUseTaskIntent, 'postSearchAction' | 'targetResultIndex'> {
  const index = inferSearchResultIndex(goal);
  if (index) return { postSearchAction: 'click_first_result', targetResultIndex: index };
  return {};
}

function parseChineseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/\s+/g, '');
  if (/^\d+$/.test(normalized)) return Math.max(1, Number(normalized));
  if (/^(首|一)$/.test(normalized)) return 1;
  if (/^(二|两)$/.test(normalized)) return 2;

  const digitMap: Record<string, number> = {
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
  };

  if (digitMap[normalized]) return digitMap[normalized];
  if (normalized === '十') return 10;

  const tenMatch = normalized.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (tenMatch) {
    const tens = tenMatch[1] ? digitMap[tenMatch[1]] : 1;
    const ones = tenMatch[2] ? digitMap[tenMatch[2]] : 0;
    return tens * 10 + ones;
  }

  return undefined;
}

function inferSearchResultIndex(goal: string): number | undefined {
  if (/(?:点击|点开|打开|进入|访问)\s*(?:搜索)?(?:结果)?\s*(?:首个|第一条|第一个|第1个|第1条)\s*(?:搜索)?结果/i.test(goal)
    || /(?:首个|第一条|第一个|第1个|第1条)\s*(?:搜索)?结果/i.test(goal)) {
    return 1;
  }

  const patterns = [
    /(?:点击|点开|打开|进入|访问)[^，。；;,]{0,12}?第\s*([一二两三四五六七八九十\d]+)\s*(?:个|条|项|位)?\s*(?:搜索)?结果/i,
    /第\s*([一二两三四五六七八九十\d]+)\s*(?:个|条|项|位)?\s*(?:搜索)?结果/i,
  ];

  for (const pattern of patterns) {
    const matched = goal.match(pattern);
    const index = matched?.[1] ? parseChineseNumber(matched[1]) : undefined;
    if (index) return index;
  }

  return undefined;
}

function inferActionType(goal: string, query?: string): ComputerUseTaskIntent['actionType'] {
  if (query && /(搜索|搜|查询|百度|必应|谷歌|google|bing|baidu|youtube|油管|yt\b)/i.test(goal)) return 'search';
  if (/(填写|填表|输入|选择|勾选)/.test(goal)) return 'fill_form';
  if (/(下载|导出|download|export)/i.test(goal)) return 'download';
  if (/(提取|获取|读取|抓取)/.test(goal)) return 'extract';
  if (/(点击|点一下|打开)/.test(goal)) return 'click';
  return 'generic';
}

function inferRiskLevel(goal: string): ComputerUseTaskIntent['riskLevel'] {
  if (/(删除|支付|购买|下单|发送|提交|保存|导出|下载|修改|delete|pay|buy|send|submit|save|export|download)/i.test(goal)) {
    return 'high';
  }
  if (/(填写|填表|输入|选择|勾选|上传)/.test(goal)) return 'medium';
  return 'low';
}

export function parseComputerUseTask(goal: string, explicitStartUrl?: string): ComputerUseTaskIntent {
  const rawGoal = goal.trim();
  const inferredTarget = inferStartTarget(rawGoal);
  const normalizedExplicitUrl = explicitStartUrl ? normalizeStartUrlCandidate(explicitStartUrl) : undefined;
  const query = inferSearchQuery(rawGoal);
  const actionType = inferActionType(rawGoal, query);
  const postSearch = inferPostSearchAction(rawGoal);

  return {
    rawGoal,
    startUrl: normalizedExplicitUrl || inferredTarget.startUrl,
    siteName: inferredTarget.siteName,
    actionType,
    query,
    ...postSearch,
    successCriteria: actionType === 'search' && query
      ? postSearch.postSearchAction === 'click_first_result'
        ? `页面跳转到搜索结果页，并点击与“${query}”相关的第${postSearch.targetResultIndex || 1}个结果。`
        : `页面跳转到搜索结果页，并出现与“${query}”相关的结果。`
      : undefined,
    riskLevel: inferRiskLevel(rawGoal),
  };
}

export function buildSearchUrl(intent: ComputerUseTaskIntent): string | undefined {
  if (!intent.startUrl || !intent.query) return undefined;
  const site = SITE_ALIASES.find((item) => item.siteName === intent.siteName || item.url === intent.startUrl);
  if (!site?.searchParam) return undefined;
  const url = new URL(intent.startUrl);
  if (site.siteName === 'baidu') {
    url.pathname = '/s';
  } else if (site.siteName === 'bing' || site.siteName === 'google') {
    url.pathname = '/search';
  } else if (site.siteName === 'youtube') {
    url.pathname = '/results';
  }
  url.searchParams.set(site.searchParam, intent.query);
  return url.toString();
}
