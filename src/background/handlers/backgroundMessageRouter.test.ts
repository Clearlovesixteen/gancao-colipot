import { describe, expect, it, vi } from 'vitest';
import { createBackgroundMessageRouter } from './backgroundMessageRouter';

function createRouter(overrides: Record<string, unknown> = {}) {
  return createBackgroundMessageRouter({
    modelGateway: {} as any,
    buildId: 'build-current',
    isRuntimeVersionCurrent: ({ buildId }) => buildId === 'build-current',
    runtimeMismatchMessage: (buildId) => `runtime mismatch: ${buildId}`,
    automation: {} as any,
    auth: {} as any,
    modelChat: {} as any,
    pageTools: {} as any,
    confirmBrowserUseAction: vi.fn(() => true),
    ...overrides,
  });
}

describe('backgroundMessageRouter', () => {
  it('rejects stale clients before a long-running handler starts', () => {
    const sendResponse = vi.fn();
    const handled = createRouter()(
      { type: 'RUN_AUTOMATION_TASK', clientBuildId: 'build-old' },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(handled).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      code: 'EXTENSION_RUNTIME_MISMATCH',
      error: 'runtime mismatch: build-old',
      buildId: 'build-current',
    });
  });

  it('routes Browser Use confirmation through the dedicated callback', () => {
    const confirmBrowserUseAction = vi.fn(() => true);
    const message = {
      type: 'CONFIRM_COMPUTER_USE_ACTION',
      runId: 'run_1',
      stepIndex: 2,
      allowed: true,
    };
    const handled = createRouter({ confirmBrowserUseAction })(
      message,
      {} as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(confirmBrowserUseAction).toHaveBeenCalledWith(message, expect.any(Function));
  });
});
