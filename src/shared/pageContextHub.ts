import type { BrowserObservation, BrowserPageSignal, ObservedCollection } from './automationTypes';
import { derivePageSignals } from './pageSignals';

export interface ContextHubResult {
  title: string;
  url: string;
  pageState?: BrowserObservation['pageState'];
  signals: BrowserPageSignal[];
  pageSignals: BrowserPageSignal[];
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

function compactStructuredValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 800);
  if (depth >= 2) return String(value).slice(0, 800);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => compactStructuredValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/^(html|outerHTML|innerHTML|rawHtml|screenshot|dataUrl)$/i.test(key))
        .slice(0, 16)
        .map(([key, item]) => [key, compactStructuredValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 800);
}

function compactStructuredList(value: unknown, limit: number): unknown[] {
  return Array.isArray(value)
    ? value.slice(0, limit).map((item) => compactStructuredValue(item))
    : [];
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
  const consoleErrors = getErrors(consoleResult).slice(-50).map((error) => ({
    source: error?.source,
    level: error?.level,
    message: String(error?.message || error || '').slice(0, 1200),
    stack: error?.stack ? String(error.stack).slice(0, 2400) : undefined,
    resourceUrl: error?.resourceUrl,
    timestamp: error?.timestamp,
  }));
  const structuredPayload = structured?.data || structured;
  const textPreview = String(pageInfo?.text || structuredPayload?.text || '').slice(0, 4000);
  const collections = observation?.collections || [];
  const tableCount = Array.isArray(tables?.tables)
    ? tables.tables.length
    : Array.isArray(structuredPayload?.tables)
      ? structuredPayload.tables.length
      : 0;
  const pageSignals = derivePageSignals({
    pageState: observation?.pageState,
    existingSignals: observation?.pageSignals,
    consoleErrors,
    textPreview,
    title: pageInfo?.title || observation?.title,
  });

  return {
    title: pageInfo?.title || observation?.title || structuredPayload?.title || '当前页面',
    url: pageInfo?.url || observation?.url || structuredPayload?.url || '',
    pageState: observation?.pageState,
    signals: pageSignals,
    pageSignals,
    collections: summarizeCollections(collections),
    consoleErrors,
    structuredData: structuredPayload ? {
      headings: compactStructuredList(structuredPayload.headings, 30),
      fields: compactStructuredList(structuredPayload.fields, 80),
      tables: compactStructuredList(structuredPayload.tables, 10),
      lists: compactStructuredList(structuredPayload.lists, 20),
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
