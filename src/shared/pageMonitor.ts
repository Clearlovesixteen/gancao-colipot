import type { PageMonitorExtractMode, PageMonitorSnapshot } from './automationTypes';

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
  previousHash?: string;
  nextHash: string;
  summary: string;
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
  };
}

export function comparePageMonitorSnapshots(
  previous: PageMonitorSnapshot | undefined,
  next: PageMonitorSnapshot,
): PageMonitorCompareResult {
  const changed = !previous || previous.hash !== next.hash;
  return {
    changed,
    previousHash: previous?.hash,
    nextHash: next.hash,
    summary: changed
      ? previous
        ? `页面内容发生变化：${previous.hash} -> ${next.hash}`
        : '已完成首次页面快照。'
      : '页面内容暂无变化。',
  };
}
