import { describe, expect, it } from 'vitest';
import { inferMemoryType, isSensitiveMemoryContent } from './userMemoryStore';

describe('memory candidates', () => {
  it('only recognizes explicit reusable facts', () => {
    expect(inferMemoryType('我希望默认使用中文回答')).toBe('preference');
    expect(isSensitiveMemoryContent('api_key=sk-12345678901234567890')).toBe(true);
  });
});
