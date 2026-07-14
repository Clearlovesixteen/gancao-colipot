import { describe, expect, it } from 'vitest';
import { AppError, inferAppErrorCode, sanitizeForPersistence, toAppErrorPayload } from './appErrors';

describe('appErrors', () => {
  it('maps runtime failures to stable user-facing codes and recovery', () => {
    const payload = toAppErrorPayload(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(payload.code).toBe('CONTENT_SCRIPT_UNAVAILABLE');
    expect(payload.retryable).toBe(true);
    expect(payload.recovery).toContain('刷新');
  });

  it('preserves explicit app error details without leaking secrets', () => {
    const payload = toAppErrorPayload(
      new AppError('TASK_BLOCKED', '目标被阻塞', { detail: { authorization: 'Bearer secret-token' } }),
      '失败',
      { secrets: ['secret-token'] },
    );
    expect(payload.code).toBe('TASK_BLOCKED');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('sanitizes nested task output before persistence', () => {
    const result = sanitizeForPersistence({ apiKey: 'key-secret', nested: 'Bearer abc.def' }, ['key-secret']);
    expect(JSON.stringify(result)).not.toContain('key-secret');
    expect(JSON.stringify(result)).not.toContain('abc.def');
  });

  it('recognizes authentication and OCR failures', () => {
    expect(inferAppErrorCode(new Error('当前未登录'))).toBe('UNAUTHENTICATED');
    expect(inferAppErrorCode(new Error('PaddleOCR 初始化失败'))).toBe('OCR_RUNTIME_ERROR');
  });
});
