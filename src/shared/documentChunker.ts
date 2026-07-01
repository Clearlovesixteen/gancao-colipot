import type { DocumentChunk, DocumentTable } from './documentTypes';

const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 180;

export interface ChunkDocumentInput {
  assetId: string;
  title: string;
  text?: string;
  tables?: DocumentTable[];
  maxChars?: number;
  overlapChars?: number;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function extractKeywords(text: string): string[] {
  const words = Array.from(text.matchAll(/[\p{L}\p{N}_-]{2,}/gu))
    .map((match) => match[0].toLowerCase())
    .filter((word) => !/^\d+$/.test(word));
  return Array.from(new Set(words)).slice(0, 24);
}

function getPageNumber(section: string): number | undefined {
  const match = section.match(/^##\s*Page\s+(\d+)/im);
  return match ? Number(match[1]) : undefined;
}

function getSectionTitle(section: string): string | undefined {
  const match = section.match(/^#{1,4}\s+(.+)$/m);
  return match?.[1]?.trim();
}

function splitLongSection(section: string, maxChars: number, overlapChars: number): string[] {
  if (section.length <= maxChars) return [section];

  const chunks: string[] = [];
  let start = 0;
  while (start < section.length) {
    const end = Math.min(section.length, start + maxChars);
    chunks.push(section.slice(start, end).trim());
    if (end >= section.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks.filter(Boolean);
}

function tableToText(table: DocumentTable, index: number): string {
  const title = table.title || `Table ${index + 1}`;
  const header = table.headers.length ? table.headers.join('\t') : '';
  const rows = table.rows.map((row) => row.join('\t')).join('\n');
  return [`## ${title}`, header, rows].filter(Boolean).join('\n');
}

export function chunkDocument(input: ChunkDocumentInput): DocumentChunk[] {
  const maxChars = input.maxChars || DEFAULT_MAX_CHARS;
  const overlapChars = input.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const now = Date.now();
  const chunks: DocumentChunk[] = [];
  const parts: string[] = [];

  const text = normalizeText(input.text || '');
  if (text) {
    parts.push(...text.split(/\n(?=#{1,4}\s+)/g));
  }

  if (input.tables?.length) {
    parts.push(...input.tables.map(tableToText));
  }

  const sections = parts.length ? parts : text ? [text] : [];

  sections.forEach((section) => {
    splitLongSection(section.trim(), maxChars, overlapChars).forEach((chunkText) => {
      if (!chunkText) return;
      const index = chunks.length;
      const sectionTitle = getSectionTitle(section);
      chunks.push({
        id: `${input.assetId}_chunk_${index}_${Math.random().toString(36).slice(2, 8)}`,
        assetId: input.assetId,
        title: input.title,
        text: chunkText,
        pageNumber: getPageNumber(section),
        sectionTitle,
        index,
        keywords: extractKeywords(chunkText),
        createdAt: now,
      });
    });
  });

  return chunks;
}

export function scoreChunk(query: string, chunk: DocumentChunk): number {
  const terms = extractKeywords(query);
  if (terms.length === 0) return 0;

  const haystack = `${chunk.sectionTitle || ''}\n${chunk.text}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (haystack.includes(term)) score += term.length > 3 ? 3 : 1;
    if (chunk.keywords.includes(term)) score += 2;
    return score;
  }, 0);
}
