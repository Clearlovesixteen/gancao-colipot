export type ModelProvider = 'deepseek' | 'gancao' | 'openai_compatible';

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  json: boolean;
  files: boolean;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  capabilities: ModelCapabilities;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PublicModelProfile = Omit<ModelProfile, 'apiKey'> & {
  apiKey: string;
  hasApiKey: boolean;
};

const STORAGE_KEY = 'modelProfiles';
const ACTIVE_KEY = 'activeModelProfileId';

export const MODEL_PROFILE_PRESETS: Array<Pick<ModelProfile, 'provider' | 'name' | 'baseUrl' | 'model' | 'capabilities'>> = [
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    capabilities: { streaming: true, tools: true, json: true, files: false },
  },
  {
    provider: 'gancao',
    name: '业务模型',
    baseUrl: 'https://api.86gamestore.com/v1',
    model: 'gpt-5.5',
    capabilities: { streaming: true, tools: true, json: true, files: true },
  },
  {
    provider: 'openai_compatible',
    name: 'OpenAI Compatible',
    baseUrl: '',
    model: '',
    capabilities: { streaming: true, tools: true, json: true, files: false },
  },
];

function normalizeUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeProfiles(value: unknown): ModelProfile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ModelProfile => Boolean(
    item && typeof item.id === 'string' && typeof item.baseUrl === 'string' && typeof item.model === 'string',
  ));
}

export function maskApiKey(value: string): string {
  const key = String(value || '');
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}${'•'.repeat(Math.min(12, key.length - 7))}${key.slice(-4)}`;
}

export function toPublicModelProfile(profile: ModelProfile): PublicModelProfile {
  return { ...profile, apiKey: maskApiKey(profile.apiKey), hasApiKey: Boolean(profile.apiKey) };
}

export async function listModelProfiles(): Promise<ModelProfile[]> {
  const result = await chrome.storage.local.get([STORAGE_KEY, ACTIVE_KEY]);
  const activeId = String(result[ACTIVE_KEY] || '');
  return normalizeProfiles(result[STORAGE_KEY]).map((profile) => ({ ...profile, active: profile.id === activeId }));
}

export async function getActiveModelProfile(): Promise<ModelProfile | null> {
  return (await listModelProfiles()).find((profile) => profile.active) || null;
}

export async function upsertModelProfile(input: Partial<ModelProfile> & Pick<ModelProfile, 'name' | 'provider' | 'baseUrl' | 'model'>): Promise<ModelProfile> {
  const profiles = await listModelProfiles();
  const now = Date.now();
  const existing = input.id ? profiles.find((item) => item.id === input.id) : undefined;
  const id = existing?.id || input.id || `model_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const next: ModelProfile = {
    id,
    name: input.name.trim(),
    provider: input.provider,
    baseUrl: normalizeUrl(input.baseUrl),
    model: input.model.trim(),
    apiKey: input.apiKey && !input.apiKey.includes('•') ? input.apiKey.trim() : existing?.apiKey || '',
    capabilities: input.capabilities || existing?.capabilities || { streaming: true, tools: true, json: true, files: false },
    active: input.active ?? existing?.active ?? profiles.length === 0,
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  const merged = [next, ...profiles.filter((item) => item.id !== id)].map((item) => ({ ...item, active: next.active ? item.id === id : item.active }));
  const activeId = merged.find((item) => item.active)?.id || '';
  await chrome.storage.local.set({ [STORAGE_KEY]: merged.map(({ active, ...item }) => item), [ACTIVE_KEY]: activeId });
  return { ...next, active: next.id === activeId };
}

export async function setActiveModelProfile(id: string): Promise<void> {
  const profiles = await listModelProfiles();
  if (!profiles.some((profile) => profile.id === id)) throw new Error('未找到模型配置');
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

export async function deleteModelProfile(id: string): Promise<void> {
  const profiles = await listModelProfiles();
  const remaining = profiles.filter((profile) => profile.id !== id);
  const activeId = profiles.find((profile) => profile.active)?.id === id ? remaining[0]?.id || '' : profiles.find((profile) => profile.active)?.id || '';
  await chrome.storage.local.set({ [STORAGE_KEY]: remaining.map(({ active, ...item }) => item), [ACTIVE_KEY]: activeId });
}

export function validateModelProfile(profile: Partial<ModelProfile>): string | null {
  if (!profile.name?.trim()) return '请输入配置名称';
  if (!/^https?:\/\//i.test(profile.baseUrl || '')) return '请输入有效的 Base URL';
  if (!profile.model?.trim()) return '请输入模型名称';
  if (!profile.apiKey?.trim()) return '请输入 API Key';
  return null;
}

export function redactSecrets(value: unknown, secrets: string[] = []): unknown {
  const secretSet = secrets.filter(Boolean);
  const redactText = (text: string) => secretSet.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text)
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]');
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => (
      [key, /api[_-]?key|authorization/i.test(key) ? '[REDACTED]' : redactSecrets(item, secrets)]
    )));
  }
  return value;
}
