import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Input, Button, Space, Typography, Spin, Avatar, Badge, Image, Tag, Drawer, Tooltip, Dropdown, Menu, message, Modal, Tabs, Card, Table, Empty, Timeline, Collapse, List, Select, Switch } from 'antd';
import { SendOutlined, UserOutlined, RobotOutlined, ThunderboltOutlined, PaperClipOutlined, DeleteOutlined, ToolOutlined, AppstoreOutlined, MoreOutlined, StopOutlined, CopyOutlined, ReloadOutlined, HistoryOutlined, PlusOutlined, EditOutlined, InboxOutlined } from '@ant-design/icons';
import { Message } from '../../utils/sse';
import Tools from '../Tools';
import type { DocumentReferenceTarget } from '../Tools';
import moment from 'moment';
import styles from './Chat.module.scss';
import { parseUploadedFile, type ParsedUploadedFile } from '../../../shared/fileParser';
import type { NativeLLMFile } from '../../utils/llm-files';
import type { NativeFileReference } from '../../utils/glm-client';
import type { DocumentAsset, DocumentContent, NativeUploadStatus, OcrStatus, RequirementTaskResult, StructuredOcrResult } from '../../../shared/documentTypes';
import {
  shouldRouteToDocumentQa,
} from '../../utils/agentOrchestrator';
import {
  getDocumentContent,
  makeDocumentId,
  rebuildDocumentChunks,
  saveDocumentContent,
  saveRawFile,
  upsertDocumentAsset,
} from '../../utils/documentStore';
import { structuredOcrToMarkdown } from '../../../shared/ocrStructurer';
import { formatComputerUseTablesMessage, getLatestExtractedTablesFromSteps } from '../../../shared/computerUseResults';
import type { BrowserObservation, ComputerUseAction, ComputerUseTrace, ComputerUseTraceEntry } from '../../../shared/automationTypes';
import { COPILOT_COMMANDS, getQuickCommands, type CopilotCommandId } from '../../utils/copilotCommands';
import { useCommandRecommendations } from './useCommandRecommendations';
import { createAndRunChatTask } from '../../utils/chatTaskClient';
import { getAutomationRun } from '../../../shared/automationRunStore';
import { listCustomCommands, renderCustomCommandMetadata, renderCustomCommandTemplate, type CustomCopilotCommand } from '../../../shared/customCommandStore';
import {
  buildMemoryContext,
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  getChatSessionMessages,
  inferMemoryType,
  listChatSessions,
  saveChatMessage,
  suggestMemoryCandidatesFromMessage,
  updateChatSession,
  upsertUserMemory,
  type ChatSession,
  type StoredChatMessage,
} from '../../../shared/userMemoryStore';

const { TextArea } = Input;
const { Text, Title } = Typography;
const { TabPane } = Tabs;
const { Panel } = Collapse;

interface FileAttachment {
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

type ChatMessage = Message & {
  llmContent?: string;
  nativeFiles?: NativeFileReference[];
  kind?: 'text' | 'ocr_result' | 'file_attachment' | 'computer_use_task' | 'tool_result' | 'diagnosis_result' | 'document_qa_result';
  computerUseTrace?: ComputerUseTaskTraceState;
  attachments?: ChatAttachmentItem[];
  ocrResult?: OcrResultMessageData;
  documentQaResult?: { answer: string; sources: Array<{ documentId: string; documentTitle?: string; fileName?: string; pageNumber?: number; sectionTitle?: string; chunkId?: string; excerpt?: string }> };
};

type ChatAttachmentItem = {
  id: string;
  fileId: string;
  name: string;
  type: string;
  size: number;
  thumbUrl?: string;
  parseStatus: ParsedUploadedFile['status'];
  nativeUploadStatus: NativeUploadStatus | 'uploading';
  ocrStatus: OcrStatus;
};

type OcrResultMessageData = {
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
};

type StoredUploadedFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadTime: number;
  content: string;
  parsed: ParsedUploadedFile;
  nativeFile?: NativeLLMFile;
  asset?: DocumentAsset;
};

type OcrViewerState = {
  fileName: string;
  documentId: string;
  text: string;
  structuredOcr?: StructuredOcrResult;
};

type ComputerUseTaskStatus = 'running' | 'waiting_confirmation' | 'finished' | 'error' | 'stopped';

type ComputerUseTaskTraceState = {
  runId: string;
  goal: string;
  status: ComputerUseTaskStatus;
  currentStep?: string;
  summary?: string;
  error?: string;
  entries: ComputerUseTraceEntry[];
  lastObservation?: BrowserObservation;
  steps?: Array<{ action?: ComputerUseAction; result?: unknown }>;
};

const MAX_LLM_FILE_CONTEXT_LENGTH = 60000;

function createAiRequestId(): string {
  return `ai_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function documentsTitleFromTask(title: string): string {
  return String(title || 'OCR 资料').replace(/^OCR[：:]\s*/, '') || 'OCR 资料';
}

function normalizeUserFacingError(error: unknown, fallback = '请稍后重试'): string {
  const messageText = String((error as any)?.message || error || fallback);
  if (/Failed to fetch|NetworkError|Load failed/i.test(messageText)) {
    return '网络请求失败：暂时无法连接模型或后台服务，请检查网络/API 地址后重试。';
  }
  if (/HTTP error!\s*status:\s*400/i.test(messageText) && /missing field [`']?content[`']?|deserialize/i.test(messageText)) {
    return '模型请求格式异常：历史消息里存在缺少 content 的工具调用记录。请重新发送当前问题。';
  }
  if (/HTTP error!\s*status:\s*400/i.test(messageText)) {
    return '模型拒绝了本次请求：请求格式或上下文长度可能不符合接口要求。请缩短内容后重试。';
  }
  if (/HTTP error!\s*status:\s*5\d\d|502 Bad Gateway|Bad Gateway/i.test(messageText)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  return messageText;
}

function shouldRouteToComputerUse(message: string): boolean {
  return /(自动操作|操作|点击|点一下|填表|输入|选择|勾选|导出|下载|提交|打开.*页面|帮我.*页面|跑流程)/i.test(message.trim());
}

function getComputerUseActionLabel(action?: { action?: string; reason?: string }): string {
  if (!action) return '正在执行自动操作';
  if (action.action === 'extract_table') return '正在提取页面表格';
  if (action.action === 'download_file') return `正在导出文件：${action.reason || '点击导出/下载按钮'}`;
  if (action.action === 'click') return `正在点击：${action.reason || '目标元素'}`;
  if (action.action === 'type') return `正在输入：${action.reason || '文本'}`;
  return `正在执行：${action.reason || action.action}`;
}

function getComputerUseStatusMeta(status: ComputerUseTaskStatus): { label: string; color: string } {
  if (status === 'finished') return { label: '已完成', color: 'green' };
  if (status === 'error') return { label: '失败', color: 'red' };
  if (status === 'stopped') return { label: '已停止', color: 'orange' };
  if (status === 'waiting_confirmation') return { label: '待确认', color: 'gold' };
  return { label: '运行中', color: 'processing' };
}

function getComputerUseStateLabel(state?: string): string {
  const labels: Record<string, string> = {
    observing: '观察页面',
    planning: '分析规划',
    acting: '执行动作',
    verifying: '校验结果',
    recovering: '失败恢复',
    waiting_confirmation: '等待确认',
    done: '步骤完成',
  };
  return state ? labels[state] || state : '任务事件';
}

function summarizeComputerUseEntry(entry: ComputerUseTraceEntry): string {
  if (entry.error) return entry.error;
  if (entry.summary) return entry.summary;
  if (entry.action) return getComputerUseActionLabel(entry.action);
  const result = entry.result as any;
  if (entry.phaseGoal && result?.summary) {
    return `${entry.phaseGoal}：${result.summary}`;
  }
  if (result?.filename || result?.assetId || result?.downloadId) {
    if (result.savedToDocumentCenter && result.assetId) {
      return `已导出 ${result.filename || result.assetTitle || '文件'}，资料 ID：${result.assetId}`;
    }
    return result.message || `已触发下载 ${result.filename || result.downloadId}`;
  }
  if (result?.summary) return String(result.summary);
  if (typeof result?.navigationCount === 'number' || typeof result?.tableCount === 'number') {
    return [
      typeof result.navigationCount === 'number' ? `导航 ${result.navigationCount}` : '',
      typeof result.tableCount === 'number' ? `表格 ${result.tableCount}` : '',
    ].filter(Boolean).join('，');
  }
  if (entry.observation?.title) return `页面：${entry.observation.title}`;
  return getComputerUseStateLabel(entry.state);
}

function getLatestDownloadResultFromSteps(steps: Array<{ action?: ComputerUseAction; result?: unknown }> = []): any | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.action?.action !== 'download_file') continue;
    const result = step.result as any;
    if (!result) continue;
    return result?.success === true && result?.result ? result.result : result;
  }
  return null;
}

function makeComputerUseEntryFromEvent(event: any): ComputerUseTraceEntry {
  const base = {
    timestamp: Date.now(),
    type: event.type,
    goal: event.goal || '',
  };
  if (event.type === 'COMPUTER_USE_PROGRESS') {
    return {
      ...base,
      stepIndex: event.stepIndex,
      state: event.state,
      observation: event.observation,
      action: event.action,
      intent: event.intent,
      navigationPath: event.intent?.navigationPath,
      plan: event.plan,
      chosenElement: event.chosenElement,
      beforeObservation: event.beforeObservation,
      afterObservation: event.afterObservation,
      verification: event.verification,
      rejectedPlanReason: event.rejectedPlanReason,
      fallbackUsed: event.fallbackUsed,
      phaseIndex: event.phaseIndex,
      phaseType: event.phaseType,
      phaseGoal: event.phaseGoal,
      phase: event.phase,
      runState: event.runState,
      result: event.result,
    };
  }
  if (event.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') {
    return {
      ...base,
      stepIndex: event.stepIndex,
      state: 'waiting_confirmation',
      action: event.action,
      result: { reason: event.reason },
    };
  }
  if (event.type === 'COMPUTER_USE_FINISHED') {
    return {
      ...base,
      state: 'done',
      summary: event.summary,
      runState: event.runState,
      result: { steps: event.steps, runState: event.runState },
    };
  }
  return {
    ...base,
      error: event.error,
      observation: event.lastObservation,
      intent: event.intent,
      navigationPath: event.intent?.navigationPath,
      plan: event.plan,
      chosenElement: event.chosenElement,
      beforeObservation: event.beforeObservation,
      afterObservation: event.afterObservation,
      verification: event.verification,
      rejectedPlanReason: event.rejectedPlanReason,
      fallbackUsed: event.fallbackUsed,
      phaseIndex: event.phaseIndex,
      phaseType: event.phaseType,
      phaseGoal: event.phaseGoal,
      phase: event.phase,
      runState: event.runState,
      result: {
      steps: event.steps,
      verification: event.verification,
      runState: event.runState,
    },
  };
}

function compactTraceEntries(entries: ComputerUseTraceEntry[]): ComputerUseTraceEntry[] {
  return entries.slice(-80);
}

function traceStateFromBackgroundTrace(trace: ComputerUseTrace): ComputerUseTaskTraceState {
  const lastEntry = trace.entries[trace.entries.length - 1];
  return {
    runId: trace.runId,
    goal: trace.goal,
    status: trace.status,
    currentStep: lastEntry ? getComputerUseStateLabel(lastEntry.state) : undefined,
    summary: lastEntry?.summary,
    error: lastEntry?.error,
    entries: trace.entries,
    lastObservation: [...trace.entries].reverse().find((entry) => entry.observation)?.observation,
  };
}
const MAX_LLM_TEXT_PER_FILE = 24000;

