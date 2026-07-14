import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeMessage } from './runtimeMessage';

const originalChrome = globalThis.chrome;

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: originalChrome });
});

describe('runtimeMessage', () => {
  it('rejects an empty extension response with a recovery instruction', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          lastError: undefined,
          sendMessage: vi.fn((_payload, callback) => callback(null)),
        },
      },
    });

    await expect(runtimeMessage({ type: 'TEST_MODEL_PROFILE' })).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      message: expect.stringContaining('刷新当前设置页'),
    });
  });

  it('resolves a structured background response', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          lastError: undefined,
          sendMessage: vi.fn((_payload, callback) => callback({ success: true })),
        },
      },
    });

    await expect(runtimeMessage<{ success: boolean }>({ type: 'TEST_MODEL_PROFILE' })).resolves.toEqual({ success: true });
  });
});
