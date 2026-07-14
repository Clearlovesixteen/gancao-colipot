import type { PageMonitorExtractMode, PageMonitorRule, PageMonitorSnapshot } from './automationTypes';

export interface PageMonitorCaptureInput {
  mode: PageMonitorExtractMode;
  title?: string;
  url?: string;
  text?: string;
  tables?: Array<{ title?: string; headers?: string[]; rows?: unknown[][] }>;
  collections?: Array<{ type?: string; title?: string; count?: number; preview?: string[] }>;
  capturedAt?: number;
}

export interface PageMonitorCompareResult {
  changed: boolean;
  matched: boolean;
  previousHash?: string;
  nextHash: string;
  summary: string;
  diffPreview?: string;
}

function stableText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildTextByMode(input: PageMonitorCaptureInput): string {
  if (input.mode === 'table_summary') {
    const tables = input.tables || [];
    return tables
      .map((table, index) => {
        const headers = (table.headers || []).map(stableText).join('|');
        const rows = (table.rows || [])
          .slice(0, 30)
          .map((row) => row.map(stableText).join('|'))
          .join('\n');
        return [`Table ${index + 1}: ${stableText(table.title || '')}`, headers, rows].filter(Boolean).join('\n');
      })
      .join('\n\n');
  }

  if (input.mode === 'context_summary') {
    const collectionText = (input.collections || [])
      .map((collection) => [
        collection.type,
        collection.title,
        collection.count,
        ...(collection.preview || []),
      ].map(stableText).filter(Boolean).join(' | '))
      .join('\n');
    return [stableText(input.text), collectionText].filter(Boolean).join('\n\n');
  }

  return stableText(input.text);
}

export function createPageMonitorSnapshot(input: PageMonitorCaptureInput): PageMonitorSnapshot {
  const text = buildTextByMode(input);
  const normalized = [
    input.mode,
    stableText(input.title),
    stableText(input.url),
    text,
  ].join('\n');
  return {
    hash: hashString(normalized),
    mode: input.mode,
    title: stableText(input.title || '当前页面'),
    url: stableText(input.url || ''),
    text: text.slice(0, 12000),
    capturedAt: input.capturedAt || Date.now(),
    tableCount: input.tables?.length,
    rowCount: input.tables?.reduce((total, table) => total + (table.rows?.length || 0), 0),
  };
}

function compareNumber(value: number, threshold: number, operator: PageMonitorRule['operator']): boolean {
  if (operator === 'gte') return value >= threshold;
  if (operator === 'lt') return value < threshold;
  if (operator === 'lte') return value <= threshold;
  if (operator === 'eq') return value === threshold;
  return value > threshold;
}

function buildDiffPreview(previous: PageMonitorSnapshot | undefined, next: PageMonitorSnapshot): string | undefined {
  if (!previous) return next.text.slice(0, 400) || undefined;
  const before = new Set(previous.text.split(/\n+/).map(stableText).filter(Boolean));
  const added = next.text.split(/\n+/).map(stableText).filter((line) => line && !before.has(line));
  return added.slice(0, 5).join('\n').slice(0, 800) || undefined;
}

export function comparePageMonitorSnapshots(
  previous: PageMonitorSnapshot | undefined,
  next: PageMonitorSnapshot,
  rule: PageMonitorRule = { type: 'changed' },
): PageMonitorCompareResult {
  const changed = !previous || previous.hash !== next.hash;
  let matched = changed;
  let ruleSummary = '';
  if (rule.type === 'contains') {
    matched = Boolean(rule.value && next.text.includes(rule.value));
    ruleSummary = matched ? `页面包含目标内容：${rule.value}` : `页面尚未包含目标内容：${rule.value || '-'}`;
  } else if (rule.type === 'number_threshold') {
    const numbers = Array.from(next.text.matchAll(/-?\d+(?:\.\d+)?/g)).map((match) => Number(match[0]));
    const threshold = Number(rule.value);
    matched = Number.isFinite(threshold) && numbers.some((value) => compareNumber(value, threshold, rule.operator));
    ruleSummary = matched ? `页面数值命中阈值 ${rule.operator || 'gt'} ${threshold}` : `页面数值未命中阈值 ${rule.operator || 'gt'} ${threshold}`;
  } else if (rule.type === 'new_records') {
    matched = Boolean(previous && (next.rowCount || 0) > (previous.rowCount || 0));
    ruleSummary = matched ? `发现新增记录：${previous?.rowCount || 0} -> ${next.rowCount || 0}` : '未发现新增记录。';
  } else if (rule.type === 'status_transition') {
    matched = Boolean(previous && rule.from && rule.to && previous.text.includes(rule.from) && next.text.includes(rule.to));
    ruleSummary = matched ? `状态已从「${rule.from}」变为「${rule.to}」` : `未发生目标状态转换：${rule.from || '-'} -> ${rule.to || '-'}`;
  }
  return {
    changed,
    matched,
    previousHash: previous?.hash,
    nextHash: next.hash,
    summary: rule.type === 'changed'
      ? changed
        ? previous
          ? `页面内容发生变化：${previous.hash} -> ${next.hash}`
          : '已完成首次页面快照。'
        : '页面内容暂无变化。'
      : ruleSummary,
    diffPreview: changed ? buildDiffPreview(previous, next) : undefined,
  };
}
