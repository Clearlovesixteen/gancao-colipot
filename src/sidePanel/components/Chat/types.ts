import type { ParsedUploadedFile } from '../../../shared/fileParser';
import type { NativeLLMFile } from '../../utils/llm-files';
import type { NativeUploadStatus, OcrStatus, StructuredOcrResult } from '../../../shared/documentTypes';
import type { ModelMessage, NativeFileReference } from '../../../shared/modelRuntimeTypes';
import type {
  BrowserObservation,
  ComputerUseAction,
  ComputerUseResumeCheckpoint,
  ComputerUseTraceEntry,
} from '../../../shared/automationTypes';

export interface FileAttachment {
  uid: string;
  fileId: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  thumbUrl?: string;
  parsed?: ParsedUploadedFile;
  parseStatus: ParsedUploadedFile['status'];
  parseWarning?: string;
  parseError?: string;
  nativeFile?: NativeLLMFile;
  nativeUploadStatus: NativeUploadStatus | 'uploading';
  nativeUploadError?: string;
  ocrStatus: OcrStatus;
  ocrProgress?: number;
}

export interface ChatAttachmentItem {
  id: string;
  fileId: string;
  name: string;
  type: string;
  size: number;
  thumbUrl?: string;
  parseStatus: ParsedUploadedFile['status'];
  nativeUploadStatus: NativeUploadStatus | 'uploading';
  ocrStatus: OcrStatus;
}

export interface OcrResultMessageData {
  fileName: string;
  documentId: string;
  status: 'success' | 'low_confidence' | 'empty';
  pageCount: number;
  fieldCount: number;
  tableCount: number;
  sectionCount: number;
  previewFields: Array<{ key: string; value: string }>;
  warnings: string[];
  text: string;
  structuredOcr?: StructuredOcrResult;
}

export interface OcrViewerState {
  fileName: string;
  documentId: string;
  text: string;
  structuredOcr?: StructuredOcrResult;
}

export type ComputerUseTaskStatus = 'running' | 'waiting_confirmation' | 'finished' | 'error' | 'stopped';

export interface ComputerUseTaskTraceState {
  runId: string;
  goal: string;
  status: ComputerUseTaskStatus;
  currentStep?: string;
  summary?: string;
  error?: string;
  entries: ComputerUseTraceEntry[];
  lastObservation?: BrowserObservation;
  steps?: Array<{ action?: ComputerUseAction; result?: unknown }>;
  resumeCheckpoint?: ComputerUseResumeCheckpoint;
}

export type ChatMessage = ModelMessage & {
  llmContent?: string;
  nativeFiles?: NativeFileReference[];
  kind?: 'text' | 'ocr_result' | 'file_attachment' | 'browser_use_task' | 'tool_result' | 'diagnosis_result' | 'document_qa_result';
  computerUseTrace?: ComputerUseTaskTraceState;
  attachments?: ChatAttachmentItem[];
  ocrResult?: OcrResultMessageData;
  documentQaResult?: { answer: string; sources: Array<{ documentId: string; documentTitle?: string; fileName?: string; pageNumber?: number; sectionTitle?: string; chunkId?: string; excerpt?: string }> };
};

