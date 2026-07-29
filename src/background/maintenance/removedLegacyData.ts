const LEGACY_CLEANUP_VERSION = 2;
const LEGACY_CLEANUP_VERSION_KEY = 'gancaoCoreLegacyCleanupVersion';
const REMOVED_STORAGE_KEYS = [
  'uploadedFiles',
  'businessWorkflowDrafts',
  'automationRuns',
  'pageMonitorCheckHistory',
  'customCopilotCommands',
  'customCopilotCommandVersions',
] as const;

type LegacyStorageArea = Pick<typeof chrome.storage.local, 'get' | 'set' | 'remove'>;

export async function purgeRemovedLegacyData(
  storage: LegacyStorageArea = chrome.storage.local,
): Promise<boolean> {
  const stored = await storage.get(LEGACY_CLEANUP_VERSION_KEY);
  if (Number(stored[LEGACY_CLEANUP_VERSION_KEY] || 0) >= LEGACY_CLEANUP_VERSION) {
    return false;
  }

  await storage.remove([...REMOVED_STORAGE_KEYS]);
  await storage.set({ [LEGACY_CLEANUP_VERSION_KEY]: LEGACY_CLEANUP_VERSION });
  return true;
}

export function listRemovedLegacyStorageKeys(): readonly string[] {
  return REMOVED_STORAGE_KEYS;
}

export function getLegacyCleanupVersion(): number {
  return LEGACY_CLEANUP_VERSION;
}
