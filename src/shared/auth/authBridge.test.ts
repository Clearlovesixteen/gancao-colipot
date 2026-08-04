import { describe, expect, it } from 'vitest';
import { pickPageAuthFromEntries } from './authBridge';

describe('pickPageAuthFromEntries', () => {
  it('finds a token nested inside a persisted application store', () => {
    const result = pickPageAuthFromEntries([{
      source: 'localStorage',
      key: 'persist:root',
      value: JSON.stringify({
        application: {
          account: JSON.stringify({ session: { accessToken: 'wms-token' } }),
        },
      }),
    }], 'https://adminweb-erp-warehousing.gancao.com/#/dashboard');

    expect(result.token).toBe('wms-token');
    expect(result.tokenKey).toBe('persist:root');
  });
});
