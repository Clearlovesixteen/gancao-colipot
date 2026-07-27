import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { buildMemoryContext } from '../../../shared/userMemoryStore';
import { RUNTIME_BUILD_ID } from '../../../shared/runtimeVersion';
import {
  getActiveBrowserTabId,
  shouldStopTypingForGatewayStatus,
  type GatewayConnectionStatus,
} from '../../utils/chatRequestState';
import {
  hasRenderableChatMessage,
  mergeIncomingChatMessage,
  shouldPersistIncomingChatMessage,
} from '../../utils/chatMessageState';
import type { ChatMessage } from './types';

function createAiRequestId(): string {
  return `ai_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useAiRequest(options: {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  persistChatMessage: (message: ChatMessage) => void;
  currentSessionIdRef: MutableRefObject<string | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  addAssistantMessage: (content: string) => void;
  handleUnauthenticated: () => Promise<void>;
  normalizeError: (error: unknown, fallback?: string) => string;
}) {
  const {
    messages,
    setMessages,
    persistChatMessage,
    currentSessionIdRef,
    shouldAutoScrollRef,
    addAssistantMessage,
    handleUnauthenticated,
    normalizeError,
  } = options;
  const [connectionStatus, setConnectionStatus] = useState<GatewayConnectionStatus>('disconnected');
  const [isTyping, setIsTyping] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const stoppedRequestIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS', clientBuildId: RUNTIME_BUILD_ID }, (response) => {
      if (response?.status) setConnectionStatus(response.status);
    });
  }, []);

  const sendUserMessage = useCallback((
    inputMessage: ChatMessage,
    modelProfileId?: string,
  ) => {
    const requestId = inputMessage.requestId || createAiRequestId();
    const userMessage = { ...inputMessage, requestId };
    activeRequestIdRef.current = requestId;
    stoppedRequestIdsRef.current.delete(requestId);
    shouldAutoScrollRef.current = true;

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    persistChatMessage(userMessage);
    setIsTyping(true);

    const messageHistory = updatedMessages
      .filter((item) => (item.type === 'user' || item.type === 'assistant') && item.kind !== 'browser_use_task')
      .map((item) => ({
        role: item.type === 'user' ? 'user' : 'assistant',
        content: item.llmContent || item.content,
        nativeFiles: item.nativeFiles,
      }));

    Promise.all([
      buildMemoryContext(userMessage.llmContent || userMessage.content || '', currentSessionIdRef.current || undefined),
      getActiveBrowserTabId(),
    ])
      .then(([memoryContext, contextTabId]) => {
        chrome.runtime.sendMessage({
          type: 'SEND_MESSAGE',
          clientBuildId: RUNTIME_BUILD_ID,
          requestId,
          messageHistory,
          memoryContext: memoryContext.contextText,
          modelProfileId,
          contextTabId,
        }, async (response) => {
          const runtimeError = chrome.runtime.lastError?.message;
          if (activeRequestIdRef.current !== requestId) return;
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
            addAssistantMessage(`AI 请求失败：${normalizeError(response?.error || runtimeError)}`);
            return;
          }
          setIsTyping(false);
        });
      })
      .catch((error) => {
        if (activeRequestIdRef.current !== requestId) return;
        setIsTyping(false);
        addAssistantMessage(`AI 请求失败：${normalizeError(error)}`);
      });
  }, [
    addAssistantMessage,
    currentSessionIdRef,
    handleUnauthenticated,
    messages,
    normalizeError,
    persistChatMessage,
    setMessages,
    shouldAutoScrollRef,
  ]);

  const sendPrompt = useCallback((
    content: string,
    llmContent = content,
    modelProfileId?: string,
  ) => {
    sendUserMessage({
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      llmContent,
      type: 'user',
      timestamp: Date.now(),
    }, modelProfileId);
  }, [sendUserMessage]);

  const handleRuntimeMessage = useCallback((message: any): boolean => {
    if (message.type === 'SSE_MESSAGE') {
      const incoming = message.message as ChatMessage;
      if (
        incoming?.requestId
        && (stoppedRequestIdsRef.current.has(incoming.requestId) || activeRequestIdRef.current !== incoming.requestId)
      ) {
        return true;
      }
      if (!hasRenderableChatMessage(incoming)) return true;
      setIsTyping(incoming.delivery !== 'final');
      if (shouldPersistIncomingChatMessage(incoming)) persistChatMessage(incoming);
      setMessages((current) => mergeIncomingChatMessage(current, incoming));
      return true;
    }
    if (message.type === 'SSE_STATUS_CHANGE') {
      setConnectionStatus(message.status);
      if (shouldStopTypingForGatewayStatus(message.status)) setIsTyping(false);
      return true;
    }
    return false;
  }, [persistChatMessage, setMessages]);

  const stop = useCallback(async (): Promise<void> => {
    const requestId = activeRequestIdRef.current;
    if (requestId) {
      stoppedRequestIdsRef.current.add(requestId);
      activeRequestIdRef.current = null;
    }
    setIsTyping(false);
    const response = await chrome.runtime.sendMessage({ type: 'STOP_AI_MESSAGE' });
    if (response?.success === false && !response?.cancelled) {
      throw new Error(response?.error || '停止生成失败');
    }
  }, []);

  return {
    connectionStatus,
    isTyping,
    setIsTyping,
    sendPrompt,
    sendUserMessage,
    handleRuntimeMessage,
    stop,
  };
}