function makeFileId(): string {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function truncateForLLM(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[内容过长，已截断 ${text.length - maxLength} 字符]`;
}

function formatStructuredOcrPreview(structuredOcr: StructuredOcrResult): string {
  const lines = [
    structuredOcr.summary,
    structuredOcr.warnings.length ? `识别提示：${structuredOcr.warnings.join('；')}` : '',
  ].filter(Boolean);

  if (structuredOcr.fields.length) {
    lines.push('', '关键字段：');
    structuredOcr.fields.slice(0, 8).forEach((field) => {
      lines.push(`- ${field.key}：${field.value}`);
    });
    if (structuredOcr.fields.length > 8) {
      lines.push(`- 还有 ${structuredOcr.fields.length - 8} 个字段可在 OCR 结构化结果中查看`);
    }
  }

  if (structuredOcr.tables.length) {
    lines.push('', '表格：');
    structuredOcr.tables.slice(0, 3).forEach((table, index) => {
      lines.push(`- ${table.title || `表格 ${index + 1}`}：${table.rowCount} 行，${table.columnCount || table.headers.length} 列`);
    });
  }

  if (!structuredOcr.fields.length && !structuredOcr.tables.length) {
    const paragraph = structuredOcr.sections.find((section) => section.type === 'paragraph')?.text || structuredOcr.rawText;
    if (paragraph) {
      lines.push('', paragraph.slice(0, 700));
    }
  }

  return lines.join('\n');
}

function shouldNeedOcr(file: File, parsed?: ParsedUploadedFile): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return !parsed?.text?.trim();
  }
  return false;
}

function parsedSheetsToTables(parsed?: ParsedUploadedFile) {
  return parsed?.sheets?.map((sheet) => ({
    title: sheet.name,
    headers: sheet.headers || [],
    rows: sheet.rows.map((row) => row.map((cell) => String(cell ?? ''))),
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
  }));
}

function buildFileContext(files: FileAttachment[]): string {
  if (files.length === 0) return '';

  const sections = files.map((file, index) => {
    const parsed = file.parsed;
    const parsedText = parsed?.text?.trim() || '';
    const lines = [
      `## 附件 ${index + 1}`,
      `fileId: ${file.fileId}`,
      `documentId: ${file.fileId}`,
      `文件名: ${file.name}`,
      `MIME: ${file.type || 'unknown'}`,
      `大小: ${file.size} bytes`,
      '模型原生文件: 当前模型为纯文本模型，已跳过原生文件上传。',
      `解析状态: ${parsed?.status || file.parseStatus}`,
      `OCR 状态: ${file.ocrStatus}`,
      `内容类型: ${parsed?.kind || 'unknown'}`,
    ];

    if (parsed?.warning || file.parseWarning) {
      lines.push(`解析警告: ${parsed?.warning || file.parseWarning}`);
    }

    if (parsed?.error || file.parseError) {
      lines.push(`解析错误: ${parsed?.error || file.parseError}`);
    }

    if (parsedText) {
      lines.push(`本地解析备用正文:\n${truncateForLLM(parsedText, MAX_LLM_TEXT_PER_FILE)}`);
    } else if (parsed?.sheets?.length) {
      lines.push(`本地表格数据预览:\n${truncateForLLM(JSON.stringify(parsed.sheets, null, 2), MAX_LLM_TEXT_PER_FILE)}`);
    } else {
      lines.push('解析正文: [未提取到文本。若这是扫描件或图片型 PDF，需要 OCR 能力。]');
    }

    return lines.join('\n');
  });

  return truncateForLLM(
    [
      '以下是用户本次消息上传附件的解析结果。请优先基于这些内容回答，不要声称无法读取附件。',
      `本轮资料 documentIds: ${files.map((file) => file.fileId).join(', ')}`,
      '当前接入模型是纯文本模型，不支持直接读取原生文件；请只基于本地解析文本、表格、OCR 或资料中心工具结果回答。',
      ...sections,
    ].join('\n\n'),
    MAX_LLM_FILE_CONTEXT_LENGTH
  );
}

function normalizeToolResponse(response: any): any {
  if (response?.result && response.success === true && response.result.success !== undefined) {
    return response.result;
  }
  return response;
}

function summarizeDocumentList(documents: DocumentAsset[] = []): string {
  if (documents.length === 0) return '资料中心暂无文件。';
  return [
    `资料中心共有 ${documents.length} 个资料：`,
    ...documents.slice(0, 10).map((asset, index) => (
      `${index + 1}. ${asset.title}｜解析 ${asset.localParseStatus}｜模型 ${asset.nativeUploadStatus}｜OCR ${asset.ocrStatus}｜ID: ${asset.id}`
    )),
  ].join('\n');
}

function summarizePageStructuredData(data: any): string {
  if (!data) return '网页结构化提取完成，但没有返回可展示数据。';
  return [
    `已提取当前网页：${data.title || data.url || '未命名页面'}`,
    `字段：${data.fields?.length || 0} 个`,
    `表格：${data.tables?.length || 0} 个`,
    `列表：${data.lists?.length || 0} 个`,
    '结果已保存到资料中心。',
  ].join('\n');
}

function summarizeRequirementResult(result?: RequirementTaskResult): string {
  if (!result) return '任务清单已生成，结果已保存到资料中心。';
  return [
    result.summary,
    `模块：${result.modules.join('、') || '未识别'}`,
    `任务数：${result.tasks.length}`,
    result.missingInfo.length ? `待确认：${result.missingInfo.join('；')}` : '',
    '完整结果已保存到资料中心，可在工具箱中导出。',
  ].filter(Boolean).join('\n');
}

const LONG_MESSAGE_PREVIEW_LENGTH = 1600;

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function getAttachmentTypeLabel(type: string): string {
  if (type.startsWith('image/')) return '图片';
  if (type.includes('pdf')) return 'PDF';
  if (type.includes('word') || type.includes('document')) return 'Word';
  if (type.includes('spreadsheet') || type.includes('excel')) return 'Excel';
  if (type.includes('csv')) return 'CSV';
  if (type.startsWith('text/')) return '文本';
  return '文件';
}

function getAttachmentStatus(attachment: ChatAttachmentItem): { label: string; color: string } {
  if (attachment.ocrStatus === 'running') return { label: 'OCR 中', color: 'processing' };
  if (attachment.ocrStatus === 'done') return { label: 'OCR 完成', color: 'green' };
  if (attachment.ocrStatus === 'partial') return { label: '未识别文字', color: 'gold' };
  if (attachment.ocrStatus === 'error') return { label: 'OCR 失败', color: 'red' };
  if (attachment.parseStatus === 'parsed') return { label: '已解析', color: 'green' };
  if (attachment.parseStatus === 'partial') return { label: '部分解析', color: 'gold' };
  if (attachment.parseStatus === 'error') return { label: '解析失败', color: 'red' };
  if (attachment.nativeUploadStatus === 'uploading') return { label: '上传中', color: 'processing' };
  return { label: '已添加', color: 'default' };
}

