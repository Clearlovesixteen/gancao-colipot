import { describe, expect, it } from 'vitest';
import { shouldRouteToDocumentQa } from './documentQaRouting';

describe('shouldRouteToDocumentQa', () => {
  it('routes document questions without intercepting messages that still contain new attachments', () => {
    expect(shouldRouteToDocumentQa('帮我总结这些资料里的风险')).toBe(true);
    expect(shouldRouteToDocumentQa('你好')).toBe(false);
    expect(shouldRouteToDocumentQa('总结这个附件', true)).toBe(false);
  });
});
