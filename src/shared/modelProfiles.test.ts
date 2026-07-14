import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteModelProfile,
  getActiveModelProfile,
  listModelProfiles,
  maskApiKey,
  redactSecrets,
  setActiveModelProfile,
  toPublicModelProfile,
  upsertModelProfile,
} from './modelProfiles';

describe('modelProfiles', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('stores profiles locally and activates the first profile', async () => {
    const profile = await upsertModelProfile({
      name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKey: 'secret-model-key',
    });
    expect(profile.active).toBe(true);
    expect((await getActiveModelProfile())?.apiKey).toBe('secret-model-key');
    expect(toPublicModelProfile(profile).apiKey).not.toContain('secret-model-key');
  });

  it('preserves the old key when an edit submits a masked or empty value', async () => {
    const first = await upsertModelProfile({ name: 'A', provider: 'deepseek', baseUrl: 'https://a.test', model: 'm', apiKey: 'secret-model-key' });
    await upsertModelProfile({ ...first, name: 'B', apiKey: '' });
    expect((await listModelProfiles())[0].apiKey).toBe('secret-model-key');
  });

  it('switches and deletes active profiles without leaking keys', async () => {
    const first = await upsertModelProfile({ name: 'A', provider: 'deepseek', baseUrl: 'https://a.test', model: 'm', apiKey: 'key-a-secret' });
    const second = await upsertModelProfile({ name: 'B', provider: 'openai_compatible', baseUrl: 'https://b.test/v1', model: 'm2', apiKey: 'key-b-secret', active: false });
    await setActiveModelProfile(second.id);
    expect((await getActiveModelProfile())?.id).toBe(second.id);
    await deleteModelProfile(second.id);
    expect((await getActiveModelProfile())?.id).toBe(first.id);
    expect(JSON.stringify(redactSecrets({ authorization: 'Bearer abc', nested: `token key-a-secret` }, ['key-a-secret']))).not.toContain('key-a-secret');
    expect(maskApiKey('123456789012')).toMatch(/^123.*9012$/);
  });
});
