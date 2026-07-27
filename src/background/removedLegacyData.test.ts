import { describe, expect, it, vi } from 'vitest';
import { listRemovedLegacyStorageKeys, purgeRemovedLegacyData } from './removedLegacyData';

describe('purgeRemovedLegacyData', () => {
  it('deletes removed storage data without migrating it', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await purgeRemovedLegacyData({ remove } as any);

    expect(remove).toHaveBeenCalledWith(['uploadedFiles']);
    expect(listRemovedLegacyStorageKeys()).toEqual(['uploadedFiles']);
  });
});
