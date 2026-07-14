import { beforeEach, describe, expect, it } from 'vitest';
import { deleteDocumentSpace, listDocumentSpaces, upsertDocumentSpace } from './documentSpaces';

describe('documentSpaces', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('creates, updates and deletes local document spaces', async () => {
    const created = await upsertDocumentSpace({ name: '智慧药房项目' });
    expect((await listDocumentSpaces())[0].name).toBe('智慧药房项目');
    await upsertDocumentSpace({ ...created, name: 'WMS 项目' });
    expect((await listDocumentSpaces())[0].name).toBe('WMS 项目');
    await deleteDocumentSpace(created.id);
    expect(await listDocumentSpaces()).toEqual([]);
  });
});
