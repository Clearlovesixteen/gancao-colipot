export type DocumentSourceType = 'file' | 'webpage' | 'ocr' | 'paste';

export type DocumentParseStatus = 'pending' | 'parsed' | 'partial' | 'error' | 'unsupported';
export type NativeUploadStatus = 'pending' | 'uploaded' | 'error' | 'skipped';
export type OcrStatus = 'not_needed' | 'pending' | 'running' | 'done' | 'partial' | 'error';

export type ResultKind = 'requirement_tasks' | 'page_structured_data' | 'document_summary' | 'document_compare' | 'document_tables';

export interface SourceRef {
  documentId: string;
  documentTitle: string;
  chunkId?: string;
  pageNumber?: number;
  sectionTitle?: string;
  excerpt?: string;
}

export interface DocumentAsset {
  id: string;
  sourceType: DocumentSourceType;
  title: string;
  mimeType: string;
  size?: number;
  createdAt: number;
  updatedAt: number;
  localParseStatus: DocumentParseStatus;
  nativeUploadStatus: NativeUploadStatus;
  ocrStatus: OcrStatus;
  nativeFileId?: string;
  summary?: string;
  error?: string;
}

export interface DocumentContent {
  assetId: string;
  text: string;
  localText?: string;
  ocrText?: string;
  structuredOcr?: StructuredOcrResult;
  tables?: DocumentTable[];
  metadata?: Record<string, unknown>;
  updatedAt: number;
}

export interface DocumentChunk {
  id: string;
  assetId: string;
  title: string;
  text: string;
  pageNumber?: number;
  sectionTitle?: string;
  index: number;
  keywords: string[];
  createdAt: number;
}

export interface DocumentTable {
  title?: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount?: number;
  selector?: string;
}

export type StructuredOcrDocumentType = 'form' | 'table' | 'report' | 'receipt' | 'contract' | 'unknown';

export interface StructuredOcrField {
  key: string;
  value: string;
  pageNumber?: number;
  confidence?: number;
  sourceText?: string;
}

export interface StructuredOcrSection {
  title?: string;
  type: 'title' | 'paragraph' | 'list' | 'key_value' | 'table' | 'page' | 'unknown';
  text: string;
  pageNumber?: number;
  items?: string[];
  confidence?: number;
}

export interface StructuredOcrResult {
  documentType: StructuredOcrDocumentType;
  summary: string;
  pageCount: number;
  fields: StructuredOcrField[];
  tables: DocumentTable[];
  sections: StructuredOcrSection[];
  rawText: string;
  warnings: string[];
  createdAt: number;
}

export interface DocumentResult<T = unknown> {
  id: string;
  kind: ResultKind;
  title: string;
  documentIds: string[];
  data: T;
  createdAt: number;
  updatedAt: number;
}

export interface RequirementTask {
  id: string;
  title: string;
  module: string;
  type: 'frontend' | 'backend' | 'test' | 'product' | 'design' | 'ops' | 'unknown';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  risks: string[];
  openQuestions: string[];
  sourceRefs: SourceRef[];
}

export interface RequirementTaskResult {
  documentIds: string[];
  summary: string;
  modules: string[];
  tasks: RequirementTask[];
  milestones: string[];
  missingInfo: string[];
  createdAt: number;
}

export interface PageStructuredField {
  label: string;
  value: string;
  selector?: string;
  confidence: number;
}

export interface PageStructuredList {
  title?: string;
  items: string[];
  selector?: string;
}

export interface PageStructuredData {
  url: string;
  title: string;
  capturedAt: number;
  headings: string[];
  fields: PageStructuredField[];
  tables: DocumentTable[];
  lists: PageStructuredList[];
}

export interface DocumentSearchMatch {
  chunk: DocumentChunk;
  asset: DocumentAsset;
  score: number;
}
