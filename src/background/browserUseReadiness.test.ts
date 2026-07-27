import { describe, expect, it, vi } from 'vitest';
import { waitForStableBrowserState } from './browserUseReadiness';

describe('waitForStableBrowserState', () => {
  it('waits for the requested state to remain stable across consecutive observations', async () => {
    const observations = [
      { url: 'https://example.com/loading', items: [] },
      { url: 'https://example.com/results', items: ['a', 'b'] },
      { url: 'https://example.com/results', items: ['a', 'b'] },
    ];
    const observe = vi.fn(async () => observations.shift() || { url: 'https://example.com/results', items: ['a', 'b'] });

    const result = await waitForStableBrowserState({
      observe,
      isReady: (value) => value.items.length > 0,
      fingerprint: (value) => `${value.url}:${value.items.join(',')}`,
      attempts: 4,
      stableSamples: 2,
      delayMs: 0,
    });

    expect(result.value.items).toEqual(['a', 'b']);
    expect(result.stable).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('returns a classified failure when the page never becomes ready', async () => {
    await expect(waitForStableBrowserState({
      observe: async () => ({ url: 'about:blank', items: [] as string[] }),
      isReady: (value) => value.items.length > 0,
      fingerprint: (value) => value.url,
      attempts: 2,
      delayMs: 0,
    })).rejects.toMatchObject({
      code: 'PAGE_NOT_SETTLED',
      retryable: true,
    });
  });

  it('retries while a destination content script is attaching', async () => {
    const synchronize = vi.fn(async () => undefined);
    const observe = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValueOnce({ url: 'https://target.test', ready: true })
      .mockResolvedValueOnce({ url: 'https://target.test', ready: true });

    const result = await waitForStableBrowserState<{ url: string; ready: boolean }>({
      observe,
      synchronize,
      isReady: (value) => value.ready,
      fingerprint: (value) => value.url,
      attempts: 4,
      stableSamples: 2,
      delayMs: 0,
    });

    expect(result.value.url).toBe('https://target.test');
    expect(observe).toHaveBeenCalledTimes(3);
    expect(synchronize).toHaveBeenCalledTimes(2);
  });
});
