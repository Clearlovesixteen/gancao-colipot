import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCustomCommand,
  exportCustomCommands,
  importCustomCommands,
  listCustomCommands,
  upsertCustomCommand,
} from './customCommandStore';

describe('customCommandStore', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('creates, versions, disables and deletes commands', async () => {
    const created = await upsertCustomCommand({ title: '库存诊断', promptTemplate: '诊断当前库存页面' });
    expect(created.version).toBe(1);
    const updated = await upsertCustomCommand({ ...created, enabled: false, promptTemplate: '诊断并给出修复建议' });
    expect(updated.version).toBe(2);
    expect(await listCustomCommands()).toEqual([]);
    expect(await listCustomCommands(true)).toHaveLength(1);
    await deleteCustomCommand(created.id);
    expect(await listCustomCommands(true)).toEqual([]);
  });

  it('exports and imports commands', async () => {
    await upsertCustomCommand({ title: '表格提取', promptTemplate: '提取当前页面表格', mode: 'task', taskKind: 'extract' });
    const raw = await exportCustomCommands();
    await chrome.storage.local.clear();
    expect(await importCustomCommands(raw)).toBe(1);
    expect((await listCustomCommands())[0]).toMatchObject({ title: '表格提取', taskKind: 'extract' });
  });
});
