import type { AutomationWorkflow } from './automationTypes';

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
    .map((item) => item as StoredAutomationWorkflow)
    .filter((item) => item
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && item.workflow
      && Array.isArray(item.workflow.steps));
}

export async function listAutomationWorkflows(): Promise<StoredAutomationWorkflow[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeItems(result[STORAGE_KEY]).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAutomationWorkflow(id: string): Promise<StoredAutomationWorkflow | null> {
  const items = await listAutomationWorkflows();
  return items.find((item) => item.id === id) || null;
}

export async function upsertAutomationWorkflow(input: {
  id: string;
  name: string;
  workflow: AutomationWorkflow;
}): Promise<void> {
  const now = Date.now();
  const items = await listAutomationWorkflows();
  const existing = items.find((item) => item.id === input.id);
  const next: StoredAutomationWorkflow = existing
    ? { ...existing, name: input.name, workflow: input.workflow, updatedAt: now }
    : { id: input.id, name: input.name, workflow: input.workflow, createdAt: now, updatedAt: now };
  const merged = existing
    ? items.map((item) => item.id === input.id ? next : item)
    : [next, ...items];
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
}

export async function deleteAutomationWorkflow(id: string): Promise<void> {
  const items = await listAutomationWorkflows();
  await chrome.storage.local.set({ [STORAGE_KEY]: items.filter((item) => item.id !== id) });
}
