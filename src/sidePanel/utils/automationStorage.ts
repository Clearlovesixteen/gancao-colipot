import type { AutomationWorkflow } from '../../shared/automationTypes';

export type StoredAutomationWorkflow = {
  id: string;
  name: string;
  workflow: AutomationWorkflow;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'automationWorkflows';

function normalizeItems(value: unknown): StoredAutomationWorkflow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => v as StoredAutomationWorkflow)
    .filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.workflow && Array.isArray((v.workflow as any).steps));
}

export async function listAutomationWorkflows(): Promise<StoredAutomationWorkflow[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const items = normalizeItems(result[STORAGE_KEY]);
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAutomationWorkflow(id: string): Promise<StoredAutomationWorkflow | null> {
  const items = await listAutomationWorkflows();
  return items.find((x) => x.id === id) || null;
}

export async function upsertAutomationWorkflow(input: {
  id: string;
  name: string;
  workflow: AutomationWorkflow;
}): Promise<void> {
  const now = Date.now();
  const items = await listAutomationWorkflows();
  const existing = items.find((x) => x.id === input.id);
  const next: StoredAutomationWorkflow = existing
    ? { ...existing, name: input.name, workflow: input.workflow, updatedAt: now }
    : { id: input.id, name: input.name, workflow: input.workflow, createdAt: now, updatedAt: now };

  const merged = existing ? items.map((x) => (x.id === input.id ? next : x)) : [next, ...items];
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
}

export async function deleteAutomationWorkflow(id: string): Promise<void> {
  const items = await listAutomationWorkflows();
  const next = items.filter((x) => x.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

