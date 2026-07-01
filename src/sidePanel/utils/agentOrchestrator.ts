import type { DocumentAsset } from '../../shared/documentTypes';

export type AgentType = 'page_diagnosis' | 'document_qa';

export interface AgentSource {
  type: 'page' | 'console' | 'document' | 'chunk' | 'structured_data';
  id?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  pageNumber?: number;
  sectionTitle?: string;
  documentId?: string;
}

export interface AgentRunResult {
  success: boolean;
  agentType: AgentType;
  context: string;
  prompt: string;
  sources: AgentSource[];
  warnings: string[];
  raw?: Record<string, any>;
}

export type ExecuteBusinessTool = (toolName: string, args?: Record<string, any>) => Promise<any>;

export interface PageDiagnosisOptions {
  executeTool: ExecuteBusinessTool;
  collectConsoleErrors: () => Promise<any>;
}

export interface DocumentQaOptions {
  query: string;
  documentIds?: string[];
  executeTool: ExecuteBusinessTool;
}

const MAX_AGENT_CONTEXT_LENGTH = 70000;
const MAX_JSON_BLOCK_LENGTH = 18000;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[内容过长，已截断 ${text.length - maxLength} 字符]`;
}

function stringifyForPrompt(value: unknown, maxLength = MAX_JSON_BLOCK_LENGTH): string {
  try {
    return truncateText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return truncateText(String(value), maxLength);
  }
}

function getConsoleErrors(consoleResult: any): any[] {
  if (Array.isArray(consoleResult?.errors)) return consoleResult.errors;
  if (Array.isArray(consoleResult?.result?.errors)) return consoleResult.result.errors;
  return [];
}

function getPageTitle(pageInfo: any, structuredData: any): string {
  return (
    pageInfo?.title ||
    pageInfo?.result?.title ||
    structuredData?.data?.title ||
    structuredData?.title ||
    '当前页面'
  );
}

function getPageUrl(pageInfo: any, structuredData: any): string {
  return (
    pageInfo?.url ||
    pageInfo?.result?.url ||
    structuredData?.data?.url ||
    structuredData?.url ||
    ''
  );
}

function buildPageDiagnosisSignals(input: {
  errors: any[];
  pageInfo: any;
  structuredPayload: any;
  observation: any;
  warnings: string[];
}): Record<string, unknown> {
  const pageText = [
    input.pageInfo?.text,
    input.pageInfo?.result?.text,
    input.structuredPayload?.title,
    stringifyForPrompt(input.structuredPayload, 4000),
    stringifyForPrompt(input.observation?.pageState || input.observation?.result?.pageState, 2000),
  ].join('\n');
  const resourceErrors = input.errors.filter((error) => error?.source === 'resource' || error?.resourceUrl);
  const promiseErrors = input.errors.filter((error) => error?.source === 'unhandledrejection');
  const scriptErrors = input.errors.filter((error) => error?.source === 'console.error' || error?.source === 'window.error');
  const pageState = input.observation?.pageState || input.observation?.result?.pageState || {};

  return {
    hasConsoleErrors: input.errors.length > 0,
    errorCount: input.errors.length,
    resourceErrorCount: resourceErrors.length,
    promiseErrorCount: promiseErrors.length,
    scriptErrorCount: scriptErrors.length,
    hasLoginSignal: pageState.hasLoginSignal === true || /(登录|登陆|扫码登录|请登录|login|sign in)/i.test(pageText),
    hasCaptchaSignal: pageState.hasCaptcha === true || /(验证码|安全验证|captcha|二维码已过期)/i.test(pageText),
    hasPermissionSignal: /(无权限|权限不足|403|forbidden|unauthorized|未授权)/i.test(pageText),
    hasEmptyDataSignal: /(暂无数据|无数据|empty|no data)/i.test(pageText),
    fieldCount: input.structuredPayload?.fields?.length || 0,
    tableCount: input.structuredPayload?.tables?.length || 0,
    listCount: input.structuredPayload?.lists?.length || 0,
    interactionCount: (input.observation?.elements || input.observation?.result?.elements || []).length,
    warnings: input.warnings,
  };
}

export async function runPageDiagnosisAgent(options: PageDiagnosisOptions): Promise<AgentRunResult> {
  const warnings: string[] = [];
  const sources: AgentSource[] = [];
  let pageInfo: any = null;
  let consoleResult: any = null;
  let structuredData: any = null;
  let observation: any = null;

  try {
    pageInfo = await options.executeTool('get_current_page_info', { include_html: false });
  } catch (error: any) {
    warnings.push(`读取页面信息失败：${error?.message || '未知错误'}`);
  }

  try {
    consoleResult = await options.collectConsoleErrors();
  } catch (error: any) {
    warnings.push(`采集控制台报错失败：${error?.message || '未知错误'}`);
  }

  try {
    structuredData = await options.executeTool('extract_page_structured_data');
  } catch (error: any) {
    warnings.push(`提取网页结构化数据失败：${error?.message || '未知错误'}`);
  }

  try {
    observation = await options.executeTool('observe_page', { limit: 120 });
  } catch (error: any) {
    warnings.push(`观察页面交互元素失败：${error?.message || '未知错误'}`);
  }

  const errors = getConsoleErrors(consoleResult);
  const title = getPageTitle(pageInfo, structuredData);
  const url = getPageUrl(pageInfo, structuredData);
  const structuredPayload = structuredData?.data || structuredData?.result?.data || structuredData;
  const diagnosisSignals = buildPageDiagnosisSignals({
    errors,
    pageInfo,
    structuredPayload,
    observation,
    warnings,
  });

  if (url || title) {
    sources.push({ type: 'page', title, url });
  }
  if (structuredData?.asset?.id) {
    sources.push({
      type: 'structured_data',
      id: structuredData.asset.id,
      title: structuredData.asset.title || title,
      url,
    });
  }
  if (errors.length) {
    sources.push({ type: 'console', title: `${errors.length} 条页面错误`, url });
  }

  const context = truncateText([
    '# 页面诊断上下文',
    `页面标题：${title}`,
    url ? `页面 URL：${url}` : '',
    '',
    '## 页面信息',
    stringifyForPrompt(pageInfo),
    '',
    '## 控制台与资源/网络错误',
    errors.length ? stringifyForPrompt(consoleResult) : '未捕获到控制台错误、资源加载失败或网络失败。',
    '',
    '## 诊断信号',
    stringifyForPrompt(diagnosisSignals),
    '',
    '## 页面结构化数据',
    stringifyForPrompt(structuredPayload),
    '',
    '## 页面区域与可交互元素',
    stringifyForPrompt({
      pageState: observation?.pageState || observation?.result?.pageState,
      regions: observation?.regions || observation?.result?.regions || [],
      elements: (observation?.elements || observation?.result?.elements || []).slice(0, 80).map((element: any) => ({
        role: element.role,
        tag: element.tag,
        text: element.text,
        purpose: element.purpose,
        region: element.region,
        context: element.context,
        href: element.href,
        visible: element.visible,
        enabled: element.enabled,
      })),
    }),
    warnings.length ? `\n## 采集警告\n${warnings.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n'), MAX_AGENT_CONTEXT_LENGTH);

  const prompt = [
    '请作为页面诊断 Agent，基于下面的页面上下文输出可执行诊断。',
    '请按以下结构回答：',
    '1. 问题摘要',
    '2. 风险等级（高/中/低，并说明理由）',
    '3. 最可能原因',
    '4. 定位路径',
    '5. 修复建议',
    '6. 需要用户补充的信息',
    '',
    '诊断时必须同时考虑：console/window/promise/resource 错误、页面登录态/验证码/权限不足信号、页面结构化字段/表格/列表、可交互元素是否异常。',
    '如果没有捕获到错误，也要基于页面结构、URL、字段和可见信息给出可检查点，不要只回答“没有错误”。',
    '',
    context,
  ].join('\n');

  return {
    success: true,
    agentType: 'page_diagnosis',
    context,
    prompt,
    sources,
    warnings,
    raw: { pageInfo, consoleResult, structuredData, observation },
  };
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function normalizeDocuments(documents: any[]): DocumentAsset[] {
  return documents.filter((item): item is DocumentAsset => Boolean(item?.id && item?.title));
}

