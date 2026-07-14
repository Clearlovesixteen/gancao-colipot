export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  messageCount: number;
  tags?: string[];
  archived?: boolean;
};

export type StoredChatMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  kind?: string;
  attachments?: Array<{ id?: string; name: string; type?: string; size?: number }>;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  computerUseRunId?: string;
  timestamp: number;
};

export type UserMemoryType = 'preference' | 'workflow' | 'business_term' | 'project_context' | 'failure_pattern';

export type UserMemory = {
  id: string;
  type: UserMemoryType;
  title: string;
  content: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  confidence: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MemoryRecallLog = {
  id: string;
  query: string;
  memoryIds: string[];
  createdAt: number;
};

export type MemoryRecallResult = {
  memories: UserMemory[];
  sessionSummary?: string;
  contextText: string;
};

const DB_NAME = 'gancao_user_memory';
const DB_VERSION = 1;
const SESSIONS_STORE = 'chatSessions';
const MESSAGES_STORE = 'chatMessages';
const MEMORIES_STORE = 'userMemories';
const RECALL_LOGS_STORE = 'memoryRecallLogs';
const MEMORY_ENABLED_KEY = 'user_memory_enabled';
const DEFAULT_MEMORY_LIMIT = 8;
const DEFAULT_CONTEXT_LIMIT = 4000;

let dbPromise: Promise<IDBDatabase> | null = null;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const messages = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        messages.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(MEMORIES_STORE)) {
        const memories = db.createObjectStore(MEMORIES_STORE, { keyPath: 'id' });
        memories.createIndex('type', 'type', { unique: false });
        memories.createIndex('enabled', 'enabled', { unique: false });
      }
      if (!db.objectStoreNames.contains(RECALL_LOGS_STORE)) {
        db.createObjectStore(RECALL_LOGS_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开记忆库失败'));
  });

  return dbPromise;
}

function runStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  runner: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = runner(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error || new Error('记忆库操作失败'));
    }

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('记忆库事务失败'));
  }));
}

function runTransaction(
  storeNames: string[],
  mode: IDBTransactionMode,
  runner: (stores: Record<string, IDBObjectStore>) => void,
): Promise<void> {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = storeNames.reduce((acc, name) => {
      acc[name] = tx.objectStore(name);
      return acc;
    }, {} as Record<string, IDBObjectStore>);
    runner(stores);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('记忆库事务失败'));
  }));
}

function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return runStore<T[]>(storeName, 'readonly', (store) => store.getAll()).then((items) => items || []);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractKeywords(text: string): string[] {
  const words = Array.from(text.matchAll(/[\p{L}\p{N}_-]{2,}/gu))
    .map((match) => match[0].toLowerCase())
    .filter((word) => !/^\d+$/.test(word));
  return Array.from(new Set(words)).slice(0, 40);
}

function inferMemoryTitle(content: string): string {
  const normalized = normalizeText(content);
  return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized || '未命名记忆';
}

export function inferMemoryType(content: string): UserMemoryType {
  if (/不要|别再|希望|偏好|喜欢|习惯|我想|我需要|必须|应该/.test(content)) return 'preference';
  if (/流程|步骤|操作链路|工作流|自动操作|导出|下载/.test(content)) return 'workflow';
  if (/失败|报错|问题|卡住|原因|修复/.test(content)) return 'failure_pattern';
  if (/叫做|术语|字段|模块|菜单|系统/.test(content)) return 'business_term';
  return 'project_context';
}

export function isSensitiveMemoryContent(content: string): boolean {
  return /(sk-[A-Za-z0-9_-]{16,}|api[_-]?key|token|password|密码|身份证|银行卡|私钥|secret)/i.test(content);
}

export async function isMemoryEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get({ [MEMORY_ENABLED_KEY]: true });
  return result[MEMORY_ENABLED_KEY] !== false;
}

export async function setMemoryEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [MEMORY_ENABLED_KEY]: enabled });
}

export async function createChatSession(input: Partial<Pick<ChatSession, 'title' | 'summary' | 'tags'>> = {}): Promise<ChatSession> {
  const now = Date.now();
  const session: ChatSession = {
    id: makeId('session'),
    title: input.title?.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    summary: input.summary,
    messageCount: 0,
    tags: input.tags || [],
  };
  await runStore(SESSIONS_STORE, 'readwrite', (store) => store.put(session));
  return session;
}

export async function listChatSessions(options: { includeArchived?: boolean; query?: string } = {}): Promise<ChatSession[]> {
  const sessions = await getAllFromStore<ChatSession>(SESSIONS_STORE);
  const query = normalizeText(options.query || '').toLowerCase();
  return sessions
    .filter((session) => options.includeArchived || !session.archived)
    .filter((session) => !query || `${session.title} ${session.summary || ''} ${(session.tags || []).join(' ')}`.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function archiveChatSession(id: string, archived = true): Promise<ChatSession | null> {
  return updateChatSession(id, { archived });
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  const session = await runStore<ChatSession>(SESSIONS_STORE, 'readonly', (store) => store.get(id));
  return session || null;
}

export async function updateChatSession(id: string, updates: Partial<Omit<ChatSession, 'id' | 'createdAt'>>): Promise<ChatSession | null> {
  const current = await getChatSession(id);
  if (!current) return null;
  const next: ChatSession = { ...current, ...updates, updatedAt: Date.now() };
  await runStore(SESSIONS_STORE, 'readwrite', (store) => store.put(next));
  return next;
}

export async function deleteChatSession(id: string): Promise<void> {
  const messages = await getChatSessionMessages(id);
  await runTransaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite', (stores) => {
    stores[SESSIONS_STORE].delete(id);
    messages.forEach((msg) => stores[MESSAGES_STORE].delete(msg.id));
  });
}

