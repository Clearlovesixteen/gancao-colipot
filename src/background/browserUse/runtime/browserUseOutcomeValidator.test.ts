import { describe, expect, it } from 'vitest';
import { validateBrowserUseOutcome } from './browserUseOutcomeValidator';

describe('validateBrowserUseOutcome', () => {
  it('classifies a verified click without phase evidence as an unmet outcome', () => {
    const result = validateBrowserUseOutcome({
      verification: { success: true },
      completion: { complete: false, reason: '目标页面尚未打开' },
      action: 'click',
    });
    expect(result).toEqual({
      ok: false,
      code: 'OUTCOME_NOT_REACHED',
      reason: '目标页面尚未打开',
      retryable: true,
    });
  });

  it('classifies a click with no observable effect separately', () => {
    const result = validateBrowserUseOutcome({
      verification: { success: false, reason: '点击后页面没有可验证变化' },
      completion: { complete: false },
      action: 'click',
    });
    expect(result).toMatchObject({ ok: false, code: 'ACTION_NO_EFFECT' });
  });

  it('accepts only when action verification and phase completion both pass', () => {
    expect(validateBrowserUseOutcome({
      verification: { success: true },
      completion: { complete: true },
      action: 'download_file',
    })).toEqual({ ok: true });
  });
});
