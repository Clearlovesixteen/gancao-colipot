import { describe, expect, it, vi } from 'vitest';
import {
  getLegacyCleanupVersion,
  listRemovedLegacyStorageKeys,
  purgeRemovedLegacyData,
} from './removedLegacyData';

describe('purgeRemovedLegacyData', () => {
  it('deletes removed storage data without migrating it', async () => {
    const get = vi.fn().mockResolvedValue({});
    const set = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(purgeRemovedLegacyData({ get, set, remove } as any)).resolves.toBe(true);

    expect(remove).toHaveBeenCalledWith([
      'uploadedFiles',
      'businessWorkflowDrafts',
      'automationRuns',
      'pageMonitorCheckHistory',
      'customCopilotCommands',
      'customCopilotCommandVersions',
    ]);
    expect(set).toHaveBeenCalledWith({ gancaoCoreLegacyCleanupVersion: getLegacyCleanupVersion() });
    expect(listRemovedLegacyStorageKeys()).toEqual([
      'uploadedFiles',
      'businessWorkflowDrafts',
      'automationRuns',
      'pageMonitorCheckHistory',
      'customCopilotCommands',
      'customCopilotCommandVersions',
    ]);
  });

  it('does not clear new data again after the schema cleanup completed', async () => {
    const get = vi.fn().mockResolvedValue({
      gancaoCoreLegacyCleanupVersion: getLegacyCleanupVersion(),
    });
    const set = vi.fn();
    const remove = vi.fn();

    await expect(purgeRemovedLegacyData({ get, set, remove } as any)).resolves.toBe(false);

    expect(remove).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
