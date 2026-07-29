import { describe, expect, it } from 'vitest';
import { RUNTIME_BUILD_ID, isRuntimeVersionCurrent, runtimeMismatchMessage } from './runtimeVersion';

describe('runtimeVersion', () => {
  it('accepts only the exact current build id', () => {
    expect(isRuntimeVersionCurrent({ buildId: RUNTIME_BUILD_ID })).toBe(true);
    expect(isRuntimeVersionCurrent({ buildId: 'old-build' })).toBe(false);
    expect(isRuntimeVersionCurrent(undefined)).toBe(false);
  });

  it('describes both sides of a runtime mismatch', () => {
    expect(runtimeMismatchMessage('old-build')).toContain(RUNTIME_BUILD_ID);
    expect(runtimeMismatchMessage('old-build')).toContain('old-build');
  });
});
