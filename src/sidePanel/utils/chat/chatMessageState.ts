export type ChatDeliveryState = 'streaming' | 'tool' | 'final';

export type RenderableChatMessage = {
  id?: string;
  content?: string;
  kind?: string;
  attachments?: unknown[];
  tool_calls?: unknown[];
  computerUseTrace?: unknown;
  ocrResult?: unknown;
  documentQaResult?: unknown;
  delivery?: ChatDeliveryState;
};

export function hasRenderableChatMessage(message: RenderableChatMessage | null | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string' && message.content.trim().length > 0) return true;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.kind === 'browser_use_task' && message.computerUseTrace) return true;
  if (message.kind === 'ocr_result' && message.ocrResult) return true;
  if (message.kind === 'document_qa_result' && message.documentQaResult) return true;
  return false;
}

export function mergeIncomingChatMessage<T extends RenderableChatMessage>(
  messages: T[],
  incoming: RenderableChatMessage,
): T[] {
  const existingIndex = messages.findIndex((message) => message.id === incoming.id);
  if (existingIndex < 0) return [...messages, incoming as T];

  const next = [...messages];
  next[existingIndex] = { ...messages[existingIndex], ...incoming } as T;
  return next;
}

export function shouldPersistIncomingChatMessage(message: RenderableChatMessage): boolean {
  return message.delivery !== 'streaming' && hasRenderableChatMessage(message);
}