function sourceFromMatch(match: any): AgentSource {
  return {
    type: 'chunk',
    id: match?.chunk?.id,
    documentId: match?.asset?.id || match?.chunk?.assetId,
    title: match?.asset?.title,
    excerpt: match?.chunk?.text,
    pageNumber: match?.chunk?.pageNumber,
    sectionTitle: match?.chunk?.sectionTitle,
  };
}

function formatSourceLabel(source: AgentSource, index: number): string {
  const parts = [
    `S${index + 1}`,
    source.title || source.id || source.type,
    source.pageNumber ? `第 ${source.pageNumber} 页` : '',
    source.sectionTitle ? `章节：${source.sectionTitle}` : '',
    source.id ? `chunk：${source.id}` : '',
  ].filter(Boolean);
  return parts.join('｜');
}

function summarizeReadDocumentForPrompt(result: any): any {
  if (!result) return null;
  return {
    asset: result.asset,
    content: {
      text: result.content?.text,
      truncated: result.content?.truncated,
      localText: result.content?.localText,
      ocrText: result.content?.ocrText,
      structuredOcr: result.content?.structuredOcr
        ? {
            summary: result.content.structuredOcr.summary,
            documentType: result.content.structuredOcr.documentType,
            pageCount: result.content.structuredOcr.pageCount,
            warnings: result.content.structuredOcr.warnings,
            fields: result.content.structuredOcr.fields?.slice?.(0, 40),
            tables: result.content.structuredOcr.tables?.slice?.(0, 8),
            sections: result.content.structuredOcr.sections?.slice?.(0, 30),
          }
        : undefined,
      tables: result.content?.tables,
      metadata: result.content?.metadata,
    },
    chunks: result.chunks,
  };
}

