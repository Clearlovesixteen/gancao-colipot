import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  isAuthenticatedValue,
  normalizeRequirementTaskResult,
  UNAUTHENTICATED_RESPONSE,
} from './businessHelpers';
import type { RequirementTaskResult } from '../shared/documentTypes';

function fallbackResult(): RequirementTaskResult {
  return {
    documentIds: ['doc_1'],
    summary: 'fallback',
    modules: ['未分类'],
    tasks: [],
    milestones: [],
    missingInfo: ['缺少信息'],
    createdAt: 1,
  };
}

describe('businessHelpers', () => {
  it('identifies unauthenticated business state', () => {
    expect(isAuthenticatedValue(true)).toBe(true);
    expect(isAuthenticatedValue(false)).toBe(false);
    expect(isAuthenticatedValue('true')).toBe(false);
    expect(UNAUTHENTICATED_RESPONSE.code).toBe('UNAUTHENTICATED');
  });

  it('extracts json from markdown fenced responses', () => {
    expect(extractJsonObject('```json\n{"summary":"ok"}\n```')).toEqual({ summary: 'ok' });
    expect(extractJsonObject('前缀 {"summary":"ok"} 后缀')).toEqual({ summary: 'ok' });
    expect(extractJsonObject('no json')).toBeNull();
  });

  it('normalizes requirement task result with safe defaults', () => {
    const result = normalizeRequirementTaskResult({
      summary: '模型生成',
      modules: ['文件'],
      tasks: [{
        title: '支持 OCR',
        module: '文件',
        type: 'invalid',
        priority: 'P9',
        acceptanceCriteria: ['可识别图片'],
      }],
    }, fallbackResult(), ['doc_1']);

    expect(result.summary).toBe('模型生成');
    expect(result.tasks[0]).toMatchObject({
      title: '支持 OCR',
      type: 'unknown',
      priority: 'P2',
    });
  });
});
