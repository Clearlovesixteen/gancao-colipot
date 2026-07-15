import { describe, expect, it, vi } from 'vitest';
import { resolveBrowserContextTabId } from './browserTabContext';

describe('resolveBrowserContextTabId', () => {
  it('优先使用请求绑定的业务标签页，而不是后台窗口的活动标签页', async () => {
    const getCurrentActiveTab = vi.fn(async () => 99);
    const getTab = vi.fn(async (tabId: number) => ({ id: tabId }));

    await expect(resolveBrowserContextTabId(42, { getTab, getCurrentActiveTab })).resolves.toBe(42);
    expect(getTab).toHaveBeenCalledWith(42);
    expect(getCurrentActiveTab).not.toHaveBeenCalled();
  });

  it('绑定标签页失效后回退到当前活动标签页', async () => {
    const getCurrentActiveTab = vi.fn(async () => 99);
    const getTab = vi.fn(async () => { throw new Error('No tab'); });

    await expect(resolveBrowserContextTabId(42, { getTab, getCurrentActiveTab })).resolves.toBe(99);
  });
});
