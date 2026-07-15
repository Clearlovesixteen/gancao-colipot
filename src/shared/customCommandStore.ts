import type { AutomationRunKind } from './automationTypes';

export type CustomCommandMode = 'prompt' | 'task';
export type CustomCommandInputField = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean';
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
};

export interface CustomCopilotCommand {
  id: string;
  title: string;
  description?: string;
  mode: CustomCommandMode;
  promptTemplate: string;
  taskKind?: AutomationRunKind;
  metadata?: Record<string, unknown>;
  inputSchema?: CustomCommandInputField[];
  modelProfileId?: string;
  riskLevel: 'low' | 'medium' | 'high';
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'customCopilotCommands';
const VERSIONS_KEY = 'customCopilotCommandVersions';

export interface CustomCommandVersion {
  commandId: string;
  version: number;
  snapshot: CustomCopilotCommand;
  createdAt: number;
}

export async function listCustomCommands(includeDisabled = false): Promise<CustomCopilotCommand[]> {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  const commands = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] as CustomCopilotCommand[] : [];
  return commands
    .filter((command) => includeDisabled || command.enabled)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function upsertCustomCommand(
  input: Partial<CustomCopilotCommand> & Pick<CustomCopilotCommand, 'title' | 'promptTemplate'>,
): Promise<CustomCopilotCommand> {
  const commands = await listCustomCommands(true);
  const current = input.id ? commands.find((command) => command.id === input.id) : undefined;
  const now = Date.now();
  const next: CustomCopilotCommand = {
    id: current?.id || input.id || `custom_command_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title.trim(),
    description: input.description?.trim() || current?.description,
    mode: input.mode || current?.mode || 'prompt',
    promptTemplate: input.promptTemplate.trim(),
    taskKind: input.taskKind || current?.taskKind,
    metadata: input.metadata || current?.metadata || {},
    inputSchema: input.inputSchema || current?.inputSchema || [],
    modelProfileId: input.modelProfileId ?? current?.modelProfileId,
    riskLevel: input.riskLevel || current?.riskLevel || 'low',
    enabled: input.enabled ?? current?.enabled ?? true,
    version: current ? current.version + 1 : input.version || 1,
    createdAt: current?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  const stored = await chrome.storage.local.get({ [VERSIONS_KEY]: [] });
  const versions = Array.isArray(stored[VERSIONS_KEY]) ? stored[VERSIONS_KEY] as CustomCommandVersion[] : [];
  const versionSnapshot: CustomCommandVersion = { commandId: next.id, version: next.version, snapshot: next, createdAt: now };
  await chrome.storage.local.set({
    [STORAGE_KEY]: [next, ...commands.filter((command) => command.id !== next.id)],
    [VERSIONS_KEY]: [versionSnapshot, ...versions.filter((item) => !(item.commandId === next.id && item.version === next.version))].slice(0, 500),
  });
  return next;
}

export async function deleteCustomCommand(id: string): Promise<void> {
  const commands = await listCustomCommands(true);
  await chrome.storage.local.set({ [STORAGE_KEY]: commands.filter((command) => command.id !== id) });
}

export async function listCustomCommandVersions(commandId: string): Promise<CustomCommandVersion[]> {
  const result = await chrome.storage.local.get({ [VERSIONS_KEY]: [] });
  const versions = Array.isArray(result[VERSIONS_KEY]) ? result[VERSIONS_KEY] as CustomCommandVersion[] : [];
  return versions.filter((item) => item.commandId === commandId).sort((a, b) => b.version - a.version);
}

export async function rollbackCustomCommand(commandId: string, version: number): Promise<CustomCopilotCommand> {
  const target = (await listCustomCommandVersions(commandId)).find((item) => item.version === version);
  if (!target) throw new Error('未找到该命令版本');
  return upsertCustomCommand({ ...target.snapshot, id: commandId, version: undefined });
}

export function renderCustomCommandTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => String(values[key] ?? ''));
}

export function renderCustomCommandMetadata(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderCustomCommandTemplate(value, values);
  if (Array.isArray(value)) return value.map((item) => renderCustomCommandMetadata(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderCustomCommandMetadata(item, values)]));
  }
  return value;
}

export async function exportCustomCommands(): Promise<string> {
  return JSON.stringify({ schemaVersion: 1, commands: await listCustomCommands(true) }, null, 2);
}

export async function importCustomCommands(raw: string): Promise<number> {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.commands)) throw new Error('命令文件格式不正确');
  let count = 0;
  for (const command of parsed.commands) {
    if (!command?.title || !command?.promptTemplate) continue;
    await upsertCustomCommand({ ...command, id: undefined });
    count += 1;
  }
  return count;
}
