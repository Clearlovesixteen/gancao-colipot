import { describe, expect, it } from 'vitest';
import { derivePageSignals, getBlockingPageSignal, mergePageSignals } from './pageSignals';

describe('pageSignals', () => {
  it('uses the same blocking signal vocabulary for page context and browser use', () => {
    const signals = derivePageSignals({
      pageState: {
        kind: 'permission_page',
        hasModal: false,
        hasCaptcha: false,
        hasLoginSignal: false,
        hasPermissionDenied: true,
      },
      textPreview: '当前账号权限不足',
    });

    expect(signals).toContainEqual(expect.objectContaining({ type: 'permission', severity: 'error' }));
    expect(getBlockingPageSignal(signals)?.type).toBe('permission');
  });

  it('does not treat an ordinary page containing a login link as a login blocker', () => {
    const signals = derivePageSignals({
      pageState: {
        kind: 'table_page',
        hasModal: false,
        hasCaptcha: false,
        hasLoginSignal: true,
      },
      textPreview: '业务列表 顶部提供登录入口',
    });

    expect(signals.some((signal) => signal.type === 'login')).toBe(false);
  });

  it('classifies console, resource and network failures without duplicates', () => {
    const signals = derivePageSignals({
      existingSignals: [{ type: 'empty', severity: 'info', message: '暂无数据' }],
      consoleErrors: [
        { source: 'console.error', message: 'boom' },
        { source: 'resource', message: 'script 404' },
        { source: 'network', message: 'fetch failed' },
      ],
    });

    expect(signals.map((signal) => signal.type)).toEqual([
      'empty',
      'console_error',
      'resource_error',
      'network_error',
    ]);
    expect(mergePageSignals(signals, signals)).toHaveLength(4);
  });
});
