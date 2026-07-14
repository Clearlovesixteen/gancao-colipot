import type { DocumentSpace } from './documentTypes';

const STORAGE_KEY = 'documentSpaces';

export async function listDocumentSpaces(): Promise<DocumentSpace[]> {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return (Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] as DocumentSpace[] : [])
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export async function upsertDocumentSpace(input: Partial<DocumentSpace> & Pick<DocumentSpace, 'name'>): Promise<DocumentSpace> {
  const spaces = await listDocumentSpaces();
  const current = input.id ? spaces.find((space) => space.id === input.id) : undefined;
  const now = Date.now();
  const next: DocumentSpace = {
    id: current?.id || input.id || `space_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    color: input.color || current?.color,
    createdAt: current?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: [next, ...spaces.filter((space) => space.id !== next.id)] });
  return next;
}

export async function deleteDocumentSpace(id: string): Promise<void> {
  const spaces = await listDocumentSpaces();
  await chrome.storage.local.set({ [STORAGE_KEY]: spaces.filter((space) => space.id !== id) });
}
