export type PageContextAction = 'ask' | 'explain' | 'summarize' | 'extract_points' | 'add_to_topic';

export interface PageSelectionContext {
  text: string;
  prefix: string;
  suffix: string;
  headingPath: string[];
  pageTitle: string;
  url: string;
  selector?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PageContextActionMessage {
  type: 'PAGE_CONTEXT_ACTION';
  action: PageContextAction;
  question?: string;
  context: PageSelectionContext;
}

export interface PageContextActionReceivedMessage extends Omit<PageContextActionMessage, 'type'> {
  type: 'PAGE_CONTEXT_ACTION_RECEIVED';
  receivedAt: number;
}

export const PENDING_PAGE_CONTEXT_ACTION_KEY = 'pending_page_context_action';

export function isPageContextAction(value: unknown): value is PageContextAction {
  return ['ask', 'explain', 'summarize', 'extract_points', 'add_to_topic'].includes(String(value));
}

export function isValidPageSelectionContext(value: unknown): value is PageSelectionContext {
  const context = value as PageSelectionContext | null;
  return Boolean(
    context
    && typeof context.text === 'string'
    && context.text.trim()
    && typeof context.pageTitle === 'string'
    && typeof context.url === 'string'
    && context.rect
    && Number.isFinite(context.rect.x)
    && Number.isFinite(context.rect.y),
  );
}

export function normalizePageContextActionMessage(value: unknown): PageContextActionMessage | null {
  const message = value as PageContextActionMessage | null;
  if (
    !message
    || message.type !== 'PAGE_CONTEXT_ACTION'
    || !isPageContextAction(message.action)
    || !isValidPageSelectionContext(message.context)
  ) {
    return null;
  }
  const question = String(message.question || '').trim();
  if (message.action === 'ask' && !question) return null;

  return {
    type: 'PAGE_CONTEXT_ACTION',
    action: message.action,
    question: question || undefined,
    context: {
      ...message.context,
      text: message.context.text.trim().slice(0, 12_000),
      prefix: String(message.context.prefix || '').slice(-240),
      suffix: String(message.context.suffix || '').slice(0, 240),
      headingPath: Array.isArray(message.context.headingPath)
        ? message.context.headingPath.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
        : [],
    },
  };
}
