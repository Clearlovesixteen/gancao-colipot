import { describe, expect, it, vi } from 'vitest';
import { executeNavigationAwareAction } from './navigationCoordinator';

describe('navigation coordinator', () => {
  it('treats BFCache channel closure as an uncertain navigation result and synchronizes the tab', async () => {
    const synchronize = vi.fn(async () => undefined);
    const outcome = await executeNavigationAwareAction({
      mayNavigate: true,
      execute: async () => {
        throw new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
      },
      synchronize,
      settleMs: 0,
    });

    expect(outcome.channelTransition).toBe(true);
    expect(outcome.result).toEqual(expect.objectContaining({ success: true, navigationPending: true }));
    expect(synchronize).toHaveBeenCalledOnce();
  });

  it('does not hide the same channel error for a non-navigation action', async () => {
    await expect(executeNavigationAwareAction({
      mayNavigate: false,
      execute: async () => {
        throw new Error('message channel is closed');
      },
    })).rejects.toThrow('message channel is closed');
  });

  it('returns ordinary action results unchanged', async () => {
    const synchronize = vi.fn(async () => undefined);
    const outcome = await executeNavigationAwareAction({
      mayNavigate: true,
      execute: async () => ({ success: true, clicked: 'result-3' }),
      synchronize,
      settleMs: 0,
    });

    expect(outcome).toEqual(expect.objectContaining({
      result: { success: true, clicked: 'result-3' },
      channelTransition: false,
    }));
    expect(synchronize).toHaveBeenCalledOnce();
  });

});
