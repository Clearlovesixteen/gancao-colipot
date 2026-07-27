import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  createChatSession,
  getChatSessionMessages,
  listChatSessions,
  saveChatMessage,
  suggestMemoryCandidatesFromMessage,
  type ChatSession,
  type StoredChatMessage,
} from '../../../shared/userMemoryStore';
import { hasRenderableChatMessage } from '../../utils/chatMessageState';
import type { ChatMessage } from './types';

export function useChatSessions(options: {
  messagesEndRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
}) {
  const { messagesEndRef, shouldAutoScrollRef } = options;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [sessionLoadError, setSessionLoadError] = useState('');
  const [sessionsVisible, setSessionsVisible] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

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
    attachments: msg.attachments?.map((item) => ({ id: item.id, name: item.name, type: item.type, size: item.size })),
    toolCalls: msg.tool_calls?.map((tool) => ({ name: tool.name, arguments: tool.arguments })),
    computerUseRunId: msg.computerUseTrace?.runId,
    timestamp: msg.timestamp || Date.now(),
  }), []);

  const persistChatMessage = useCallback((msg: ChatMessage) => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId || !msg?.id || !hasRenderableChatMessage(msg)) return;
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
    setIsSessionLoading(true);
    setSessionLoadError('');
    try {
      const storedMessages = await getChatSessionMessages(sessionId);
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;
      setMessages(storedMessages.map(toChatMessage).filter(hasRenderableChatMessage));
      setSessionsVisible(false);
      shouldAutoScrollRef.current = true;
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 0);
    } catch (error) {
      setSessionLoadError('会话恢复失败，请稍后重试');
      throw error;
    } finally {
      setIsSessionLoading(false);
    }
  }, [messagesEndRef, shouldAutoScrollRef, toChatMessage]);

  const createNewChatSession = useCallback(async () => {
    const session = await createChatSession();
    await refreshChatSessions();
    setCurrentSessionId(session.id);
    currentSessionIdRef.current = session.id;
    setMessages([]);
    setIsSessionLoading(false);
    setSessionLoadError('');
    setSessionsVisible(false);
  }, [refreshChatSessions]);

  useEffect(() => {
    let cancelled = false;
    setIsSessionLoading(true);
    setSessionLoadError('');
    (async () => {
      const sessions = await listChatSessions();
      const session = sessions[0] || await createChatSession();
      const storedMessages = await getChatSessionMessages(session.id);
      if (cancelled) return;
      setChatSessions(sessions[0] ? sessions : [session]);
      setCurrentSessionId(session.id);
      currentSessionIdRef.current = session.id;
      setMessages(storedMessages.map(toChatMessage).filter(hasRenderableChatMessage));
    })().catch((error) => {
      if (!cancelled) setSessionLoadError('会话恢复失败，请新建会话或重试');
      console.warn('[ChatMemory] 初始化会话失败:', error);
    }).finally(() => {
      if (!cancelled) setIsSessionLoading(false);
    });
    return () => { cancelled = true; };
  }, [toChatMessage]);

  return {
    messages,
    setMessages,
    isSessionLoading,
    sessionLoadError,
    sessionsVisible,
    setSessionsVisible,
    chatSessions,
    sessionQuery,
    setSessionQuery,
    showArchivedSessions,
    setShowArchivedSessions,
    currentSessionId,
    currentSessionIdRef,
    refreshChatSessions,
    persistChatMessage,
    loadChatSession,
    createNewChatSession,
  };
}