function attachmentFromFile(file: FileAttachment): ChatAttachmentItem {
  return {
    id: file.uid,
    fileId: file.fileId,
    name: file.name,
    type: file.type,
    size: file.size,
    thumbUrl: file.thumbUrl,
    parseStatus: file.parseStatus,
    nativeUploadStatus: file.nativeUploadStatus,
    ocrStatus: file.ocrStatus,
  };
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={`code_${match.index}`} className={styles.markdownInlineCode}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`bold_${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(line) && line.includes('-');
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function renderMarkdownTable(lines: string[], key: string) {
  const headers = parseMarkdownTableRow(lines[0] || '');
  const rows = lines.slice(2).map(parseMarkdownTableRow).filter(row => row.some(Boolean));
  return (
    <div key={key} className={styles.markdownTableWrap}>
      <table className={styles.markdownTable}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={`${key}_h_${index}`}>{renderInlineMarkdown(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${key}_r_${rowIndex}`}>
              {headers.map((_, cellIndex) => (
                <td key={`${key}_r_${rowIndex}_${cellIndex}`}>{renderInlineMarkdown(row[cellIndex] || '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderMarkdownTextBlocks(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.includes('|') && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      nodes.push(renderMarkdownTable(tableLines, `${keyPrefix}_table_${index}`));
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      nodes.push(
        <div key={`${keyPrefix}_heading_${index}`} className={styles.markdownHeading} data-level={headingMatch[1].length}>
          {renderInlineMarkdown(headingMatch[2])}
        </div>
      );
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      nodes.push(
        <blockquote key={`${keyPrefix}_quote_${index}`} className={styles.markdownQuote}>
          {quoteLines.map((quote, quoteIndex) => (
            <div key={`${keyPrefix}_quote_${index}_${quoteIndex}`}>{renderInlineMarkdown(quote)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const listItems: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (ordered ? !/^\d+\.\s+/.test(current) : !/^[-*]\s+/.test(current)) break;
        listItems.push(current.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ''));
        index += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      nodes.push(
        <ListTag key={`${keyPrefix}_list_${index}`} className={styles.markdownList}>
          {listItems.map((item, itemIndex) => (
            <li key={`${keyPrefix}_list_${index}_${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,4})\s+/.test(lines[index].trim()) &&
      !/^[-*]\s+/.test(lines[index].trim()) &&
      !/^\d+\.\s+/.test(lines[index].trim()) &&
      !/^>\s?/.test(lines[index].trim()) &&
      !(lines[index].includes('|') && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1]))
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={`${keyPrefix}_p_${index}`} className={styles.markdownParagraph}>
        {renderInlineMarkdown(paragraphLines.join('\n'))}
      </p>
    );
  }

  return nodes;
}

function renderMarkdownContent(content: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const fencePattern = /```(\w+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let blockIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderMarkdownTextBlocks(content.slice(lastIndex, match.index), `md_${blockIndex}`));
    }
    const language = match[1] || 'text';
    const code = match[2] || '';
    nodes.push(
      <div key={`code_block_${blockIndex}`} className={styles.markdownCodeBlock}>
        <div className={styles.markdownCodeHeader}>
          <Text type="secondary">{language}</Text>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => navigator.clipboard?.writeText(code)}>
            复制
          </Button>
        </div>
        <pre className={styles.markdownPre}><code>{code}</code></pre>
      </div>
    );
    lastIndex = match.index + match[0].length;
    blockIndex += 1;
  }
  if (lastIndex < content.length) {
    nodes.push(...renderMarkdownTextBlocks(content.slice(lastIndex), `md_${blockIndex}`));
  }
  return nodes;
}

const MarkdownMessage: React.FC<{
  content: string;
  isUser?: boolean;
  onSave?: (content: string) => void;
}> = ({ content, isUser = false, onSave }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > LONG_MESSAGE_PREVIEW_LENGTH;
  const displayContent = isLong && !expanded
    ? `${content.slice(0, LONG_MESSAGE_PREVIEW_LENGTH)}\n\n...`
    : content;

  if (isUser) {
    return <div className={styles.messageText}>{content}</div>;
  }

  return (
    <div className={styles.markdownMessage}>
      {renderMarkdownContent(displayContent)}
      {(isLong || content) && (
        <div className={styles.markdownActions}>
          {isLong && (
            <Button size="small" type="link" onClick={() => setExpanded(value => !value)}>
              {expanded ? '收起' : '展开全文'}
            </Button>
          )}
          <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => navigator.clipboard?.writeText(content)}>
            复制
          </Button>
          {onSave && (
            <Button size="small" type="link" onClick={() => onSave(content)}>
              发送到资料中心
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

const AttachmentMessageCard: React.FC<{ attachments: ChatAttachmentItem[] }> = ({ attachments }) => {
  if (!attachments.length) return null;
  return (
    <div className={styles.attachmentChips}>
      {attachments.map((attachment) => {
        const status = getAttachmentStatus(attachment);
        return (
          <div key={attachment.id} className={styles.attachmentChip}>
            {attachment.thumbUrl && attachment.type.startsWith('image/') ? (
              <img src={attachment.thumbUrl} alt={attachment.name} className={styles.attachmentThumb} />
            ) : (
              <PaperClipOutlined className={styles.attachmentIcon} />
            )}
            <div className={styles.attachmentInfo}>
              <div className={styles.attachmentName}>{attachment.name}</div>
              <div className={styles.attachmentMeta}>
                {getAttachmentTypeLabel(attachment.type)} · {formatFileSize(attachment.size)}
              </div>
            </div>
            <Tag color={status.color}>{status.label}</Tag>
          </div>
        );
      })}
    </div>
  );
};

const OcrResultCard: React.FC<{
  data: OcrResultMessageData;
  onView: () => void;
  onCopy: () => void;
  onAnalyze: () => void;
  onAsk: () => void;
}> = ({ data, onView, onCopy, onAnalyze, onAsk }) => {
  const statusMeta = data.status === 'success'
    ? { color: 'green', label: 'OCR 成功' }
    : data.status === 'low_confidence'
      ? { color: 'gold', label: '低置信度' }
      : { color: 'orange', label: '未识别文字' };
  return (
    <div className={styles.ocrResultCard}>
      <div className={styles.ocrResultHeader}>
        <div>
          <div className={styles.ocrResultTitle}>{data.fileName}</div>
          <Text type="secondary" className={styles.ocrResultId}>资料 ID：{data.documentId}</Text>
        </div>
        <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
      </div>
      <div className={styles.ocrResultStats}>
        <span>{data.pageCount || 1} 页</span>
        <span>{data.fieldCount} 字段</span>
        <span>{data.tableCount} 表格</span>
        <span>{data.sectionCount} 正文区块</span>
      </div>
      {data.previewFields.length > 0 ? (
        <div className={styles.ocrPreviewFields}>
          {data.previewFields.slice(0, 3).map((field, index) => (
            <div key={`${field.key}_${index}`} className={styles.ocrPreviewField}>
              <Text type="secondary">{field.key}</Text>
              <span>{field.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.ocrEmptyPreview}>
          {data.status === 'empty' ? '未识别到可展示文本。' : '完整 OCR 内容可在详情中查看。'}
        </div>
      )}
      {data.warnings.length > 0 && (
        <div className={styles.ocrWarnings}>{data.warnings.slice(0, 2).join('；')}</div>
      )}
      <Space size={6} wrap className={styles.ocrActions}>
        <Button size="small" onClick={onView}>查看详情</Button>
        <Button size="small" icon={<CopyOutlined />} onClick={onCopy}>复制 OCR</Button>
        <Button size="small" onClick={onAnalyze}>发送给 AI 分析</Button>
        <Button size="small" type="primary" onClick={onAsk}>问资料</Button>
      </Space>
    </div>
  );
};

const Chat: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error'>('disconnected');
  const [isTyping, setIsTyping] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);
  const [toolsVisible, setToolsVisible] = useState(false);
  const [toolsInitialTool, setToolsInitialTool] = useState<string | null>(null);
  const [documentReference, setDocumentReference] = useState<DocumentReferenceTarget | null>(null);
  const [sessionsVisible, setSessionsVisible] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [customCommands, setCustomCommands] = useState<CustomCopilotCommand[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [ocrViewer, setOcrViewer] = useState<OcrViewerState | null>(null);
  const [computerUseRunId, setComputerUseRunId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeAiRequestIdRef = useRef<string | null>(null);
  const stoppedAiRequestIdsRef = useRef<Set<string>>(new Set());
  const shouldAutoScrollRef = useRef(true);
  const computerUseRunIdRef = useRef<string | null>(null);
  const startComputerUseRef = useRef<((goal?: string) => void) | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const chatTaskIdsRef = useRef<Set<string>>(new Set());
  const ocrTaskAssetsRef = useRef<Map<string, string>>(new Map());
  const pendingModelProfileIdRef = useRef<string | undefined>();

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const refreshChatSessions = useCallback(async () => {
    setChatSessions(await listChatSessions({ includeArchived: showArchivedSessions, query: sessionQuery }));
  }, [sessionQuery, showArchivedSessions]);

  useEffect(() => {
    if (sessionsVisible) refreshChatSessions().catch(() => {});
  }, [sessionsVisible, refreshChatSessions]);

  const toStoredChatMessage = useCallback((msg: ChatMessage, sessionId: string): StoredChatMessage => ({
    id: msg.id,
    sessionId,
    role: msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : msg.type === 'system' ? 'system' : 'assistant',
    content: msg.llmContent || msg.content || '',
    kind: msg.kind,
    attachments: msg.attachments?.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      size: item.size,
    })),
    toolCalls: msg.tool_calls?.map((tool) => ({ name: tool.name, arguments: tool.arguments })),
    computerUseRunId: msg.computerUseTrace?.runId,
    timestamp: msg.timestamp || Date.now(),
  }), []);

  const persistChatMessage = useCallback((msg: ChatMessage) => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId || !msg?.id) return;
    saveChatMessage(toStoredChatMessage(msg, sessionId))
      .then(async () => {
        if (msg.type === 'user') {
          await suggestMemoryCandidatesFromMessage({
            content: msg.llmContent || msg.content || '',
            sessionId,
            messageId: msg.id,
          });
        }
        await refreshChatSessions();
      })
      .catch((error) => console.warn('[ChatMemory] 保存聊天消息失败:', error));
  }, [refreshChatSessions, toStoredChatMessage]);

  const toChatMessage = useCallback((msg: StoredChatMessage): ChatMessage => ({
    id: msg.id,
    content: msg.content,
    llmContent: msg.content,
    type: msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system' : 'assistant',
    timestamp: msg.timestamp,
    kind: msg.kind as ChatMessage['kind'],
    attachments: msg.attachments?.map((item) => ({
      id: item.id || `${msg.id}_${item.name}`,
      fileId: item.id || '',
      name: item.name,
      type: item.type || '',
      size: item.size || 0,
      parseStatus: 'parsed',
      nativeUploadStatus: 'skipped',
      ocrStatus: 'not_needed',
    })),
    tool_calls: msg.toolCalls?.map((tool, index) => ({
      id: `${msg.id}_tool_${index}`,
      name: tool.name,
      arguments: tool.arguments || {},
    })),
  }), []);

  const loadChatSession = useCallback(async (sessionId: string) => {
    const storedMessages = await getChatSessionMessages(sessionId);
    setCurrentSessionId(sessionId);
    currentSessionIdRef.current = sessionId;
    setMessages(storedMessages.map(toChatMessage));
    setSessionsVisible(false);
    shouldAutoScrollRef.current = true;
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 0);
  }, [toChatMessage]);

  const createNewChatSession = useCallback(async () => {
    const session = await createChatSession();
    await refreshChatSessions();
    setCurrentSessionId(session.id);
    currentSessionIdRef.current = session.id;
    setMessages([]);
    setSessionsVisible(false);
  }, [refreshChatSessions]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessions = await listChatSessions();
      const session = sessions[0] || await createChatSession();
      const storedMessages = await getChatSessionMessages(session.id);
      if (cancelled) return;
      setChatSessions(sessions[0] ? sessions : [session]);
      setCurrentSessionId(session.id);
      currentSessionIdRef.current = session.id;
      setMessages(storedMessages.map(toChatMessage));
    })().catch((error) => console.warn('[ChatMemory] 初始化会话失败:', error));

    return () => {
      cancelled = true;
    };
  }, [toChatMessage]);

  const addAssistantMessage = useCallback((content: string) => {
    const assistantMessage: ChatMessage = {
      id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      type: 'assistant',
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, assistantMessage]);
    persistChatMessage(assistantMessage);
  }, [persistChatMessage]);

  const handleUnauthenticated = useCallback(async () => {
    message.warning('登录已失效，请重新登录');
    await chrome.storage.local.set({ user_auth: false });
  }, []);

  const executeBusinessTool = useCallback(async (toolName: string, args: Record<string, any> = {}) => {
    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_TOOL',
      toolName,
      arguments: args,
    });
    const normalized = normalizeToolResponse(response);
    if (normalized?.code === 'UNAUTHENTICATED') {
      await handleUnauthenticated();
      throw new Error(normalized.error || '未登录');
    }
    if (!normalized?.success) {
      throw new Error(normalized?.error || '工具执行失败');
    }
    return normalized;
  }, [handleUnauthenticated]);

  const { commandIds: recommendedCommandIds, refresh: refreshCommandContext } = useCommandRecommendations({
    executeTool: executeBusinessTool,
    hasAttachedFiles: attachedFiles.length > 0,
  });

  const saveTextMessageToDocuments = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    try {
      const now = Date.now();
      const asset: DocumentAsset = {
        id: makeDocumentId('ai_reply'),
        sourceType: 'paste',
        title: `AI 回复 ${moment(now).format('YYYY-MM-DD HH:mm')}`,
        mimeType: 'text/markdown',
        size: new Blob([trimmed]).size,
        createdAt: now,
        updatedAt: now,
        localParseStatus: 'parsed',
        nativeUploadStatus: 'skipped',
        ocrStatus: 'not_needed',
      };
      const contentRecord: DocumentContent = {
        assetId: asset.id,
        text: trimmed,
        localText: trimmed,
        metadata: { source: 'chat_message' },
        updatedAt: now,
      };
      await upsertDocumentAsset(asset);
      await saveDocumentContent(contentRecord);
      await rebuildDocumentChunks(asset, contentRecord);
      message.success(`已保存到资料中心：${asset.id}`);
    } catch (error: any) {
      message.error(error?.message || '保存到资料中心失败');
    }
  }, []);

  const handleRememberMessage = useCallback(async (msg: ChatMessage) => {
    const content = (msg.llmContent || msg.content || '').trim();
    if (!content) {
      message.warning('这条消息没有可保存的内容');
      return;
    }
    try {
      const memory = await upsertUserMemory({
        content,
        type: inferMemoryType(content),
        sourceSessionId: currentSessionIdRef.current || undefined,
        sourceMessageId: msg.id,
        confidence: 0.9,
        status: 'confirmed',
        enabled: true,
      });
      message.success(`已记住：${memory.title}`);
    } catch (error: any) {
      message.error(error?.message || '保存长期记忆失败');
    }
  }, []);

  const addOcrResultMessage = useCallback((data: OcrResultMessageData) => {
    const statusText = data.status === 'success' ? 'OCR 完成'
      : data.status === 'low_confidence' ? 'OCR 低置信度完成'
        : 'OCR 未识别到文字';
    const ocrMessage: ChatMessage = {
      id: `ocr_result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content: `${statusText}：${data.fileName}\n资料 ID：${data.documentId}`,
      type: 'assistant',
      timestamp: Date.now(),
      kind: 'ocr_result',
      ocrResult: data,
    };
    setMessages(prev => [...prev, ocrMessage]);
    persistChatMessage(ocrMessage);
  }, [persistChatMessage]);

  const upsertComputerUseTaskMessage = useCallback((
    runId: string,
    goal: string,
    updater: (trace: ComputerUseTaskTraceState) => ComputerUseTaskTraceState
  ) => {
    setMessages(prev => {
      let found = false;
      const nextMessages = prev.map((item) => {
        if (item.kind !== 'computer_use_task' || item.computerUseTrace?.runId !== runId) return item;
        found = true;
        const currentTrace = item.computerUseTrace || {
          runId,
          goal,
          status: 'running' as ComputerUseTaskStatus,
          currentStep: '准备启动',
          entries: [],
        };
        const updatedMessage: ChatMessage = {
          ...item,
          content: goal,
          timestamp: Date.now(),
          computerUseTrace: updater(currentTrace),
        };
        persistChatMessage(updatedMessage);
        return updatedMessage;
      });

      if (found) return nextMessages;

      const taskMessage: ChatMessage = {
        id: `computer_task_${runId}`,
        content: goal,
        type: 'assistant',
        timestamp: Date.now(),
        kind: 'computer_use_task',
        computerUseTrace: updater({
          runId,
          goal,
          status: 'running',
          currentStep: '准备启动',
          entries: [],
        }),
      };
      persistChatMessage(taskMessage);
      return [...nextMessages, taskMessage];
    });
  }, [persistChatMessage]);

  const mergeComputerUseEvent = useCallback((event: any) => {
    const runId = String(event.runId || '');
    if (!runId) return;
    const goal = String(event.goal || inputValue || '自动操作任务');
    const entry = makeComputerUseEntryFromEvent(event);
    upsertComputerUseTaskMessage(runId, goal, (trace) => {
      const entries = compactTraceEntries([...trace.entries, entry]);
      const lastObservation = event.observation || trace.lastObservation;
      const nextTrace: ComputerUseTaskTraceState = {
        ...trace,
        goal: goal || trace.goal,
        entries,
        lastObservation,
      };
      if (event.type === 'COMPUTER_USE_PROGRESS') {
        nextTrace.status = event.state === 'waiting_confirmation' ? 'waiting_confirmation' : 'running';
        nextTrace.currentStep = getComputerUseStateLabel(event.state);
        nextTrace.summary = (event.result as any)?.summary || trace.summary;
      } else if (event.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') {
        nextTrace.status = 'waiting_confirmation';
        nextTrace.currentStep = '等待确认';
        nextTrace.summary = event.reason || '等待用户确认高风险动作';
      } else if (event.type === 'COMPUTER_USE_FINISHED') {
        nextTrace.status = 'finished';
        nextTrace.currentStep = '已完成';
        nextTrace.summary = event.summary;
        nextTrace.steps = event.steps || trace.steps;
      } else if (event.type === 'COMPUTER_USE_ERROR') {
        nextTrace.status = event.error === '已停止' ? 'stopped' : 'error';
        nextTrace.currentStep = nextTrace.status === 'stopped' ? '已停止' : '失败';
        nextTrace.error = event.error || '自动操作失败';
        nextTrace.lastObservation = event.lastObservation || trace.lastObservation;
        nextTrace.steps = event.steps || trace.steps;
      }
      return nextTrace;
    });
  }, [inputValue, upsertComputerUseTaskMessage]);

  const fetchComputerUseTrace = useCallback(async (runId: string) => {
    try {
      const result = await executeBusinessTool('get_task_trace', { runId });
      const trace = result?.trace as ComputerUseTrace | null | undefined;
      if (!trace) return;
      upsertComputerUseTaskMessage(trace.runId, trace.goal, (current) => ({
        ...current,
        ...traceStateFromBackgroundTrace(trace),
        summary: current.summary || traceStateFromBackgroundTrace(trace).summary,
        steps: current.steps,
      }));
    } catch {
      // trace 是辅助信息，拉取失败不影响主流程展示。
    }
  }, [executeBusinessTool, upsertComputerUseTaskMessage]);

  const copyComputerUseTrace = useCallback(async (trace: ComputerUseTaskTraceState) => {
    const text = JSON.stringify(trace, null, 2);
    await navigator.clipboard?.writeText(text);
    message.success('自动操作日志已复制');
  }, []);

  const retryComputerUse = useCallback((trace: ComputerUseTaskTraceState) => {
    startComputerUseRef.current?.(trace.goal);
  }, []);

  const requestDebuggerPermission = useCallback(async () => {
    if (!chrome.permissions?.contains || !chrome.permissions?.request) {
      return false;
    }

    const permission = { permissions: ['debugger'] };
    const alreadyGranted = await new Promise<boolean>((resolve) => {
      chrome.permissions.contains(permission, (granted) => resolve(Boolean(granted)));
    });
    if (alreadyGranted) return true;
    return await new Promise<boolean>((resolve) => {
      chrome.permissions.request(permission, (granted) => resolve(Boolean(granted)));
    });
  }, []);

  const sendPromptToAI = useCallback((content: string, llmContent = content) => {
    const requestId = createAiRequestId();
    const modelProfileId = pendingModelProfileIdRef.current;
    pendingModelProfileIdRef.current = undefined;
    activeAiRequestIdRef.current = requestId;
    stoppedAiRequestIdsRef.current.delete(requestId);
    shouldAutoScrollRef.current = true;

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      llmContent,
      type: 'user',
      timestamp: Date.now(),
      requestId,
    };
    persistChatMessage(userMessage);

    setMessages(prev => {
      const updatedMessages = [...prev, userMessage];
      const messageHistory = updatedMessages
        .filter(msg => (msg.type === 'user' || msg.type === 'assistant') && msg.kind !== 'computer_use_task')
        .map(msg => ({
          role: msg.type === 'user' ? 'user' : 'assistant',
          content: msg.llmContent || msg.content,
          nativeFiles: msg.nativeFiles,
        }));

      buildMemoryContext(llmContent || content, currentSessionIdRef.current || undefined)
        .then((memoryContext) => chrome.runtime.sendMessage({
          type: 'SEND_MESSAGE',
          requestId,
          messageHistory,
          memoryContext: memoryContext.contextText,
          modelProfileId,
        }, async (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (activeAiRequestIdRef.current !== requestId) return;
        if (response?.code === 'UNAUTHENTICATED') {
          setIsTyping(false);
          await handleUnauthenticated();
          return;
        }
        if (response?.cancelled || response?.error === '请求已取消' || response?.error === '已停止生成') {
          setIsTyping(false);
          return;
        }
        if (runtimeError || !response?.success) {
          setIsTyping(false);
          addAssistantMessage(`AI 请求失败：${normalizeUserFacingError(response?.error || runtimeError)}`);
          return;
        }
        setIsTyping(false);
        }))
        .catch((error) => {
          setIsTyping(false);
          addAssistantMessage(`AI 请求失败：${normalizeUserFacingError(error)}`);
        });

      return updatedMessages;
    });

    setIsTyping(true);
  }, [addAssistantMessage, handleUnauthenticated, persistChatMessage]);

  const sendDirectPrompt = useCallback((content: string) => {
    sendPromptToAI(content);
  }, [sendPromptToAI]);

  const handleStopGeneration = useCallback(() => {
    if (computerUseRunIdRef.current) {
      const runId = computerUseRunIdRef.current;
      chrome.runtime.sendMessage({ type: 'STOP_COMPUTER_USE', runId }, (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        setIsTyping(false);
        setComputerUseRunId(null);
        computerUseRunIdRef.current = null;
        if (runtimeError || response?.success === false) {
          message.error(response?.error || runtimeError || '停止自动操作失败');
          return;
        }
        mergeComputerUseEvent({
          type: 'COMPUTER_USE_ERROR',
          runId,
          goal: '自动操作任务',
          error: '已停止',
        });
      });
      return;
    }

    const requestId = activeAiRequestIdRef.current;
    if (requestId) {
      stoppedAiRequestIdsRef.current.add(requestId);
      activeAiRequestIdRef.current = null;
    }
    setIsTyping(false);

    chrome.runtime.sendMessage({ type: 'STOP_AI_MESSAGE' }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      setIsTyping(false);
      if (runtimeError || response?.success === false) {
        message.error(response?.error || runtimeError || '停止生成失败');
        return;
      }
      addAssistantMessage('已停止生成。');
    });
  }, [addAssistantMessage, mergeComputerUseEvent]);

  const startComputerUse = useCallback((goal?: string) => {
    const finalGoal = (goal || inputValue.trim()).trim();
    if (!finalGoal) {
      setInputValue('请自动操作：');
      return;
    }

    shouldAutoScrollRef.current = true;
    const userMessage: ChatMessage = {
      id: `computer_user_${Date.now()}`,
      content: finalGoal,
      type: 'user',
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    persistChatMessage(userMessage);
    setInputValue('');
    setIsTyping(true);
    let startupSettled = false;
    const startupTimer = window.setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      setIsTyping(false);
      addAssistantMessage('自动操作启动超时：没有收到后台响应。请重新加载插件后重试，或查看扩展 background 控制台是否有报错。');
    }, 10000);

    chrome.runtime.sendMessage({
      type: 'RUN_COMPUTER_USE',
      goal: finalGoal,
      maxSteps: 10,
      allowHighRisk: false,
    }, async (response) => {
      if (startupSettled) return;
      startupSettled = true;
      window.clearTimeout(startupTimer);
      const runtimeError = chrome.runtime.lastError?.message;
      if (response?.code === 'UNAUTHENTICATED') {
        setIsTyping(false);
        await handleUnauthenticated();
        return;
      }
      if (runtimeError || !response?.success) {
        setIsTyping(false);
        addAssistantMessage(`自动操作启动失败：${response?.error || runtimeError || '请稍后重试'}`);
        return;
      }
      setComputerUseRunId(response.runId);
      computerUseRunIdRef.current = response.runId;
      mergeComputerUseEvent({
        type: 'COMPUTER_USE_PROGRESS',
        runId: response.runId,
        goal: finalGoal,
        stepIndex: 0,
        state: 'observing',
        result: { summary: '后台已接收自动操作任务，正在准备观察当前页面...' },
      });
    });
  }, [addAssistantMessage, handleUnauthenticated, inputValue, mergeComputerUseEvent, persistChatMessage]);

  useEffect(() => {
    startComputerUseRef.current = startComputerUse;
  }, [startComputerUse]);

  const isNearMessageBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceToBottom < 96;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!shouldAutoScrollRef.current) return;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    shouldAutoScrollRef.current = isNearMessageBottom();
  }, [isNearMessageBottom]);

  
  useEffect(() => {
    // 通知 background sidePanel已经打开
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_OPENED' }).catch(() => {});

    const messageListener = (message: any) => {
      if (message.type === 'SSE_MESSAGE') {
        const newMsg = message.message;
        if (
          newMsg?.requestId &&
          (stoppedAiRequestIdsRef.current.has(newMsg.requestId) || activeAiRequestIdRef.current !== newMsg.requestId)
        ) {
          return;
        }
        persistChatMessage(newMsg);
        
        // 处理steam消息
        setMessages(prev => {
          const lastMessage = prev[prev.length - 1];
          
          if (lastMessage && 
              lastMessage.type === 'assistant' && 
              newMsg.type === 'assistant' &&
              lastMessage.id === newMsg.id) {
            return [...prev.slice(0, -1), newMsg];
          } else {
            return [...prev, newMsg];
          }
        });
      } else if (message.type === 'SSE_STATUS_CHANGE') {
        setConnectionStatus(message.status);
        if (message.status === 'connected' || message.status === 'error' || message.status === 'disconnected') {
          setIsTyping(false);
        }
      } else if (message.type === 'COMPUTER_USE_PROGRESS') {
        if (computerUseRunIdRef.current && message.runId !== computerUseRunIdRef.current) return;
        mergeComputerUseEvent(message);
      } else if (message.type === 'AUTOMATION_TASK_PROGRESS') {
        const assetId = ocrTaskAssetsRef.current.get(message.taskId);
        if (assetId && message.kind === 'ocr') {
          const progress = Math.round(Number(message.data?.progress || 0) * 100);
          setAttachedFiles((files) => files.map((file) => (
            file.fileId === assetId ? { ...file, ocrStatus: 'running', ocrProgress: progress } : file
          )));
        }
      } else if (message.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') {
        if (computerUseRunIdRef.current && message.runId !== computerUseRunIdRef.current) return;
        mergeComputerUseEvent(message);
        Modal.confirm({
          title: '确认高风险自动操作',
          content: message.reason || message.action?.reason || '该动作可能修改页面数据，是否允许继续？',
          okText: '允许',
          cancelText: '拒绝',
          onOk: () => {
            chrome.runtime.sendMessage({
              type: 'CONFIRM_COMPUTER_USE_ACTION',
              runId: message.runId,
              stepIndex: message.stepIndex,
              allowed: true,
            });
          },
          onCancel: () => {
            chrome.runtime.sendMessage({
              type: 'CONFIRM_COMPUTER_USE_ACTION',
              runId: message.runId,
              stepIndex: message.stepIndex,
              allowed: false,
            });
          },
        });
      } else if (message.type === 'COMPUTER_USE_FINISHED') {
        if (computerUseRunIdRef.current && message.runId !== computerUseRunIdRef.current) return;
        mergeComputerUseEvent(message);
        setIsTyping(false);
        setComputerUseRunId(null);
        computerUseRunIdRef.current = null;
        fetchComputerUseTrace(message.runId);
        const tableSummary = getLatestExtractedTablesFromSteps(message.steps || []);
        if (tableSummary) {
          addAssistantMessage(formatComputerUseTablesMessage(tableSummary, message.summary));
        }
      } else if (message.type === 'COMPUTER_USE_ERROR') {
        if (computerUseRunIdRef.current && message.runId !== computerUseRunIdRef.current) return;
        mergeComputerUseEvent(message);
        setIsTyping(false);
        setComputerUseRunId(null);
        computerUseRunIdRef.current = null;
        fetchComputerUseTrace(message.runId);
      } else if (message.type === 'AUTOMATION_TASK_FINISHED' || message.type === 'AUTOMATION_TASK_ERROR') {
        if (!chatTaskIdsRef.current.has(message.taskId)) return;
        chatTaskIdsRef.current.delete(message.taskId);
        const ocrAssetId = ocrTaskAssetsRef.current.get(message.taskId);
        ocrTaskAssetsRef.current.delete(message.taskId);
        getAutomationRun(message.taskId).then((run) => {
          if (!run) return;
          const output = (run.metadata as any)?.taskOutput;
          if (message.type === 'AUTOMATION_TASK_ERROR') {
            if (ocrAssetId) setAttachedFiles((files) => files.map((file) => (
              file.fileId === ocrAssetId ? { ...file, ocrStatus: 'error', ocrProgress: undefined, parseError: run.error } : file
            )));
            addAssistantMessage(`${run.title}失败：${run.error || message.result?.error || '未知错误'}`);
            return;
          }
          if (run.kind === 'document_qa') {
            const qaMessage: ChatMessage = {
              id: `document_qa_${Date.now()}`,
              content: String(output?.answer || run.resultSummary || '任务已完成'),
              type: 'assistant',
              kind: 'document_qa_result',
              documentQaResult: { answer: String(output?.answer || run.resultSummary || '任务已完成'), sources: output?.sources || [] },
              timestamp: Date.now(),
            };
            setMessages((items) => [...items, qaMessage]);
            persistChatMessage(qaMessage);
          } else if (run.kind === 'page_diagnosis') {
            addAssistantMessage(String(output?.answer || run.resultSummary || '任务已完成'));
          } else if (run.kind === 'ocr') {
            const structuredOcr = output?.structuredOcr || output?.result?.structuredOcr;
            const result = output?.result?.result || output?.result;
            addOcrResultMessage({
              fileName: documentsTitleFromTask(run.title),
              documentId: String(run.metadata?.assetId || ''),
              status: run.status === 'success' ? 'success' : result?.text ? 'low_confidence' : 'empty',
              pageCount: structuredOcr?.pageCount || result?.pages?.length || 0,
              fieldCount: structuredOcr?.fields?.length || 0,
              tableCount: structuredOcr?.tables?.length || 0,
              sectionCount: structuredOcr?.sections?.length || 0,
              previewFields: (structuredOcr?.fields || []).slice(0, 3).map((field: any) => ({ key: field.key, value: field.value })),
              warnings: structuredOcr?.warnings || result?.warnings || [],
              text: result?.text || '',
              structuredOcr,
            });
            if (ocrAssetId) setAttachedFiles((files) => files.map((file) => (
              file.fileId === ocrAssetId
                ? { ...file, ocrStatus: run.status === 'success' ? 'done' : 'partial', ocrProgress: 100, parseError: undefined }
                : file
            )));
          } else {
            addAssistantMessage(run.resultSummary || '任务已完成');
          }
        }).catch(() => {});
      } else if (message.type === 'SELECTED_TEXT_RECEIVED') {
        console.log('SELECTED_TEXT_RECEIVED', message.text);
        if (message.text) {
          setInputValue(message.text);
          
          setTimeout(() => {
            const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
            if (textarea) {
              textarea.focus();
              textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            }
          }, 100);
        }
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    // 获取当前连接状态
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (response?.status) {
        setConnectionStatus(response.status);
      }
    });

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [addAssistantMessage, fetchComputerUseTrace, handleUnauthenticated, mergeComputerUseEvent, persistChatMessage]);

  useEffect(() => {
    scrollToBottom('auto');
  }, [messages, isTyping, scrollToBottom]);

  const handleFileChange = useCallback(async (file: File) => {
    // 如果没有文件名（比如从剪贴板粘贴的图片），生成一个默认名称
    const fileExtension = file.type.split('/')[1] || 'file';
    const defaultName = file.type.startsWith('image/') 
      ? `粘贴的图片_${Date.now()}.${fileExtension === 'png' ? 'png' : fileExtension === 'jpeg' ? 'jpg' : 'png'}`
      : `粘贴的文件_${Date.now()}.${fileExtension}`;
    const fileName = file.name || defaultName;
    const fileId = makeFileId();
    
    const fileAttachment: FileAttachment = {
      uid: fileId,
      fileId,
      name: fileName,
      type: file.type || 'application/octet-stream',
      size: file.size,
      parseStatus: 'partial',
      nativeUploadStatus: 'skipped',
      ocrStatus: file.type.startsWith('image/') ? 'pending' : 'not_needed',
    };

    setAttachedFiles(prev => [...prev, fileAttachment]);

    try {
      const now = Date.now();
      const initialAsset: DocumentAsset = {
        id: fileId,
        sourceType: 'file',
        title: fileName,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        createdAt: now,
        updatedAt: now,
        localParseStatus: 'pending',
        nativeUploadStatus: 'skipped',
        ocrStatus: fileAttachment.ocrStatus,
      };
      await upsertDocumentAsset(initialAsset);
      await saveRawFile(fileId, file);

      const previewPromise = file.type.startsWith('image/')
        ? new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
          reader.readAsDataURL(file);
        })
        : Promise.resolve(undefined);

      const [parsedResult, previewResult] = await Promise.allSettled([
        parseUploadedFile(file),
        previewPromise,
      ]);

      const parsed: ParsedUploadedFile = parsedResult.status === 'fulfilled'
        ? parsedResult.value
        : {
            kind: 'binary',
            text: '',
            metadata: {
              name: file.name,
              type: file.type || 'application/octet-stream',
              size: file.size,
              extension: file.name.toLowerCase().match(/\.([^.]+)$/)?.[1] || '',
              parsedAt: Date.now(),
            },
            status: 'error',
            error: parsedResult.reason?.message || '本地解析失败',
          };

      const previewDataUrl = previewResult.status === 'fulfilled' ? previewResult.value : undefined;
      const nativeFile: NativeLLMFile | undefined = undefined;
      const nativeUploadError = undefined;
      const ocrStatus: OcrStatus = shouldNeedOcr(file, parsed) ? 'pending' : 'not_needed';
      const localParseStatus = parsed.status;
      const asset: DocumentAsset = {
        ...initialAsset,
        updatedAt: Date.now(),
        localParseStatus,
        nativeUploadStatus: 'skipped',
        ocrStatus,
        error: parsed.error,
      };
      const content: DocumentContent = {
        assetId: fileId,
        text: parsed.text || '',
        localText: parsed.text || '',
        tables: parsedSheetsToTables(parsed),
        metadata: parsed.metadata,
        updatedAt: Date.now(),
      };
      await upsertDocumentAsset(asset);
      await saveDocumentContent(content);
      await rebuildDocumentChunks(asset, content);

      const nextAttachment: FileAttachment = {
        ...fileAttachment,
        url: previewDataUrl,
        thumbUrl: previewDataUrl,
        parsed,
        parseStatus: parsed.status,
        parseWarning: parsed.warning,
        parseError: parsed.error,
        nativeFile,
        nativeUploadStatus: 'skipped',
        nativeUploadError,
        ocrStatus,
      };

      setAttachedFiles(prev => prev.map(item => (
        item.uid === fileId ? nextAttachment : item
      )));

      const result = await chrome.storage.local.get('uploadedFiles');
      const uploadedFiles: StoredUploadedFile[] = Array.isArray(result.uploadedFiles) ? result.uploadedFiles : [];
      const nextUploadedFiles = [
        ...uploadedFiles,
        {
          id: fileId,
          name: fileName,
          type: file.type || 'application/octet-stream',
          size: file.size,
          uploadTime: Date.now(),
          content: previewDataUrl || parsed.text || '',
          parsed,
          nativeFile,
          asset,
        },
      ].slice(-30);
      await chrome.storage.local.set({ uploadedFiles: nextUploadedFiles });

      if (ocrStatus === 'pending') {
        window.setTimeout(() => {
          handleRunOcr(nextAttachment);
        }, 0);
      }
    } catch (error) {
      console.error('保存文件到存储失败:', error);
      setAttachedFiles(prev => prev.map(item => (
        item.uid === fileId
          ? {
              ...item,
              parseStatus: 'error',
              parseError: error instanceof Error ? error.message : '文件处理失败',
              nativeUploadStatus: 'skipped',
            }
          : item
      )));
    }
    return false; // 阻止默认上传行为
  }, []);

  const handleRemoveFile = (uid: string) => {
    const removedFile = attachedFiles.find(f => f.uid === uid);
    if (removedFile?.fileId) {
      chrome.storage.local.get('uploadedFiles').then((result) => {
        const uploadedFiles = Array.isArray(result.uploadedFiles) ? result.uploadedFiles : [];
        const nextUploadedFiles = uploadedFiles.filter((item: StoredUploadedFile) => item.id !== removedFile.fileId);
        return chrome.storage.local.set({ uploadedFiles: nextUploadedFiles });
      }).catch((error) => {
        console.error('删除文件存储失败:', error);
      });
    }

    setAttachedFiles(prev => {
      const file = prev.find(f => f.uid === uid);
      if (file?.url && file.url.startsWith('blob:')) {
        URL.revokeObjectURL(file.url);
      }
      return prev.filter(f => f.uid !== uid);
    });
  };

  const handleAskFile = (file: FileAttachment, action: 'ask' | 'summary' | 'tasks' | 'compare') => {
    if (action === 'ask') {
      setInputValue(`请基于资料 ${file.fileId}（${file.name}）回答我的问题：`);
      return;
    }

    if (action === 'summary') {
      handleSummarizeFile(file);
      return;
    }

    if (action === 'tasks') {
      handleGenerateRequirementTasks(file);
      return;
    }

    handleCompareFile(file);
  };

  const handleRunPageDiagnosisAgent = async () => {
    try {
      const run = await createAndRunChatTask({ kind: 'page_diagnosis', title: '页面诊断', goal: '诊断当前页面的问题，并给出修复建议' });
      chatTaskIdsRef.current.add(run.id);
      message.success({ content: '页面诊断任务已启动', key: 'page_diagnosis' });
    } catch (error: any) {
      message.error({ content: normalizeUserFacingError(error, '页面诊断失败'), key: 'page_diagnosis' });
    }
  };

  const handleAskDocumentsAgent = useCallback(async (query?: string, documentIds?: string[]) => {
    const question = (query || inputValue.trim() || '请基于资料中心回答：').trim();
    if (!query && !inputValue.trim()) {
      setInputValue('请基于资料中心回答：');
      return;
    }

    try {
      const run = await createAndRunChatTask({
        kind: 'document_qa', title: '资料问答', goal: question, metadata: { question, documentIds },
      });
      chatTaskIdsRef.current.add(run.id);
      message.success({ content: '资料问答任务已启动', key: 'document_qa' });
      setInputValue('');
    } catch (error: any) {
      message.error({ content: normalizeUserFacingError(error, '资料问答失败'), key: 'document_qa' });
    }
  }, [inputValue]);

  const handleExtractPageData = async () => {
    try {
      const run = await createAndRunChatTask({ kind: 'extract', title: '页面数据提取', goal: '提取当前页面的结构化数据', metadata: { extractMode: 'structured' } });
      chatTaskIdsRef.current.add(run.id);
      message.success({ content: '页面提取任务已启动', key: 'page_extract' });
    } catch (error: any) {
      message.error({ content: error?.message || '网页提取失败', key: 'page_extract' });
    }
  };

  const handleListDocuments = async () => {
    try {
      const response = await executeBusinessTool('list_documents');
      addAssistantMessage(summarizeDocumentList(response.documents || []));
    } catch (error: any) {
      message.error(error?.message || '读取资料状态失败');
    }
  };

  const handleCopilotCommand = useCallback((commandId: CopilotCommandId) => {
    switch (commandId) {
      case 'computer_use':
        startComputerUse();
        break;
      case 'page_diagnosis':
        handleRunPageDiagnosisAgent();
        break;
      case 'document_qa':
        handleAskDocumentsAgent();
        break;
      case 'document_status':
        handleListDocuments();
        break;
      case 'page_summary':
        setInputValue('请总结当前页面，输出核心内容、关键字段、风险点和待办。');
        break;
      case 'extract_table':
        createAndRunChatTask({ kind: 'extract', title: '表格提取', goal: '提取当前页面的表格或列表数据', metadata: { extractMode: 'tables' } })
          .then((run) => { chatTaskIdsRef.current.add(run.id); message.success('表格提取任务已启动'); })
          .catch((error) => message.error(normalizeUserFacingError(error, '任务启动失败')));
        break;
      case 'task_list':
        setInputValue('请基于当前上下文生成任务清单，按优先级列出负责人、截止时间和风险。');
        break;
      case 'ocr':
        if (!attachedFiles.length) {
          message.info('请先添加图片或扫描文件。');
          break;
        }
        createAndRunChatTask({
          kind: 'ocr', title: `OCR：${attachedFiles[0].name}`, goal: `识别 ${attachedFiles[0].name}`,
          metadata: { assetId: attachedFiles[0].fileId, maxPages: 20 },
        }).then((run) => {
          chatTaskIdsRef.current.add(run.id);
          ocrTaskAssetsRef.current.set(run.id, attachedFiles[0].fileId);
          setAttachedFiles((files) => files.map((file, index) => index === 0 ? { ...file, ocrStatus: 'running', ocrProgress: 0 } : file));
          message.success('OCR 任务已启动');
        }).catch((error) => message.error(normalizeUserFacingError(error, 'OCR 任务启动失败')));
        break;
      default:
        break;
    }
  }, [attachedFiles, handleAskDocumentsAgent, startComputerUse]);

  const handleCustomCommand = useCallback(async (commandId: string) => {
    const command = customCommands.find((item) => item.id === commandId);
    if (!command) return;
    const executeWithValues = async (values: Record<string, unknown>) => {
      const renderedPrompt = renderCustomCommandTemplate(command.promptTemplate, values);
      const renderedMetadata = renderCustomCommandMetadata(command.metadata || {}, values) as Record<string, unknown>;
      if (command.mode === 'prompt') {
        pendingModelProfileIdRef.current = command.modelProfileId;
        setInputValue(renderedPrompt);
        return;
      }
      const runCommand = async () => {
      try {
        const run = await createAndRunChatTask({
          kind: command.taskKind || 'computer_use',
          title: command.title,
          goal: renderedPrompt,
          metadata: { ...renderedMetadata, modelProfileId: command.modelProfileId },
        });
        chatTaskIdsRef.current.add(run.id);
        message.success(`任务「${command.title}」已启动`);
      } catch (error: any) {
        message.error(normalizeUserFacingError(error, '命令执行失败'));
      }
      };
    if (command.riskLevel === 'high') {
      Modal.confirm({ title: '确认执行高风险命令', content: renderedPrompt, onOk: runCommand });
      return;
    }
    await runCommand();
    };
    const fields = command.inputSchema || [];
    if (!fields.length) { await executeWithValues({}); return; }
    const values: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? '']));
    Modal.confirm({
      title: command.title,
      width: 520,
      content: <Space direction="vertical" style={{ width: '100%' }}>{fields.map((field) => <div key={field.name}><Text>{field.label}{field.required ? ' *' : ''}</Text>{field.type === 'select' ? <Select style={{ width: '100%', marginTop: 4 }} defaultValue={field.defaultValue as any} options={field.options || []} onChange={(value: string) => { values[field.name] = value; }} /> : field.type === 'boolean' ? <Switch style={{ marginLeft: 8 }} defaultChecked={Boolean(field.defaultValue)} onChange={(value: boolean) => { values[field.name] = value; }} /> : <Input style={{ marginTop: 4 }} type={field.type === 'number' ? 'number' : 'text'} defaultValue={field.defaultValue as any} onChange={(event) => { values[field.name] = field.type === 'number' ? Number(event.target.value) : event.target.value; }} />}</div>)}</Space>,
      onOk: async () => {
        const missing = fields.find((field) => field.required && (values[field.name] === '' || values[field.name] === undefined));
        if (missing) throw new Error(`请填写${missing.label}`);
        await executeWithValues(values);
      },
    });
  }, [customCommands]);

  const handleSummarizeFile = async (file: FileAttachment) => {
    try {
      message.loading({ content: '正在读取资料片段...', key: `summary_${file.fileId}` });
      const response = await executeBusinessTool('summarize_document', { id: file.fileId });
      message.success({ content: '资料已读取，正在总结...', key: `summary_${file.fileId}` });
      sendPromptToAI(
        `请总结资料 ${file.fileId}（${file.name}），给出核心内容、关键字段、风险点和待办，并标注引用来源。`,
        [
        `请总结资料 ${file.fileId}（${file.name}），给出核心内容、关键字段、风险点和待办，并标注引用来源。`,
        '以下是资料片段：',
        JSON.stringify(response, null, 2),
        ].join('\n\n')
      );
    } catch (error: any) {
      message.error({ content: error?.message || '总结文件失败', key: `summary_${file.fileId}` });
    }
  };

  const handleGenerateRequirementTasks = async (file: FileAttachment) => {
    try {
      message.loading({ content: '正在生成任务清单...', key: `tasks_${file.fileId}` });
      const response = await executeBusinessTool('generate_requirement_tasks', { documentIds: [file.fileId] });
      message.success({ content: '任务清单已保存到资料中心', key: `tasks_${file.fileId}` });
      addAssistantMessage(summarizeRequirementResult(response.result));
    } catch (error: any) {
      message.error({ content: error?.message || '生成任务清单失败', key: `tasks_${file.fileId}` });
    }
  };

  const handleCompareFile = async (file: FileAttachment) => {
    try {
      message.loading({ content: '正在读取对比资料...', key: `compare_${file.fileId}` });
      const list = await executeBusinessTool('list_documents');
      const ids = (list.documents || []).map((asset: DocumentAsset) => asset.id);
      const compareIds = ids.includes(file.fileId) ? ids : [file.fileId, ...ids];
      const response = await executeBusinessTool('compare_documents', { ids: compareIds.slice(0, 8) });
      message.success({ content: '资料已读取，正在对比...', key: `compare_${file.fileId}` });
      sendPromptToAI(
        `请把资料 ${file.fileId}（${file.name}）与其它已上传资料进行对比，列出差异、重合点、风险和建议。`,
        [
        `请把资料 ${file.fileId}（${file.name}）与其它已上传资料进行对比，列出差异、重合点、风险和建议。`,
        '以下是对比资料：',
        JSON.stringify(response, null, 2),
        ].join('\n\n')
      );
    } catch (error: any) {
      message.error({ content: error?.message || '对比资料失败', key: `compare_${file.fileId}` });
    }
  };

  const handleViewOcrText = async (file: FileAttachment) => {
    try {
      const content = await getDocumentContent(file.fileId);
      const text = content?.ocrText || '';
      if (!text.trim()) {
        message.info('当前资料暂无 OCR 文本');
        return;
      }
      setOcrViewer({
        fileName: file.name,
        documentId: file.fileId,
        text,
        structuredOcr: content?.structuredOcr,
      });
    } catch (error: any) {
      message.error(error?.message || '读取 OCR 文本失败');
    }
  };

  const sendOcrTextToAI = useCallback((viewer: OcrViewerState) => {
    setOcrViewer(null);
    sendDirectPrompt([
      `请分析 OCR 识别结果，资料 ID：${viewer.documentId}，文件名：${viewer.fileName}`,
      '请给出核心内容、关键信息、可能的识别错误和后续建议。',
      viewer.structuredOcr ? 'OCR 结构化结果：' : 'OCR 文本：',
      viewer.structuredOcr ? structuredOcrToMarkdown(viewer.structuredOcr) : viewer.text,
    ].join('\n\n'));
  }, [sendDirectPrompt]);

  const handleRunOcr = async (file: FileAttachment) => {
    if (file.ocrStatus === 'running') return;
    setAttachedFiles(prev => prev.map(item => (
      item.uid === file.uid ? { ...item, ocrStatus: 'running', ocrProgress: 0 } : item
    )));
    try {
      const run = await createAndRunChatTask({
        kind: 'ocr', title: `OCR：${file.name}`, goal: `识别 ${file.name}`,
        metadata: { assetId: file.fileId, maxPages: 20 },
      });
      chatTaskIdsRef.current.add(run.id);
      ocrTaskAssetsRef.current.set(run.id, file.fileId);
      message.success('OCR 任务已启动');
    } catch (error: any) {
      const errorMessage = normalizeUserFacingError(error, 'OCR 任务启动失败');
      setAttachedFiles(prev => prev.map(item => (
        item.uid === file.uid
          ? { ...item, ocrStatus: 'error', ocrProgress: undefined, parseError: errorMessage }
          : item
      )));
      message.error(errorMessage);
    }
  };

  const handleSend = () => {
    if (!inputValue.trim() && attachedFiles.length === 0) {
      return;
    }

    if (attachedFiles.some(file => file.nativeUploadStatus === 'uploading')) {
      return;
    }

    if (attachedFiles.some(file => ['pending', 'running'].includes(file.ocrStatus))) {
      message.warning('文件正在准备 OCR，请等待 OCR 完成后再发送。');
      return;
    }

    if (attachedFiles.length === 0 && shouldRouteToComputerUse(inputValue)) {
      startComputerUse(inputValue.trim());
      return;
    }

    if (shouldRouteToDocumentQa(inputValue, attachedFiles.length > 0)) {
      handleAskDocumentsAgent(inputValue.trim());
      return;
    }

    const displayContent = inputValue.trim();
    const attachmentItems = attachedFiles.map(attachmentFromFile);
    const fileInfo = attachedFiles.map(file => (
      file.type.startsWith('image/') ? `[图片: ${file.name}]` : `[文件: ${file.name}]`
    )).join('\n');
    const messageContentForLLM = fileInfo
      ? (displayContent ? `${displayContent}\n\n${fileInfo}` : fileInfo)
      : displayContent;

    const fileContext = buildFileContext(attachedFiles);
    const llmContent = fileContext
      ? `${messageContentForLLM}\n\n---\n${fileContext}`
      : messageContentForLLM;
    const nativeFiles: NativeFileReference[] = attachedFiles
      .filter(file => file.nativeFile?.id)
      .map(file => ({
        id: file.nativeFile!.id,
        name: file.name,
        type: file.type,
        size: file.size,
      }));
    const requestId = createAiRequestId();
    activeAiRequestIdRef.current = requestId;
    stoppedAiRequestIdsRef.current.delete(requestId);
    shouldAutoScrollRef.current = true;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      content: displayContent,
      llmContent,
      nativeFiles,
      kind: attachmentItems.length ? 'file_attachment' : 'text',
      attachments: attachmentItems,
      type: 'user',
      timestamp: Date.now(),
      requestId,
    };
    persistChatMessage(userMessage);

    setMessages(prev => {
      const updatedMessages = [...prev, userMessage];
      
      const messageHistory = updatedMessages
        .filter(msg => (msg.type === 'user' || msg.type === 'assistant') && msg.kind !== 'computer_use_task')
        .map(msg => ({
          role: msg.type === 'user' ? 'user' : 'assistant',
          content: msg.llmContent || msg.content,
          nativeFiles: msg.nativeFiles,
        }));
      
      setInputValue('');
      setAttachedFiles([]);
      
      const modelProfileId = pendingModelProfileIdRef.current;
      pendingModelProfileIdRef.current = undefined;
      buildMemoryContext(llmContent || displayContent, currentSessionIdRef.current || undefined)
        .then((memoryContext) => chrome.runtime.sendMessage({
          type: 'SEND_MESSAGE',
          requestId,
          messageHistory: messageHistory,
          memoryContext: memoryContext.contextText,
          modelProfileId,
        }, async (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (activeAiRequestIdRef.current !== requestId) return;
        if (response?.code === 'UNAUTHENTICATED') {
          setIsTyping(false);
          await handleUnauthenticated();
          return;
        }
        if (response?.cancelled || response?.error === '请求已取消' || response?.error === '已停止生成') {
          setIsTyping(false);
          return;
        }
        if (runtimeError || !response?.success) {
          setIsTyping(false);
          setMessages(current => [
            ...current,
            {
              id: `error_${Date.now()}`,
              content: `AI 请求失败：${normalizeUserFacingError(response?.error || runtimeError)}`,
              type: 'assistant',
              timestamp: Date.now(),
            },
          ]);
          return;
        }
        setIsTyping(false);
        }))
        .catch((error) => {
          setIsTyping(false);
          addAssistantMessage(`AI 请求失败：${normalizeUserFacingError(error)}`);
        });

      return updatedMessages;
    });

    setIsTyping(true);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const renderStructuredOcr = (structuredOcr?: StructuredOcrResult) => {
    if (!structuredOcr) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无结构化 OCR 结果" />;
    }

    return (
      <Tabs defaultActiveKey="overview" size="small">
        <TabPane tab="概览" key="overview">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Card size="small">
              <Space wrap>
                <Tag color="blue">{structuredOcr.documentType}</Tag>
                <Tag>页数 {structuredOcr.pageCount}</Tag>
                <Tag>字段 {structuredOcr.fields.length}</Tag>
                <Tag>表格 {structuredOcr.tables.length}</Tag>
              </Space>
              <div style={{ marginTop: 10 }}>{structuredOcr.summary}</div>
            </Card>
            {structuredOcr.warnings.length > 0 && (
              <Card size="small" title="识别提示">
                <Space direction="vertical" size={4}>
                  {structuredOcr.warnings.map((warning, index) => (
                    <Text key={`${warning}_${index}`} type="secondary">{warning}</Text>
                  ))}
                </Space>
              </Card>
            )}
          </Space>
        </TabPane>
        <TabPane tab={`字段 ${structuredOcr.fields.length}`} key="fields">
          {structuredOcr.fields.length ? (
            <Table
              size="small"
              pagination={{ pageSize: 8 }}
              rowKey={(record, index) => `${record.key}_${index}`}
              dataSource={structuredOcr.fields}
              columns={[
                { title: '字段', dataIndex: 'key', width: 160 },
                { title: '内容', dataIndex: 'value' },
                { title: '页码', dataIndex: 'pageNumber', width: 72 },
              ]}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未识别出字段" />
          )}
        </TabPane>
        <TabPane tab={`表格 ${structuredOcr.tables.length}`} key="tables">
          {structuredOcr.tables.length ? (
            structuredOcr.tables.map((table, index) => (
              <Card key={`${table.title || 'ocr_table'}_${index}`} size="small" title={table.title || `表格 ${index + 1}`} style={{ marginBottom: 12 }}>
                <Table
                  size="small"
                  pagination={{ pageSize: 5 }}
                  columns={(table.headers || []).map((header, colIndex) => ({
                    title: header || `列 ${colIndex + 1}`,
                    dataIndex: String(colIndex),
                  }))}
                  dataSource={(table.rows || []).map((row, rowIndex) => ({
                    key: rowIndex,
                    ...row.reduce((acc, cell, colIndex) => ({ ...acc, [String(colIndex)]: cell }), {}),
                  }))}
                />
              </Card>
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未识别出表格" />
          )}
        </TabPane>
        <TabPane tab={`正文 ${structuredOcr.sections.length}`} key="sections">
          {structuredOcr.sections.length ? (
            <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: 420, overflow: 'auto' }}>
              {structuredOcr.sections.slice(0, 80).map((section, index) => (
                <Card
                  key={`${section.type}_${section.pageNumber || 0}_${index}`}
                  size="small"
                  title={section.title || `${section.type}${section.pageNumber ? ` · 第 ${section.pageNumber} 页` : ''}`}
                >
                  <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{section.text}</pre>
                </Card>
              ))}
            </Space>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无正文区块" />
          )}
        </TabPane>
      </Tabs>
    );
  };

  const renderOcrResultMessage = (data?: OcrResultMessageData) => {
    if (!data) return null;
    return (
      <OcrResultCard
        data={data}
        onView={() => setOcrViewer({
          fileName: data.fileName,
          documentId: data.documentId,
          text: data.text,
          structuredOcr: data.structuredOcr,
        })}
        onCopy={() => {
          navigator.clipboard?.writeText(data.text || data.structuredOcr?.rawText || '');
          message.success('OCR 文本已复制');
        }}
        onAnalyze={() => sendPromptToAI(
          `请分析 OCR 资料 ${data.documentId}（${data.fileName}）`,
          [
            `请分析 OCR 资料 ${data.documentId}（${data.fileName}），给出核心内容、关键字段、风险点和待办，并标注引用来源。`,
            '',
            data.structuredOcr ? structuredOcrToMarkdown(data.structuredOcr) : data.text,
          ].join('\n')
        )}
        onAsk={() => setInputValue(`请基于资料 ${data.documentId}（${data.fileName}）回答：`)}
      />
    );
  };

  const renderToolCalls = (toolCalls?: ChatMessage['tool_calls']) => {
    if (!toolCalls?.length) return null;
    return (
      <div className={styles.toolCalls}>
        <div className={styles.toolCallsHeader}>
          <ToolOutlined style={{ marginRight: 4 }} />
          <Text strong>工具调用</Text>
        </div>
        <Collapse ghost className={styles.toolCallCollapse}>
          {toolCalls.map((toolCall, idx) => {
            const cleanedArgs = { ...toolCall.arguments };
            delete (cleanedArgs as any)._raw;
            const argsStr = Object.keys(cleanedArgs).length === 0
              ? '(无参数)'
              : JSON.stringify(cleanedArgs, null, 2);
            return (
              <Panel
                key={`${toolCall.name}_${idx}`}
                header={<Tag color="blue">{toolCall.name}</Tag>}
              >
                <pre className={styles.toolCallPre}>{argsStr}</pre>
              </Panel>
            );
          })}
        </Collapse>
      </div>
    );
  };

  const renderComputerUseTaskMessage = (trace?: ComputerUseTaskTraceState) => {
    if (!trace) return null;
    const statusMeta = getComputerUseStatusMeta(trace.status);
    const tableSummary = getLatestExtractedTablesFromSteps(trace.steps || []);
    const downloadResult = getLatestDownloadResultFromSteps(trace.steps || []);
    const lastEntry = trace.entries[trace.entries.length - 1];
    const lastObservation = trace.lastObservation || lastEntry?.observation;
    const lastActionEntry = [...trace.entries].reverse().find((entry) => entry.action);
    const lastVerificationEntry = [...trace.entries].reverse().find((entry) => entry.verification);
    const navigationPath = [...trace.entries].reverse().find((entry) => entry.navigationPath?.length)?.navigationPath;
    const lastChosenElement = lastActionEntry?.chosenElement;
    const isActiveTask = computerUseRunId === trace.runId && ['running', 'waiting_confirmation'].includes(trace.status);
    const emptyFinished = trace.status === 'finished' && (!trace.entries.length || !trace.steps?.length) && !tableSummary;

    return (
      <div className={styles.computerUseTask}>
        <div className={styles.computerUseHeader}>
          <Space size={6} wrap>
            <ToolOutlined />
            <Text strong>自动操作任务</Text>
            <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
          </Space>
          <Space size={4} wrap>
            {isActiveTask && (
              <Button size="small" danger icon={<StopOutlined />} onClick={handleStopGeneration}>
                停止
              </Button>
            )}
            <Button size="small" icon={<CopyOutlined />} onClick={() => copyComputerUseTrace(trace)}>
              复制日志
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => retryComputerUse(trace)}>
              重试
            </Button>
          </Space>
        </div>

        <div className={styles.computerUseGoal}>{trace.goal}</div>

        <div className={styles.computerUseSummary}>
          <Space size={[6, 6]} wrap>
            <Tag>{trace.currentStep || '准备中'}</Tag>
            {trace.summary && <Tag color="blue">{trace.summary}</Tag>}
            {typeof (lastEntry?.result as any)?.navigationCount === 'number' && (
              <Tag>导航 {(lastEntry?.result as any).navigationCount}</Tag>
            )}
            {typeof (lastEntry?.result as any)?.tableCount === 'number' && (
              <Tag>表格 {(lastEntry?.result as any).tableCount}</Tag>
            )}
            {navigationPath?.length && <Tag color="purple">路径 {navigationPath.join(' > ')}</Tag>}
          </Space>
          {trace.error && <div className={styles.computerUseError}>{trace.error}</div>}
          {emptyFinished && (
            <div className={styles.computerUseError}>未拿到实际执行步骤或可交付结果，请补充目标页面位置后重试。</div>
          )}
        </div>

        {lastObservation && (
          <div className={styles.computerUseMeta}>
            {lastObservation.title && <div>页面：{lastObservation.title}</div>}
            {lastObservation.url && <div>URL：{lastObservation.url}</div>}
            {lastActionEntry?.action && (
              <div>最后动作：{getComputerUseActionLabel(lastActionEntry.action)}</div>
            )}
            {lastChosenElement && (
              <div>目标元素：{lastChosenElement.text || lastChosenElement.selector || lastChosenElement.elementId}</div>
            )}
            {lastVerificationEntry?.verification && (
              <div>
                校验：{lastVerificationEntry.verification.success ? '通过' : '失败'}
                {lastVerificationEntry.verification.reason ? `，${lastVerificationEntry.verification.reason}` : ''}
                {lastVerificationEntry.verification.warning ? `，${lastVerificationEntry.verification.warning}` : ''}
              </div>
            )}
          </div>
        )}

        {tableSummary && (
          <div className={styles.computerUseTablePreview}>
            <Text strong>已提取列表数据：{tableSummary.tableCount} 个表格，共 {tableSummary.rowCount} 行</Text>
            {tableSummary.tables.slice(0, 2).map((table, tableIndex) => (
              <div key={`${table.title || 'table'}_${tableIndex}`} className={styles.computerUseTableBlock}>
                <div className={styles.computerUseTableTitle}>
                  {table.title || `表格 ${tableIndex + 1}`}（{table.rowCount || table.rows.length} 行，{table.columnCount || table.headers.length} 列）
                </div>
                {!!table.headers.length && (
                  <div className={styles.computerUseTableFields}>字段：{table.headers.slice(0, 8).join('、')}</div>
                )}
                {table.rows.slice(0, 3).map((row, rowIndex) => (
                  <div key={rowIndex} className={styles.computerUseTableRow}>
                    {row.slice(0, 6).join(' | ')}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {downloadResult && (
          <div className={styles.computerUseTablePreview}>
            <Text strong>
              {downloadResult.savedToDocumentCenter
                ? '已保存导出文件'
                : '已触发下载'}
            </Text>
            <div className={styles.computerUseTableBlock}>
              <div className={styles.computerUseTableTitle}>
                文件：{downloadResult.filename || downloadResult.assetTitle || '下载文件'}
              </div>
              <div className={styles.computerUseTableFields}>
                {downloadResult.size ? `大小：${downloadResult.size} bytes` : '大小：未知'}
                {downloadResult.mimeType ? `，类型：${downloadResult.mimeType}` : ''}
              </div>
              {downloadResult.assetId && (
                <div className={styles.computerUseTableRow}>资料 ID：{downloadResult.assetId}</div>
              )}
              {downloadResult.localParseStatus && (
                <div className={styles.computerUseTableRow}>解析状态：{downloadResult.localParseStatus}</div>
              )}
              {downloadResult.needsManualImport && (
                <div className={styles.computerUseError}>已下载，但浏览器限制导致无法自动读取文件内容，请从下载目录手动添加。</div>
              )}
            </div>
          </div>
        )}

        <Collapse ghost className={styles.computerUseCollapse}>
          <Panel header={`执行日志（${trace.entries.length}）`} key="trace">
            {trace.entries.length ? (
              <Timeline className={styles.computerUseTimeline}>
                {trace.entries.map((entry, entryIndex) => (
                  <Timeline.Item
                    key={`${entry.timestamp}_${entryIndex}`}
                    color={entry.error ? 'red' : entry.state === 'done' ? 'green' : entry.state === 'waiting_confirmation' ? 'orange' : 'blue'}
                  >
                    <div className={styles.traceEntryTitle}>{getComputerUseStateLabel(entry.state)}</div>
                    <div className={styles.traceEntryText}>{summarizeComputerUseEntry(entry)}</div>
                    {(entry.observation?.title || entry.observation?.url) && (
                      <div className={styles.traceEntryMeta}>
                        {entry.observation?.title || entry.observation?.url}
                      </div>
                    )}
                  </Timeline.Item>
                ))}
              </Timeline>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行日志" />
            )}
          </Panel>
        </Collapse>
      </div>
    );
  };

  const hasUploadingFiles = attachedFiles.some(file => file.nativeUploadStatus === 'uploading');

  return (
    <div className={styles.chatContainer}>
     
      <div className={styles.backgroundDecoration} />

     
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.iconWrapper}>
            <ThunderboltOutlined style={{ color: '#fff', fontSize: '22px' }} />
          </div>
          <div className={styles.headerInfo}>
            <Title level={5} className={styles.headerTitle}>
              AI 智能助手
            </Title>
          </div>
        </div>
        <Space size={4}>
          <Tooltip title="会话历史">
            <Button
              type="text"
              icon={<HistoryOutlined style={{ fontSize: '18px' }} />}
              onClick={() => setSessionsVisible(true)}
            />
          </Tooltip>
          <Tooltip title="新对话">
            <Button
              type="text"
              icon={<PlusOutlined style={{ fontSize: '18px' }} />}
              onClick={createNewChatSession}
            />
          </Tooltip>
          <Button
            type="text"
            icon={<AppstoreOutlined style={{ fontSize: '18px' }} />}
            onClick={() => setToolsVisible(true)}
            style={{ marginRight: -8 }}
          />
        </Space>
      </div>

     
      <div ref={messagesContainerRef} className={styles.messagesContainer} onScroll={handleMessagesScroll}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIconWrapper}>
              <RobotOutlined style={{ fontSize: '48px', color: '#fff' }} />
            </div>
            <Title level={4} className={styles.emptyTitle}>
              开始对话
            </Title>
            <Text className={styles.emptyText}>
                开始与 AI 智能助手对话吧~
            </Text>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => {
              if (msg.kind === 'computer_use_task') {
                return (
                  <div
                    key={msg.id}
                    className={`${styles.messageItem} ${styles.messageItemLeft}`}
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <div className={`${styles.messageContent} ${styles.messageContentLeft}`}>
                      <Avatar
                        size={36}
                        icon={<RobotOutlined />}
                        className={`${styles.avatar} ${styles.avatarBot}`}
                      />
                      <div className={`${styles.messageBubble} ${styles.messageBubbleBot} ${styles.computerUseBubble}`}>
                        {renderComputerUseTaskMessage(msg.computerUseTrace)}
                        <div className={styles.messageTime}>
                          {moment(msg.timestamp).format('HH:mm')}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              if (msg.kind === 'ocr_result') {
                return (
                  <div
                    key={msg.id}
                    className={`${styles.messageItem} ${styles.messageItemLeft}`}
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <div className={`${styles.messageContent} ${styles.messageContentLeft} ${styles.structuredMessageContent}`}>
                      <Avatar
                        size={36}
                        icon={<RobotOutlined />}
                        className={`${styles.avatar} ${styles.avatarBot}`}
                      />
                      <div className={`${styles.messageBubble} ${styles.messageBubbleBot} ${styles.structuredBubble}`}>
                        {renderOcrResultMessage(msg.ocrResult)}
                        <div className={styles.messageTime}>
                          {moment(msg.timestamp).format('HH:mm')}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              if (msg.kind === 'document_qa_result' && msg.documentQaResult) {
                return (
                  <div key={msg.id} className={`${styles.messageItem} ${styles.messageItemLeft}`}>
                    <div className={`${styles.messageContent} ${styles.messageContentLeft} ${styles.structuredMessageContent}`}>
                      <Avatar size={36} icon={<RobotOutlined />} className={`${styles.avatar} ${styles.avatarBot}`} />
                      <Card size="small" title="资料回答" className={styles.structuredBubble}>
                        <MarkdownMessage content={msg.documentQaResult.answer} />
                        {msg.documentQaResult.sources.length > 0 && (
                          <List size="small" header={<Text strong>引用来源</Text>} dataSource={msg.documentQaResult.sources} renderItem={(source) => (
                            <List.Item actions={[<Button key="open" type="link" size="small" onClick={() => { setDocumentReference(source); setToolsInitialTool('documents'); setToolsVisible(true); }}>定位</Button>]}>
                              <Space direction="vertical" size={0}>
                                <Text>{source.documentTitle || source.fileName || source.documentId}</Text>
                                <Text type="secondary">{[source.pageNumber ? `第 ${source.pageNumber} 页` : '', source.sectionTitle, source.chunkId].filter(Boolean).join(' · ')}</Text>
                              </Space>
                            </List.Item>
                          )} />
                        )}
                      </Card>
                    </div>
                  </div>
                );
              }

              // 解析消息中的文件链接
              const imageRegex = /\[图片: ([^\]]+)\]\(([^)]+)\)/g;
              const fileRegex = /\[文件: ([^\]]+)\]/g;
              const imageNameOnlyRegex = /\[图片: ([^\]]+)\]/g;
              const images: Array<{ name: string; url: string }> = [];
              const files: Array<{ name: string }> = [];
              
              let match;
              while ((match = imageRegex.exec(msg.content)) !== null) {
                images.push({ name: match[1], url: match[2] });
              }
              const contentWithoutLinkedImages = msg.content.replace(/\[图片: [^\]]+\]\([^)]+\)/g, '');
              while ((match = imageNameOnlyRegex.exec(contentWithoutLinkedImages)) !== null) {
                files.push({ name: match[1] });
              }
              while ((match = fileRegex.exec(msg.content)) !== null) {
                files.push({ name: match[1] });
              }
              
              // 移除文件标记，只显示纯文本
              const textContent = msg.content
                .replace(/\[图片: [^\]]+\]\([^)]+\)/g, '')
                .replace(/\[图片: [^\]]+\]/g, '')
                .replace(/\[文件: [^\]]+\]/g, '')
                .trim();

              return (
                <div
                  key={msg.id}
                  className={`${styles.messageItem} ${msg.type === 'assistant' ? styles.messageItemLeft : ''}`}
                  style={{ animationDelay: `${index * 0.05}s` }}
                >
                  <div className={`${styles.messageContent} ${msg.type === 'assistant' ? styles.messageContentLeft : ''}`}>
                    <Avatar
                      size={36}
                      icon={msg.type === 'user' ? <UserOutlined /> : <RobotOutlined />}
                      className={`${styles.avatar} ${msg.type === 'user' ? styles.avatarUser : styles.avatarBot}`}
                    />
                    <div className={`${styles.messageBubble} ${msg.type === 'user' ? styles.messageBubbleUser : styles.messageBubbleBot}`}>
                      {images.length > 0 && (
                        <div className={styles.messageImages}>
                          {images.map((img, idx) => (
                            <Image
                              key={idx}
                              src={img.url}
                              alt={img.name}
                              width={200}
                              preview={{
                                mask: img.name,
                              }}
                              className={styles.messageImage}
                            />
                          ))}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div className={styles.messageFiles}>
                          {files.map((file, idx) => (
                            <div key={idx} className={styles.messageFile}>
                              <PaperClipOutlined />
                              <Text className={styles.messageFileName}>{file.name}</Text>
                            </div>
                          ))}
                        </div>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <AttachmentMessageCard attachments={msg.attachments} />
                      )}
                      {textContent && (
                        <MarkdownMessage
                          content={textContent}
                          isUser={msg.type === 'user'}
                          onSave={msg.type === 'assistant' ? saveTextMessageToDocuments : undefined}
                        />
                      )}
                      {textContent && (
                        <Space size={6} className={styles.messageActions}>
                          <Button style={{ color: 'red' }} size="small" type="link" onClick={() => handleRememberMessage(msg)}>
                            记住这条
                          </Button>
                        </Space>
                      )}
                      {renderToolCalls(msg.tool_calls)}
                      <div className={styles.messageTime}>
                        {moment(msg.timestamp).format('HH:mm')}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {isTyping && (
              <div className={styles.typingIndicator}>
                <div className={styles.typingContent}>
                  <Avatar
                    size={36}
                    icon={<RobotOutlined />}
                    className={`${styles.avatar} ${styles.avatarBot}`}
                  />
                  <div className={styles.typingBubble}>
                    <Spin size="small" />
                    <Text className={styles.typingText}>正在输入...</Text>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      
      <div className={styles.inputArea}>
        <div className={styles.quickActions}>
          {getQuickCommands().map((command) => (
            <Tooltip key={command.id} title={command.description}>
              <Button size="small" onClick={() => handleCopilotCommand(command.id)}>
                {command.title}
              </Button>
            </Tooltip>
          ))}
          <Dropdown
            onVisibleChange={(visible) => {
              if (visible) {
                refreshCommandContext();
                listCustomCommands().then(setCustomCommands).catch(() => setCustomCommands([]));
              }
            }}
            overlay={(
              <Menu onClick={({ key }) => {
                const value = String(key);
                if (value.startsWith('custom:')) handleCustomCommand(value.slice('custom:'.length));
                else handleCopilotCommand(value.replace(/^(recommended|all):/, '') as CopilotCommandId);
              }}>
                <Menu.ItemGroup title="推荐">
                  {COPILOT_COMMANDS.filter((command) => recommendedCommandIds.has(command.id)).map((command) => (
                    <Menu.Item key={`recommended:${command.id}`}>
                      <Space direction="vertical" size={0}>
                        <Text>{command.title}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{command.description}</Text>
                      </Space>
                    </Menu.Item>
                  ))}
                </Menu.ItemGroup>
                <Menu.Divider />
                <Menu.ItemGroup title="全部命令">
                {COPILOT_COMMANDS.map((command) => (
                  <Menu.Item key={`all:${command.id}`}>
                    <Space direction="vertical" size={0}>
                      <Text>{command.title}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{command.description}</Text>
                    </Space>
                  </Menu.Item>
                ))}
                </Menu.ItemGroup>
                {customCommands.length > 0 && <>
                  <Menu.Divider />
                  <Menu.ItemGroup title="自定义命令">
                    {customCommands.map((command) => (
                      <Menu.Item key={`custom:${command.id}`}>
                        <Space direction="vertical" size={0}>
                          <Space><Text>{command.title}</Text>{command.riskLevel !== 'low' && <Tag color={command.riskLevel === 'high' ? 'red' : 'orange'}>{command.riskLevel}</Tag>}</Space>
                          <Text type="secondary" style={{ fontSize: 12 }}>{command.description || command.promptTemplate}</Text>
                        </Space>
                      </Menu.Item>
                    ))}
                  </Menu.ItemGroup>
                </>}
              </Menu>
            )}
            trigger={['click']}
          >
            <Button size="small" icon={<AppstoreOutlined />}>
              命令
            </Button>
          </Dropdown>
        </div>
        {attachedFiles.length > 0 && (
          <div className={styles.attachedFiles}>
            {attachedFiles.map(file => (
              <div key={file.uid} className={styles.attachedFileItem}>
                {file.type.startsWith('image/') && file.thumbUrl ? (
                  <div className={styles.attachedImage}>
                    <Image
                      src={file.thumbUrl}
                      alt={file.name}
                      width={60}
                      height={60}
                      preview={false}
                      className={styles.attachedImagePreview}
                      />
                      <div className={styles.attachedImageActions}>
                        <Tag color={file.ocrStatus === 'done' ? 'green' : file.ocrStatus === 'running' ? 'processing' : 'gold'}>
                          {file.ocrStatus === 'running' ? `OCR中${file.ocrProgress ? ` ${file.ocrProgress}%` : ''}` : file.ocrStatus === 'done' ? 'OCR完成' : file.ocrStatus === 'partial' ? '无文字' : '可OCR'}
                        </Tag>
                        <Dropdown
                          overlay={(
                            <Menu>
                              <Menu.Item key="ask" onClick={() => handleAskFile(file, 'ask')}>问这个文件</Menu.Item>
                              <Menu.Item
                                key="view-ocr"
                                disabled={file.ocrStatus !== 'done'}
                                onClick={() => handleViewOcrText(file)}
                              >
                                查看 OCR 文本
                              </Menu.Item>
                              <Menu.Item
                                key="ocr"
                                disabled={!['pending', 'partial', 'error'].includes(file.ocrStatus)}
                                onClick={() => handleRunOcr(file)}
                              >
                                执行 OCR
                              </Menu.Item>
                              <Menu.Item key="delete" danger onClick={() => handleRemoveFile(file.uid)}>删除</Menu.Item>
                            </Menu>
                          )}
                          trigger={['click']}
                        >
                          <Button
                            type="text"
                            icon={<MoreOutlined />}
                            className={styles.removeFileButton}
                            size="small"
                          />
                        </Dropdown>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.attachedFile}>
                      <PaperClipOutlined />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Text className={styles.attachedFileName} ellipsis>
                          {file.name}
                        </Text>
                        <div className={styles.attachedFileMeta}>
                          <Tag
                            color={
                              file.nativeUploadStatus === 'uploading'
                                ? 'gold'
                                : file.nativeUploadStatus === 'uploaded'
                                  ? 'purple'
                                  : file.nativeUploadStatus === 'error'
                                    ? 'red'
                                    : 'default'
                            }
                          >
                            {file.nativeUploadStatus === 'uploading'
                              ? '模型上传中'
                              : file.nativeUploadStatus === 'uploaded'
                                ? '模型已接收'
                                : file.nativeUploadStatus === 'error'
                                  ? '模型上传失败'
                                  : '本地解析'}
                          </Tag>
                          <Tag
                            color={
                              file.parseStatus === 'parsed' ? 'green'
                                : file.parseStatus === 'partial' ? 'gold'
                                  : file.parseStatus === 'error' ? 'red'
                                    : 'default'
                            }
                          >
                            {file.parseStatus === 'parsed' ? '已解析'
                              : file.parseStatus === 'partial' ? '部分解析'
                                : file.parseStatus === 'error' ? '解析失败'
                                  : '不支持'}
                          </Tag>
                          <Tag
                            color={
                              file.ocrStatus === 'done' ? 'green'
                                : file.ocrStatus === 'running' ? 'processing'
                                  : ['pending', 'partial'].includes(file.ocrStatus) ? 'gold'
                                    : file.ocrStatus === 'error' ? 'red'
                                      : 'default'
                            }
                          >
                            {file.ocrStatus === 'done' ? 'OCR完成'
                              : file.ocrStatus === 'running' ? `OCR中${file.ocrProgress ? ` ${file.ocrProgress}%` : ''}`
                                : file.ocrStatus === 'partial' ? '未识别文字'
                                : file.ocrStatus === 'pending' ? '可OCR'
                                  : file.ocrStatus === 'error' ? 'OCR失败'
                                    : '无需OCR'}
                          </Tag>
                        </div>
                      </div>
                      <Dropdown
                        overlay={(
                          <Menu>
                            <Menu.Item key="ask" onClick={() => handleAskFile(file, 'ask')}>问这个文件</Menu.Item>
                            <Menu.Item key="summary" onClick={() => handleAskFile(file, 'summary')}>总结文件</Menu.Item>
                            <Menu.Item key="tasks" onClick={() => handleAskFile(file, 'tasks')}>生成任务清单</Menu.Item>
                            <Menu.Item key="compare" onClick={() => handleAskFile(file, 'compare')}>对比资料</Menu.Item>
                            <Menu.Item
                              key="view-ocr"
                              disabled={file.ocrStatus !== 'done'}
                              onClick={() => handleViewOcrText(file)}
                            >
                              查看 OCR 文本
                            </Menu.Item>
                            <Menu.Item
                              key="ocr"
                              disabled={!['pending', 'partial', 'error'].includes(file.ocrStatus)}
                              onClick={() => handleRunOcr(file)}
                            >
                              执行 OCR
                            </Menu.Item>
                            <Menu.Item key="delete" danger onClick={() => handleRemoveFile(file.uid)}>删除</Menu.Item>
                          </Menu>
                        )}
                        trigger={['click']}
                      >
                        <Button
                          type="text"
                          icon={<MoreOutlined />}
                          className={styles.removeFileButton}
                          size="small"
                        />
                      </Dropdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={styles.inputWrapper}>
            <Button
              type="text"
              icon={<PaperClipOutlined />}
              onClick={() => fileInputRef.current?.click()}
              className={styles.attachButton}
              title="添加文件"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                files.forEach(file => handleFileChange(file));
                e.target.value = ''; // 重置input，允许重复选择同一文件
              }}
            />
            <TextArea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
  
                const files: File[] = [];
                
                // 遍历剪贴板中的所有项目
                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  
                  // 如果是文件类型
                  if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) {
                      files.push(file);
                    }
                  }
                }
  
                // 如果有文件，添加到附件列表并阻止默认粘贴行为
                if (files.length > 0) {
                  e.preventDefault();
                  e.stopPropagation(); // 阻止事件冒泡，防止重复处理
                  files.forEach(file => {
                    handleFileChange(file);
                  });
                }
                // 如果没有文件，允许正常的文本粘贴
              }}
              placeholder="输入消息或粘贴文件..."
              autoSize={{ minRows: 1, maxRows: 4 }}
              className={styles.textArea}
              bordered={false}
            />
            <Button
              type="primary"
              danger={isTyping}
              icon={isTyping ? <StopOutlined /> : <SendOutlined />}
              onClick={isTyping ? handleStopGeneration : handleSend}
              className={styles.sendButton}
              shape="circle"
              disabled={!isTyping && (hasUploadingFiles || (!inputValue.trim() && attachedFiles.length === 0))}
            />
          </div>
        </div>

        <Drawer
          title="工具箱"
          placement="right"
          onClose={() => setToolsVisible(false)}
          visible={toolsVisible}
          width="100%"
          bodyStyle={{ padding: 0 }}
          headerStyle={{ padding: '16px 20px' }}
        >
          <Tools initialTool={toolsInitialTool} documentReference={documentReference} />
        </Drawer>
        <Drawer
          title="会话历史"
          placement="right"
          onClose={() => setSessionsVisible(false)}
          visible={sessionsVisible}
          width="100%"
          bodyStyle={{ padding: 12 }}
          headerStyle={{ padding: '16px 20px' }}
          extra={<Button size="small" icon={<PlusOutlined />} onClick={createNewChatSession}>新对话</Button>}
        >
          <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
            <Input.Search
              allowClear
              placeholder="搜索会话..."
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
            />
            <Button size="small" type={showArchivedSessions ? 'primary' : 'default'} onClick={() => setShowArchivedSessions((value) => !value)}>
              {showArchivedSessions ? '隐藏已归档' : '查看已归档'}
            </Button>
          </Space>
          <List
            dataSource={chatSessions}
            locale={{ emptyText: <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            renderItem={(session) => (
              <List.Item
                actions={[
                  <Tooltip key="rename" title="重命名">
                    <Button size="small" icon={<EditOutlined />} onClick={(event) => {
                      event.stopPropagation();
                      let nextTitle = session.title;
                      Modal.confirm({
                        title: '重命名会话',
                        content: <Input defaultValue={session.title} onChange={(e) => { nextTitle = e.target.value; }} />,
                        onOk: async () => {
                          await updateChatSession(session.id, { title: nextTitle.trim() || session.title });
                          await refreshChatSessions();
                        },
                      });
                    }} />
                  </Tooltip>,
                  <Tooltip key="archive" title={session.archived ? '取消归档' : '归档'}>
                    <Button size="small" icon={<InboxOutlined />} onClick={async (event) => {
                      event.stopPropagation();
                      await archiveChatSession(session.id, !session.archived);
                      await refreshChatSessions();
                    }} />
                  </Tooltip>,
                  <Tooltip key="delete" title="删除">
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={(event) => {
                      event.stopPropagation();
                      Modal.confirm({
                        title: '删除会话',
                        content: `确认删除「${session.title}」及其中的聊天记录？长期记忆不会被删除。`,
                        okButtonProps: { danger: true },
                        onOk: async () => {
                          await deleteChatSession(session.id);
                          if (session.id === currentSessionId) await createNewChatSession();
                          await refreshChatSessions();
                        },
                      });
                    }} />
                  </Tooltip>,
                ]}
              >
                <Card
                  size="small"
                  hoverable
                  style={{
                    width: '100%',
                    borderColor: session.id === currentSessionId ? '#6366f1' : undefined,
                  }}
                  onClick={() => loadChatSession(session.id)}
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Text strong ellipsis>{session.title}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {session.messageCount} 条消息 · {moment(session.updatedAt).fromNow()}
                    </Text>
                    {session.archived && <Tag>已归档</Tag>}
                    {session.summary && <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{session.summary}</Text>}
                  </Space>
                </Card>
              </List.Item>
            )}
          />
        </Drawer>
        <Modal
          title={ocrViewer ? `OCR 文本 - ${ocrViewer.fileName}` : 'OCR 文本'}
          visible={Boolean(ocrViewer)}
          onCancel={() => setOcrViewer(null)}
          width={720}
          footer={[
            <Button key="copy" icon={<CopyOutlined />} onClick={() => {
              if (!ocrViewer) return;
              navigator.clipboard?.writeText(ocrViewer.text);
              message.success('OCR 文本已复制');
            }}>
              复制
            </Button>,
            <Button key="analyze" type="primary" onClick={() => ocrViewer && sendOcrTextToAI(ocrViewer)}>
              发送给 AI 分析
            </Button>,
          ]}
        >
          <Text type="secondary">资料 ID：{ocrViewer?.documentId}</Text>
          <Tabs defaultActiveKey={ocrViewer?.structuredOcr ? 'structured' : 'raw'} style={{ marginTop: 12 }}>
            <TabPane tab="结构化结果" key="structured">
              {renderStructuredOcr(ocrViewer?.structuredOcr)}
            </TabPane>
            <TabPane tab="原始 OCR" key="raw">
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', marginTop: 0, fontSize: 12 }}>
                {ocrViewer?.text}
              </pre>
            </TabPane>
          </Tabs>
        </Modal>
    </div>
  );
};

export default Chat;
