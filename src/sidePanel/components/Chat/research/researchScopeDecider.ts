import type { ContextHubResult } from '../../../../shared/context/pageContextHub';

export interface ResearchScopeDecision {
  mode: 'current_page' | 'suggest_topic';
  pageCoverage: number;
  missingInformation: string[];
  suggestedDirections: string[];
  reason: string;
}

function queryTerms(query: string): string[] {
  return Array.from(new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
      .filter((term) => !/^(请问|帮我|一下|这个|当前|页面|内容|什么|如何)$/.test(term)),
  )).slice(0, 20);
}

export function decideResearchScope(input: {
  query: string;
  context?: Pick<ContextHubResult, 'title' | 'textPreview' | 'collections' | 'warnings'> | null;
  followUpDepth?: number;
}): ResearchScopeDecision {
  const query = input.query.trim();
  const pageText = `${input.context?.title || ''} ${input.context?.textPreview || ''}`.toLowerCase();
  const terms = queryTerms(query);
  const matched = terms.filter((term) => pageText.includes(term)).length;
  const lexicalCoverage = terms.length ? matched / terms.length : (pageText ? 0.6 : 0);
  const explicitMultiSource = /(对比|比较|全网|多个网站|其他网站|不同来源|竞品)/.test(query);
  const verification = /(真假|真实性|核实|验证|是否属实|可靠|证据)/.test(query);
  const trendOrReputation = /(趋势|口碑|评价|舆情|近期|历史变化|行业情况)/.test(query);
  const monitoring = /(持续关注|持续监控|以后变化|有变化|定期|提醒我)/.test(query);
  const pageAnchored = /(当前页|这个页面|这篇|本文|这段|作者|文中|页面中)/.test(query);
  const missingCoreEntity = !pageAnchored && terms.length > 0 && lexicalCoverage < 0.25;
  const deepFollowUp = Number(input.followUpDepth || 0) >= 3 && lexicalCoverage < 0.45;
  const missingPage = !pageText || Boolean(input.context?.warnings?.length);
  const shouldSuggest = explicitMultiSource
    || verification
    || trendOrReputation
    || monitoring
    || missingCoreEntity
    || deepFollowUp
    || missingPage;
  const missingInformation: string[] = [];
  const suggestedDirections: string[] = [];
  if (explicitMultiSource) {
    missingInformation.push('缺少其他网站或独立来源的对照信息');
    suggestedDirections.push('补充同类页面或竞品来源');
  }
  if (verification) {
    missingInformation.push('当前页面不足以完成真实性交叉验证');
    suggestedDirections.push('加入官方来源和独立佐证');
  }
  if (trendOrReputation) {
    missingInformation.push('当前页面缺少跨时间或用户评价样本');
    suggestedDirections.push('补充近期报道、历史数据或用户评价');
  }
  if (monitoring) {
    missingInformation.push('当前页面只代表此刻状态，无法说明后续变化');
    suggestedDirections.push('加入后续需要持续查看的来源');
  }
  if (missingCoreEntity) {
    missingInformation.push('当前页面没有覆盖问题中的核心实体或事实');
    suggestedDirections.push('加入直接说明核心实体的网页');
  }
  if (deepFollowUp) {
    missingInformation.push('连续追问已经超出当前页面可覆盖的信息');
    suggestedDirections.push('加入包含关键实体和背景信息的页面');
  }
  if (missingPage) {
    missingInformation.push('当前页面正文或语义上下文不足');
    suggestedDirections.push('加入包含核心内容的网页');
  }

  return {
    mode: shouldSuggest ? 'suggest_topic' : 'current_page',
    pageCoverage: Math.max(0, Math.min(1, lexicalCoverage)),
    missingInformation: Array.from(new Set(missingInformation)),
    suggestedDirections: Array.from(new Set(suggestedDirections)).slice(0, 4),
    reason: shouldSuggest
      ? '问题需要当前页面之外的来源才能更可靠地回答'
      : '当前页面能够覆盖问题的主要信息',
  };
}