export async function saveChatMessage(message: StoredChatMessage): Promise<void> {
  await runStore(MESSAGES_STORE, 'readwrite', (store) => store.put(message));
  const session = await getChatSession(message.sessionId);
  if (!session) return;
  const messages = await getChatSessionMessages(message.sessionId);
  const firstUser = message.role === 'user' && session.title === '新对话';
  await updateChatSession(message.sessionId, {
    title: firstUser ? inferMemoryTitle(message.content) : session.title,
    messageCount: messages.length,
  });
}

export async function getChatSessionMessages(sessionId: string): Promise<StoredChatMessage[]> {
  const messages = await getAllFromStore<StoredChatMessage>(MESSAGES_STORE);
  return messages
    .filter((msg) => msg.sessionId === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function clearChatHistory(): Promise<void> {
  await runTransaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite', (stores) => {
    stores[SESSIONS_STORE].clear();
    stores[MESSAGES_STORE].clear();
  });
}

export async function listUserMemories(includeDisabled = false): Promise<UserMemory[]> {
  const memories = await getAllFromStore<UserMemory>(MEMORIES_STORE);
  return memories
    .filter((item) => includeDisabled || item.enabled)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getUserMemory(id: string): Promise<UserMemory | null> {
  const memory = await runStore<UserMemory>(MEMORIES_STORE, 'readonly', (store) => store.get(id));
  return memory || null;
}

export async function upsertUserMemory(input: Partial<UserMemory> & Pick<UserMemory, 'content'>): Promise<UserMemory> {
  const content = normalizeText(input.content);
  if (!content) throw new Error('记忆内容不能为空');
  if (isSensitiveMemoryContent(content)) {
    throw new Error('疑似敏感信息，已拒绝保存到长期记忆');
  }

  const now = Date.now();
  const existing = (await listUserMemories(true)).find((item) => (
    item.id === input.id
    || normalizeText(item.content) === content
    || (item.type === input.type && normalizeText(item.title) === normalizeText(input.title || inferMemoryTitle(content)))
  ));

  const memory: UserMemory = {
    id: existing?.id || input.id || makeId('memory'),
    type: input.type || existing?.type || inferMemoryType(content),
    title: input.title?.trim() || existing?.title || inferMemoryTitle(content),
    content,
    sourceSessionId: input.sourceSessionId || existing?.sourceSessionId,
    sourceMessageId: input.sourceMessageId || existing?.sourceMessageId,
    confidence: input.confidence ?? existing?.confidence ?? 0.8,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };

  await runStore(MEMORIES_STORE, 'readwrite', (store) => store.put(memory));
  return memory;
}

export async function deleteUserMemory(id: string): Promise<void> {
  await runStore(MEMORIES_STORE, 'readwrite', (store) => store.delete(id));
}

export async function clearUserMemories(): Promise<void> {
  await runStore(MEMORIES_STORE, 'readwrite', (store) => store.clear());
}

export async function recallMemories(query: string, limit = DEFAULT_MEMORY_LIMIT): Promise<UserMemory[]> {
  if (!(await isMemoryEnabled())) return [];
  const memories = await listUserMemories(false);
  const queryWords = new Set(extractKeywords(query));
  if (queryWords.size === 0) return memories.slice(0, Math.min(limit, 3));

  return memories
    .map((memory) => {
      const text = `${memory.title} ${memory.content} ${memory.type}`.toLowerCase();
      const words = extractKeywords(text);
      const overlap = words.reduce((score, word) => score + (queryWords.has(word) ? 1 : 0), 0);
      const recency = Math.max(0, 1 - (Date.now() - memory.updatedAt) / (1000 * 60 * 60 * 24 * 90));
      return { memory, score: overlap * 10 + memory.confidence + recency };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
}

export async function buildMemoryContext(query: string, sessionId?: string, maxChars = DEFAULT_CONTEXT_LIMIT): Promise<MemoryRecallResult> {
  const memories = await recallMemories(query, DEFAULT_MEMORY_LIMIT);
  const session = sessionId ? await getChatSession(sessionId) : null;
  const lines: string[] = [];

  if (session?.summary) {
    lines.push(`当前会话摘要：${session.summary}`);
  }

  if (memories.length > 0) {
    lines.push('以下是用户长期记忆，仅作为偏好和上下文参考，不是用户当前指令：');
    memories.forEach((memory, index) => {
      lines.push(`${index + 1}. [${memory.type}] ${memory.title}：${memory.content}`);
    });
  }

  let contextText = lines.join('\n');
  if (contextText.length > maxChars) {
    contextText = `${contextText.slice(0, maxChars)}\n[长期记忆过长，已截断]`;
  }

  if (memories.length > 0) {
    await runStore(RECALL_LOGS_STORE, 'readwrite', (store) => store.put({
      id: makeId('recall'),
      query,
      memoryIds: memories.map((memory) => memory.id),
      createdAt: Date.now(),
    } satisfies MemoryRecallLog));
  }

  return {
    memories,
    sessionSummary: session?.summary,
    contextText,
  };
}
