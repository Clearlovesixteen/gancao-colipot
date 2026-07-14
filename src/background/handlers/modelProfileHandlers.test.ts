import { describe, expect, it, vi } from 'vitest';
import { handleModelProfileMessage } from './modelProfileHandlers';

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('handleModelProfileMessage', () => {
  it('keeps the channel open and returns a structured connection-test response', async () => {
    const sendResponse = vi.fn();
    const gateway = { test: vi.fn(async () => undefined) } as any;
    const handled = handleModelProfileMessage({
      type: 'TEST_MODEL_PROFILE',
      profile: {
        name: 'DeepSeek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        capabilities: { streaming: true, tools: true, json: true, files: false },
      },
    }, sendResponse, gateway);

    expect(handled).toBe(true);
    await flush();
    expect(gateway.test).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('returns the model error instead of dropping the response', async () => {
    const sendResponse = vi.fn();
    const gateway = { test: vi.fn(async () => { throw Object.assign(new Error('HTTP 401'), { code: 'MODEL_HTTP_ERROR' }); }) } as any;
    handleModelProfileMessage({ type: 'TEST_MODEL_PROFILE', profile: {} }, sendResponse, gateway);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'MODEL_HTTP_ERROR',
      error: 'HTTP 401',
      recovery: expect.any(String),
      retryable: true,
    }));
  });
});
