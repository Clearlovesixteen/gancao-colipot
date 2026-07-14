import type { BrowserObservation, ObservedCollection } from '../../shared/automationTypes';

export interface ContextHubResult {
  title: string;
  url: string;
  pageState?: BrowserObservation['pageState'];
  signals: Array<{ type: string; severity: 'info' | 'warning' | 'error'; message: string }>;
  pageSignals: Array<{ type: string; severity: 'info' | 'warning' | 'error'; message: string }>;
  collections: Array<{
    type: string;
    title?: string;
    count: number;
    preview: string[];
  }>;
  consoleErrors: any[];
  structuredData?: {
    headings: unknown[];
    fields: unknown[];
    tables: unknown[];
    lists: unknown[];
  };
  structuredAsset?: { id?: string; title?: string };
  formSummary?: {
    fieldCount: number;
    fields: Array<{ label: string; purpose?: string; controlType?: string; required?: boolean; currentValue?: string }>;
  };
  tableSummary?: {
    tableCount: number;
    rowCount: number;
    preview: string[];
  };
  actionSummary?: {
    actionCount: number;
    actions: Array<{ text: string; purpose?: string; actionKind?: string; riskLevel?: string; rowIndex?: number }>;
  };
  tableCount: number;
  textPreview: string;
  warnings: string[];
}

export type ContextHubExecuteTool = (toolName: string, args?: Record<string, any>) => Promise<any>;

function unwrapResult(result: any): any {
  if (result?.success === true && result.result) return result.result;
  if (result?.result) return result.result;
  return result;
}

function getErrors(consoleResult: any): any[] {
  const raw = unwrapResult(consoleResult);
  if (Array.isArray(raw?.errors)) return raw.errors;
  if (Array.isArray(raw)) return raw;
  return [];
}

function summarizeCollections(collections: ObservedCollection[] = []): ContextHubResult['collections'] {
  return collections.slice(0, 16).map((collection) => ({
    type: collection.type,
    title: collection.title,
    count: collection.items.length,
    preview: collection.items.slice(0, 5).map((item) => item.text).filter(Boolean),
  }));
}

function summarizeForms(collections: ObservedCollection[] = []): ContextHubResult['formSummary'] {
  const fields = collections
    .filter((collection) => collection.type === 'form_group')
    .flatMap((collection) => collection.items)
    .map((item) => ({
      label: String(item.metadata?.label || item.text || ''),
      purpose: item.purpose || item.metadata?.fieldPurpose,
      controlType: item.metadata?.controlType,
      required: item.metadata?.required,
      currentValue: item.metadata?.currentValue === undefined ? undefined : String(item.metadata.currentValue),
    }))
    .filter((item) => item.label)
    .slice(0, 80);
  return fields.length ? { fieldCount: fields.length, fields } : undefined;
}

function summarizeTables(collections: ObservedCollection[] = [], tableCount = 0): ContextHubResult['tableSummary'] {
  const rows = collections
    .filter((collection) => collection.type === 'table_row_group')
    .flatMap((collection) => collection.items);
  if (!tableCount && !rows.length) return undefined;
  return {
    tableCount,
    rowCount: rows.length,
    preview: rows.slice(0, 5).map((item) => item.text).filter(Boolean),
  };
}

function summarizeActions(collections: ObservedCollection[] = []): ContextHubResult['actionSummary'] {
  const actions = collections
    .filter((collection) => collection.type === 'action_group')
    .flatMap((collection) => collection.items)
    .map((item) => ({
      text: item.text || String(item.metadata?.iconLabel || ''),
      purpose: item.purpose,
      actionKind: item.metadata?.actionKind,
      riskLevel: item.riskLevel || item.metadata?.riskLevel,
      rowIndex: item.metadata?.rowIndex,
    }))
    .slice(0, 80);
  return actions.length ? { actionCount: actions.length, actions } : undefined;
}

