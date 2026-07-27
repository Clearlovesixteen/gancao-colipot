import { useEffect, type MutableRefObject } from 'react';
import { Modal } from 'antd';
import { getAutomationRun } from '../../../shared/automationRunStore';
import type {
  ChatMessage,
  FileAttachment,
  OcrResultMessageData,
} from './types';

function documentTitleFromOcrTask(title: string): string {
  return String(title || 'OCR 资料').replace(/^OCR[：:]\s*/, '') || 'OCR 资料';
}

export function useChatTaskEvents(options: {
  handleAiRuntimeMessage: (message: any) => boolean;
  browserUseTaskIdRef: MutableRefObject<string | null>;
  computerUseRunIdRef: MutableRefObject<string | null>;
  chatTaskIdsRef: MutableRefObject<Set<string>>;
  ocrTaskAssetsRef: MutableRefObject<Map<string, string>>;
  setBrowserUseTaskId: (taskId: string | null) => void;
  setComputerUseRunId: (runId: string | null) => void;
  setIsTyping: (isTyping: boolean) => void;
  setAttachedFiles: React.Dispatch<React.SetStateAction<FileAttachment[]>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInputValue: (value: string) => void;
  mergeBrowserUseEvent: (event: any) => void;
  fetchBrowserUseTrace: (runId: string) => void;
  persistChatMessage: (message: ChatMessage) => void;
  addAssistantMessage: (content: string) => void;
  addOcrResultMessage: (data: OcrResultMessageData) => void;
}) {
  const {
    handleAiRuntimeMessage,
    browserUseTaskIdRef,
    computerUseRunIdRef,
    chatTaskIdsRef,
    ocrTaskAssetsRef,
    setBrowserUseTaskId,
    setComputerUseRunId,
    setIsTyping,
    setAttachedFiles,
    setMessages,
    setInputValue,
    mergeBrowserUseEvent,
    fetchBrowserUseTrace,
    persistChatMessage,
    addAssistantMessage,
    addOcrResultMessage,
  } = options;

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_OPENED' }).catch(() => {});

    const messageListener = (runtimeMessage: any) => {
      if (handleAiRuntimeMessage(runtimeMessage)) return;

      if (runtimeMessage.type === 'COMPUTER_USE_PROGRESS') {
        if (!runtimeMessage.automationTaskId || runtimeMessage.automationTaskId !== browserUseTaskIdRef.current) return;
        if (!computerUseRunIdRef.current) {
          computerUseRunIdRef.current = runtimeMessage.runId;
          setComputerUseRunId(runtimeMessage.runId);
        }
        if (runtimeMessage.runId !== computerUseRunIdRef.current) return;
        mergeBrowserUseEvent(runtimeMessage);
        return;
      }

      if (runtimeMessage.type === 'AUTOMATION_TASK_PROGRESS') {
        const assetId = ocrTaskAssetsRef.current.get(runtimeMessage.taskId);
        if (assetId && runtimeMessage.kind === 'ocr') {
          const progress = Math.round(Number(runtimeMessage.data?.progress || 0) * 100);
          setAttachedFiles((files) => files.map((file) => (
            file.fileId === assetId ? { ...file, ocrStatus: 'running', ocrProgress: progress } : file
          )));
        }
        return;
      }

      if (runtimeMessage.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') {
        if (!runtimeMessage.automationTaskId || runtimeMessage.automationTaskId !== browserUseTaskIdRef.current) return;
        if (computerUseRunIdRef.current && runtimeMessage.runId !== computerUseRunIdRef.current) return;
        mergeBrowserUseEvent(runtimeMessage);
        Modal.confirm({
          title: '确认高风险自动操作',
          content: runtimeMessage.reason || runtimeMessage.action?.reason || '该动作可能修改页面数据，是否允许继续？',
          okText: '允许',
          cancelText: '拒绝',
          onOk: () => chrome.runtime.sendMessage({
            type: 'CONFIRM_COMPUTER_USE_ACTION',
            runId: runtimeMessage.runId,
            stepIndex: runtimeMessage.stepIndex,
            allowed: true,
          }),
          onCancel: () => chrome.runtime.sendMessage({
            type: 'CONFIRM_COMPUTER_USE_ACTION',
            runId: runtimeMessage.runId,
            stepIndex: runtimeMessage.stepIndex,
            allowed: false,
          }),
        });
        return;
      }

      if (runtimeMessage.type === 'AUTOMATION_TASK_FINISHED' || runtimeMessage.type === 'AUTOMATION_TASK_ERROR') {
        if (!chatTaskIdsRef.current.has(runtimeMessage.taskId)) return;
        chatTaskIdsRef.current.delete(runtimeMessage.taskId);
        const ocrAssetId = ocrTaskAssetsRef.current.get(runtimeMessage.taskId);
        ocrTaskAssetsRef.current.delete(runtimeMessage.taskId);

        getAutomationRun(runtimeMessage.taskId).then((run) => {
          if (!run) return;
          const output = (run.metadata as any)?.taskOutput;
          if (run.kind === 'browser_use') {
            if (browserUseTaskIdRef.current === run.id) {
              browserUseTaskIdRef.current = null;
              setBrowserUseTaskId(null);
            }
            setIsTyping(false);
            setComputerUseRunId(null);
            computerUseRunIdRef.current = null;
            const internalRunId = String(run.metadata?.computerUseRunId || '');
            if (internalRunId) fetchBrowserUseTrace(internalRunId);
            return;
          }

          if (runtimeMessage.type === 'AUTOMATION_TASK_ERROR') {
            if (ocrAssetId) {
              setAttachedFiles((files) => files.map((file) => (
                file.fileId === ocrAssetId
                  ? { ...file, ocrStatus: 'error', ocrProgress: undefined, parseError: run.error }
                  : file
              )));
            }
            addAssistantMessage(`${run.title}失败：${run.error || runtimeMessage.result?.error || '未知错误'}`);
            return;
          }

          if (run.kind === 'document_qa') {
            const qaMessage: ChatMessage = {
              id: `document_qa_${Date.now()}`,
              content: String(output?.answer || run.resultSummary || '任务已完成'),
              type: 'assistant',
              kind: 'document_qa_result',
              documentQaResult: {
                answer: String(output?.answer || run.resultSummary || '任务已完成'),
                sources: output?.sources || [],
              },
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
              fileName: documentTitleFromOcrTask(run.title),
              documentId: String(run.metadata?.assetId || ''),
              status: run.status === 'success' ? 'success' : result?.text ? 'low_confidence' : 'empty',
              pageCount: structuredOcr?.pageCount || result?.pages?.length || 0,
              fieldCount: structuredOcr?.fields?.length || 0,
              tableCount: structuredOcr?.tables?.length || 0,
              sectionCount: structuredOcr?.sections?.length || 0,
              previewFields: (structuredOcr?.fields || []).slice(0, 3).map((field: any) => ({
                key: field.key,
                value: field.value,
              })),
              warnings: structuredOcr?.warnings || result?.warnings || [],
              text: result?.text || '',
              structuredOcr,
            });
            if (ocrAssetId) {
              setAttachedFiles((files) => files.map((file) => (
                file.fileId === ocrAssetId
                  ? {
                    ...file,
                    ocrStatus: run.status === 'success' ? 'done' : 'partial',
                    ocrProgress: 100,
                    parseError: undefined,
                  }
                  : file
              )));
            }
          } else {
            addAssistantMessage(run.resultSummary || '任务已完成');
          }
        }).catch(() => {});
        return;
      }

      if (runtimeMessage.type === 'SELECTED_TEXT_RECEIVED' && runtimeMessage.text) {
        setInputValue(runtimeMessage.text);
        window.setTimeout(() => {
          const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
          if (textarea) {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          }
        }, 100);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [
    addAssistantMessage,
    addOcrResultMessage,
    browserUseTaskIdRef,
    chatTaskIdsRef,
    computerUseRunIdRef,
    fetchBrowserUseTrace,
    handleAiRuntimeMessage,
    mergeBrowserUseEvent,
    ocrTaskAssetsRef,
    persistChatMessage,
    setAttachedFiles,
    setBrowserUseTaskId,
    setComputerUseRunId,
    setInputValue,
    setIsTyping,
    setMessages,
  ]);
}
