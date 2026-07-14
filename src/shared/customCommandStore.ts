import type { AutomationRunKind } from './automationTypes';

export type CustomCommandMode = 'prompt' | 'task';

export interface CustomCopilotCommand {
  id: string;
  title: string;
  description?: string;
  mode: CustomCommandMode;
  promptTemplate: string;
  taskKind?: AutomationRunKind;
  metadata?: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'customCopilotCommands';

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
    riskLevel: input.riskLevel || current?.riskLevel || 'low',
    enabled: input.enabled ?? current?.enabled ?? true,
    version: current ? current.version + 1 : input.version || 1,
    createdAt: current?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  await chrome.storage.local.set({
    [STORAGE_KEY]: [next, ...commands.filter((command) => command.id !== next.id)],
  });
  return next;
}

export async function deleteCustomCommand(id: string): Promise<void> {
  const commands = await listCustomCommands(true);
  await chrome.storage.local.set({ [STORAGE_KEY]: commands.filter((command) => command.id !== id) });
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
