const REMOVED_STORAGE_KEYS = ['uploadedFiles'] as const;

type LegacyStorageArea = Pick<typeof chrome.storage.local, 'remove'>;

export async function purgeRemovedLegacyData(
  storage: LegacyStorageArea = chrome.storage.local,
): Promise<void> {
  await storage.remove([...REMOVED_STORAGE_KEYS]);
}

export function listRemovedLegacyStorageKeys(): readonly string[] {
  return REMOVED_STORAGE_KEYS;
}
