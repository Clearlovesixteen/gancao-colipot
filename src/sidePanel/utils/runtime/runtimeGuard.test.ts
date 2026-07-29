import { describe, expect, it } from 'vitest';
import { isPackagedBuildCurrent } from './runtimeGuard';

describe('runtime guard', () => {
  it('accepts only the build bundled with the current side panel', () => {
    expect(isPackagedBuildCurrent({ buildId: 'vitest-build' })).toBe(true);
    expect(isPackagedBuildCurrent({ buildId: 'older-build' })).toBe(false);
  });

  it('rejects missing build metadata', () => {
    expect(isPackagedBuildCurrent(null)).toBe(false);
    expect(isPackagedBuildCurrent({})).toBe(false);
  });
});
