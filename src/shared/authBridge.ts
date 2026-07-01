export type PageAuthStorageSource = 'localStorage' | 'sessionStorage';

export interface PageStorageEntry {
  source: PageAuthStorageSource;
  key: string;
  value: string;
}

export interface PageAuthSnapshot {
  token: string | null;
  tokenKey?: string;
  tokenSource?: PageAuthStorageSource;
  userInfo?: unknown;
  userInfoKey?: string;
  userInfoSource?: PageAuthStorageSource;
  pageLooksLoggedOut?: boolean;
  logoutSignals?: string[];
  url: string;
  host: string;
  detectedAt: number;
}

const TRUSTED_HOST_SUFFIXES = [
  'gancao.com',
  'igancao.cn',
  'localhost',
  '127.0.0.1',
];

const TOKEN_KEYS = [
  'token',
  'accessToken',
  'access_token',
  'authToken',
  'Authorization',
  'authorization',
  'bearerToken',
  'jwt',
  'userToken',
  'dingtalkToken',
  'gc_token',
  'gcToken',
  'sa-token',
  'satoken',
  'satoken-token',
];

const USER_INFO_KEYS = [
  'userInfo',
  'user',
  'currentUser',
  'loginUser',
  'profile',
  'gc_user',
  'gcUser',
];

function safeParseUrl(urlLike: string | null | undefined): URL | null {
  if (!urlLike) return null;
  try {
    return new URL(urlLike);
  } catch {
    return null;
  }
}

export function isTrustedAuthUrl(urlLike: string | null | undefined): boolean {
  const url = safeParseUrl(urlLike);
  if (!url) return false;

  const host = url.hostname.toLowerCase();
  return TRUSTED_HOST_SUFFIXES.some((suffix) => {
    const normalized = suffix.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;

    const parsed = parseMaybeJson(trimmed);
    if (parsed !== trimmed) {
      return normalizeToken(parsed);
    }

    return trimmed.replace(/^Bearer\s+/i, '') || null;
  }

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of TOKEN_KEYS) {
    const token = normalizeToken(record[key]);
    if (token) return token;
  }

  for (const nestedKey of ['data', 'result', 'auth', 'session']) {
    const token = normalizeToken(record[nestedKey]);
    if (token) return token;
  }

  return null;
}

function keyMatches(key: string, candidates: string[]): boolean {
  return candidates.some((candidate) => key.toLowerCase() === candidate.toLowerCase());
}

function findToken(entries: PageStorageEntry[]) {
  const exactMatches = entries.filter((entry) => keyMatches(entry.key, TOKEN_KEYS));
  for (const exactMatch of exactMatches) {
    const token = normalizeToken(exactMatch.value);
    if (token) {
      return { entry: exactMatch, token };
    }
  }

  for (const entry of entries) {
    const parsed = parseMaybeJson(entry.value);
    if (parsed && typeof parsed === 'object') {
      const token = normalizeToken(parsed);
      if (token) {
        return { entry, token };
      }
    }
  }

  return null;
}

function findUserInfo(entries: PageStorageEntry[]) {
  const entry = entries.find((item) => keyMatches(item.key, USER_INFO_KEYS));
  if (!entry) return null;

  const parsed = parseMaybeJson(entry.value);
  if (typeof parsed === 'string') {
    return { entry, userInfo: parsed };
  }

  return { entry, userInfo: parsed };
}

export function pickPageAuthFromEntries(
  entries: PageStorageEntry[],
  urlLike: string
): PageAuthSnapshot {
  const url = safeParseUrl(urlLike);
  const tokenMatch = findToken(entries);
  const userInfoMatch = findUserInfo(entries);

  return {
    token: tokenMatch?.token || null,
    tokenKey: tokenMatch?.entry.key,
    tokenSource: tokenMatch?.entry.source,
    userInfo: userInfoMatch?.userInfo,
    userInfoKey: userInfoMatch?.entry.key,
    userInfoSource: userInfoMatch?.entry.source,
    url: urlLike,
    host: url?.hostname || '',
    detectedAt: Date.now(),
  };
}
