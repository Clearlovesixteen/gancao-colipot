import type { BrowserActionType, BrowserUseErrorCode, ComputerUseVerificationResult } from '../shared/automationTypes';

export function validateBrowserUseOutcome(input: {
  verification: ComputerUseVerificationResult;
  completion: { complete: boolean; reason?: string };
  action: BrowserActionType | 'finish';
}):
  | { ok: true }
  | { ok: false; code: BrowserUseErrorCode; reason: string; retryable: boolean } {
  if (!input.verification.success) {
    const reason = input.verification.reason || input.verification.warning || '动作没有获得可验证结果。';
    if (input.verification.blocking && /(登录|验证码|权限)/.test(reason)) {
      return { ok: false, code: 'BLOCKED_BY_AUTH', reason, retryable: false };
    }
    if (input.action === 'download_file') {
      return { ok: false, code: 'DOWNLOAD_NOT_STARTED', reason, retryable: true };
    }
    return { ok: false, code: 'ACTION_NO_EFFECT', reason, retryable: !input.verification.blocking };
  }
  if (!input.completion.complete) {
    return {
      ok: false,
      code: 'OUTCOME_NOT_REACHED',
      reason: input.completion.reason || '动作已执行，但当前阶段目标尚未达成。',
      retryable: true,
    };
  }
  return { ok: true };
}
