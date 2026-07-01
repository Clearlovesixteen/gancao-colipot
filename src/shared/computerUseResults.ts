import type { ComputerUseAction } from './automationTypes';

export interface ComputerUseTableResult {
  title?: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

export interface ComputerUseExtractedTablesSummary {
  tables: ComputerUseTableResult[];
  tableCount: number;
  rowCount: number;
}

function normalizeToolResult(result: any): any {
  if (result?.success === true && result?.result && typeof result.result === 'object') return result.result;
  return result;
}

function normalizeTable(table: unknown, index: number): ComputerUseTableResult | null {
  if (!table || typeof table !== 'object') return null;
  const record = table as Record<string, unknown>;
  const rawHeaders = Array.isArray(record.headers) ? record.headers : [];
  const rawRows = Array.isArray(record.rows) ? record.rows : [];
  const headers = rawHeaders.map((header, colIndex) => String(header || `列 ${colIndex + 1}`));
  const rows = rawRows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? '')));
  if (!headers.length && !rows.length) return null;
  const columnCount = Number(record.columnCount || headers.length || rows[0]?.length || 0);
  return {
    title: typeof record.title === 'string' ? record.title : `表格 ${index + 1}`,
    headers,
    rows,
    rowCount: Number.isFinite(Number(record.rowCount)) ? Number(record.rowCount) : rows.length,
    columnCount,
  };
}

export function extractTablesFromComputerUseResult(result: unknown): ComputerUseTableResult[] {
  const data = normalizeToolResult(result);
  const rawTables: unknown[] = Array.isArray(data?.tables) ? data.tables : [];
  const normalizedTables: Array<ComputerUseTableResult | null> = rawTables
    .map((table, index) => normalizeTable(table, index));
  return normalizedTables.filter((table): table is ComputerUseTableResult => Boolean(table));
}

export function summarizeExtractedTables(tables: ComputerUseTableResult[]): ComputerUseExtractedTablesSummary | null {
  if (!tables.length) return null;
  return {
    tables,
    tableCount: tables.length,
    rowCount: tables.reduce((sum, table) => sum + (table.rowCount || table.rows.length), 0),
  };
}

export function getLatestExtractedTablesFromSteps(steps: Array<{ action?: ComputerUseAction; result?: unknown }> = []): ComputerUseExtractedTablesSummary | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.action?.action !== 'extract_table') continue;
    const summary = summarizeExtractedTables(extractTablesFromComputerUseResult(step.result));
    if (summary) return summary;
  }
  return null;
}

function formatPreviewTable(table: ComputerUseTableResult, maxRows: number): string[] {
  const headers = table.headers.length
    ? table.headers
    : Array.from({ length: table.columnCount || table.rows[0]?.length || 0 }, (_, index) => `列 ${index + 1}`);
  const lines: string[] = [];
  if (headers.length) lines.push(`字段：${headers.join('、')}`);
  table.rows.slice(0, maxRows).forEach((row, rowIndex) => {
    const cells = row.slice(0, Math.max(headers.length, 1)).map((cell) => cell || '-');
    lines.push(`${rowIndex + 1}. ${cells.join(' | ')}`);
  });
  if (table.rows.length > maxRows) lines.push(`... 还有 ${table.rows.length - maxRows} 行`);
  return lines;
}

export function formatComputerUseTablesMessage(summary: ComputerUseExtractedTablesSummary, pageTitle?: string): string {
  const lines = [
    `已提取列表数据：${summary.tableCount} 个表格，共 ${summary.rowCount} 行。`,
    pageTitle ? `页面：${pageTitle}` : '',
  ].filter(Boolean);

  summary.tables.slice(0, 3).forEach((table, index) => {
    lines.push(
      '',
      `${index + 1}. ${table.title || `表格 ${index + 1}`}（${table.rowCount || table.rows.length} 行，${table.columnCount || table.headers.length || table.rows[0]?.length || 0} 列）`,
      ...formatPreviewTable(table, 5),
    );
  });

  if (summary.tables.length > 3) lines.push('', `还有 ${summary.tables.length - 3} 个表格未在预览中展开。`);
  return lines.join('\n');
}