function buildSignals(input: {
  observation?: BrowserObservation;
  consoleErrors: any[];
  textPreview: string;
}): ContextHubResult['signals'] {
  const signals: ContextHubResult['signals'] = [];
  const pageState = input.observation?.pageState;
  const haystack = `${input.textPreview} ${input.observation?.title || ''}`;
  if (pageState?.hasLoginSignal || /(登录|登陆|扫码登录|请登录|login|sign in)/i.test(haystack)) {
    signals.push({ type: 'login', severity: 'warning', message: '页面出现登录或未登录信号。' });
  }
  if (pageState?.hasCaptcha || /(验证码|安全验证|captcha)/i.test(haystack)) {
    signals.push({ type: 'captcha', severity: 'warning', message: '页面出现验证码或安全验证信号。' });
  }
  if (pageState?.hasPermissionDenied || /(无权限|权限不足|403|forbidden|unauthorized|未授权)/i.test(haystack)) {
    signals.push({ type: 'permission', severity: 'error', message: '页面出现权限不足信号。' });
  }
  if (pageState?.hasEmptyState || /(暂无数据|无数据|empty|no data)/i.test(haystack)) {
    signals.push({ type: 'empty', severity: 'info', message: '页面可能为空状态或无数据。' });
  }
  if (input.consoleErrors.length) {
    signals.push({ type: 'console_error', severity: 'error', message: `捕获到 ${input.consoleErrors.length} 条控制台/资源错误。` });
  }
  return signals;
}

export async function collectPageContextHub(input: {
  executeTool: ContextHubExecuteTool;
  collectConsoleErrors?: () => Promise<any>;
  includeStructuredData?: boolean;
  includeTables?: boolean;
  observeLimit?: number;
}): Promise<ContextHubResult> {
  const warnings: string[] = [];
  const [pageInfoResult, observationResult, consoleResult, structuredResult, tablesResult] = await Promise.all([
    input.executeTool('get_current_page_info', { include_html: false }).catch((error) => {
      warnings.push(`读取页面信息失败：${error?.message || error}`);
      return null;
    }),
    input.executeTool('observe_page', { limit: input.observeLimit || 180 }).catch((error) => {
      warnings.push(`观察页面失败：${error?.message || error}`);
      return null;
    }),
    input.collectConsoleErrors
      ? input.collectConsoleErrors().catch((error) => {
        warnings.push(`采集控制台失败：${error?.message || error}`);
        return null;
      })
      : Promise.resolve(null),
    input.includeStructuredData
      ? input.executeTool('extract_page_structured_data').catch((error) => {
        warnings.push(`提取结构化数据失败：${error?.message || error}`);
        return null;
      })
      : Promise.resolve(null),
    input.includeTables
      ? input.executeTool('extract_page_tables').catch((error) => {
        warnings.push(`提取表格失败：${error?.message || error}`);
        return null;
      })
      : Promise.resolve(null),
  ]);

  const pageInfo = unwrapResult(pageInfoResult);
  const observation = unwrapResult(observationResult) as BrowserObservation | undefined;
  const structured = unwrapResult(structuredResult);
  const tables = unwrapResult(tablesResult);
  const consoleErrors = getErrors(consoleResult);
  const structuredPayload = structured?.data || structured;
  const textPreview = String(pageInfo?.text || structuredPayload?.text || '').slice(0, 4000);
  const collections = observation?.collections || [];
  const tableCount = Array.isArray(tables?.tables)
    ? tables.tables.length
    : Array.isArray(structuredPayload?.tables)
      ? structuredPayload.tables.length
      : 0;
  const pageSignals = buildSignals({ observation, consoleErrors, textPreview });

  return {
    title: pageInfo?.title || observation?.title || structuredPayload?.title || '当前页面',
    url: pageInfo?.url || observation?.url || structuredPayload?.url || '',
    pageState: observation?.pageState,
    signals: pageSignals,
    pageSignals,
    collections: summarizeCollections(collections),
    consoleErrors,
    structuredData: structuredPayload ? {
      headings: Array.isArray(structuredPayload.headings) ? structuredPayload.headings.slice(0, 30) : [],
      fields: Array.isArray(structuredPayload.fields) ? structuredPayload.fields.slice(0, 80) : [],
      tables: Array.isArray(structuredPayload.tables) ? structuredPayload.tables.slice(0, 10) : [],
      lists: Array.isArray(structuredPayload.lists) ? structuredPayload.lists.slice(0, 20) : [],
    } : undefined,
    structuredAsset: structured?.asset || structuredResult?.asset,
    formSummary: summarizeForms(collections),
    tableSummary: summarizeTables(collections, tableCount),
    actionSummary: summarizeActions(collections),
    tableCount,
    textPreview,
    warnings,
  };
}