export async function runDocumentQaAgent(options: DocumentQaOptions): Promise<AgentRunResult> {
  const query = options.query.trim() || '请基于资料中心回答我的问题。';
  const warnings: string[] = [];
  const sources: AgentSource[] = [];
  const listResult = await options.executeTool('list_documents');
  const documents = normalizeDocuments(listResult?.documents || []);

  if (!documents.length) {
    const context = '资料中心暂无资料。';
    return {
      success: true,
      agentType: 'document_qa',
      context,
      prompt: [
        '请作为资料问答 Agent 回答用户。',
        `用户问题：${query}`,
        context,
        '请提示用户先上传文件、提取网页数据或执行 OCR 后再提问。',
      ].join('\n\n'),
      sources: [],
      warnings: ['资料中心暂无资料'],
      raw: { listResult },
    };
  }

  const existingIds = new Set(documents.map((doc) => doc.id));
  const scopedIds = uniqueStrings(options.documentIds || []).filter((id) => existingIds.has(id));
  const searchArgs: Record<string, any> = {
    query,
    limit: 8,
  };
  if (scopedIds.length) {
    searchArgs.documentIds = scopedIds;
  }

  let searchResult: any = null;
  try {
    searchResult = await options.executeTool('search_documents', searchArgs);
  } catch (error: any) {
    warnings.push(`资料检索失败：${error?.message || '未知错误'}`);
  }

  const matches = Array.isArray(searchResult?.matches) ? searchResult.matches : [];
  matches.forEach((match: any) => sources.push(sourceFromMatch(match)));

  const matchedDocumentIds = uniqueStrings(matches.map((match: any) => match?.asset?.id));
  const fallbackIds = scopedIds.length
    ? scopedIds
    : matchedDocumentIds.length
      ? matchedDocumentIds.slice(0, 3)
      : documents.slice(0, 3).map((doc) => doc.id);

  const needsFallbackRead = matches.length < 2 || matches.map((match: any) => match?.chunk?.text || '').join('').length < 1200;
  const readResults = needsFallbackRead
    ? await Promise.all(fallbackIds.map(async (id) => {
        try {
          const result = await options.executeTool('read_document', { id, maxLength: 20000 });
          if (result?.asset) {
            sources.push({
              type: 'document',
              id,
              documentId: id,
              title: result.asset.title,
              excerpt: result.content?.text?.slice(0, 800),
            });
          }
          return result;
        } catch (error: any) {
          warnings.push(`读取资料 ${id} 失败：${error?.message || '未知错误'}`);
          return null;
        }
      }))
    : [];

  const ocrRiskDocs = documents.filter((doc) => {
    const inScope = scopedIds.length ? scopedIds.includes(doc.id) : fallbackIds.includes(doc.id) || matchedDocumentIds.includes(doc.id);
    return inScope && (doc.ocrStatus === 'partial' || doc.error?.includes('OCR'));
  });
  if (ocrRiskDocs.length) {
    warnings.push(`部分资料 OCR 置信度或解析状态可能影响回答：${ocrRiskDocs.map((doc) => doc.title).join('、')}`);
  }

  readResults.filter(Boolean).forEach((result: any) => {
    const ocrWarnings = result?.content?.structuredOcr?.warnings;
    if (Array.isArray(ocrWarnings) && ocrWarnings.length) {
      warnings.push(`资料 ${result.asset?.title || result.asset?.id} 的 OCR 提示：${ocrWarnings.slice(0, 3).join('；')}`);
    }
  });

  const sourceList = sources.slice(0, 16).map(formatSourceLabel);

  const context = truncateText([
    '# 资料问答上下文',
    `用户问题：${query}`,
    scopedIds.length ? `限定资料 ID：${scopedIds.join(', ')}` : '限定资料 ID：未指定，使用资料中心检索。',
    '',
    '## 资料列表',
    stringifyForPrompt(documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      localParseStatus: doc.localParseStatus,
      nativeUploadStatus: doc.nativeUploadStatus,
      ocrStatus: doc.ocrStatus,
      error: doc.error,
    })), 12000),
    '',
    '## 检索命中',
    matches.length ? stringifyForPrompt(matches, 24000) : '未检索到足够相关片段。',
    '',
    sourceList.length ? `## 引用来源清单\n${sourceList.map((item) => `- ${item}`).join('\n')}` : '',
    '',
    readResults.filter(Boolean).length ? '## 全文兜底读取\n' + stringifyForPrompt(readResults.filter(Boolean).map(summarizeReadDocumentForPrompt), 26000) : '',
    warnings.length ? `\n## 警告\n${warnings.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n'), MAX_AGENT_CONTEXT_LENGTH);

  const prompt = [
    '请作为资料问答 Agent，基于资料中心上下文回答用户问题。',
    '回答要求：',
    '- 先给结论，再给依据。',
    '- 每个关键结论都要标注引用来源，格式优先使用 [文件名｜第 x 页｜章节｜chunk:id]；没有页码时至少写文件名和 chunk/section。',
    '- 明确不确定的信息和缺失材料。',
    '- 如果 OCR 有低置信度、乱码、空结果或解析警告，必须在回答中提示可靠性风险。',
    '- 支持总结、字段提取、风险分析、对比分析和任务建议。',
    '',
    context,
  ].join('\n');

  return {
    success: true,
    agentType: 'document_qa',
    context,
    prompt,
    sources,
    warnings,
    raw: { listResult, searchResult, readResults },
  };
}

export function shouldRouteToDocumentQa(message: string, hasAttachedFiles = false): boolean {
  const text = message.trim();
  if (!text || hasAttachedFiles) return false;
  return /(资料|文件|文档|附件|PDF|Word|Excel|OCR|总结|对比|差异|风险|字段|任务|需求|清单)/i.test(text);
}
