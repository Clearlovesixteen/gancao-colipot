import { describe, expect, it } from 'vitest';
import { decideResearchScope } from './researchScopeDecider';

const page = {
  title: '甘草 Copilot 产品说明',
  textPreview: '本文介绍甘草 Copilot 的网页问答、资料分析和浏览器自动化能力。',
  collections: [],
  warnings: [],
};

describe('decideResearchScope', () => {
  it('keeps page-anchored questions in current-page mode', () => {
    const result = decideResearchScope({
      query: '请总结这篇文章的核心结论',
      context: page,
    });

    expect(result.mode).toBe('current_page');
  });

  it('suggests topic mode for cross-site comparisons', () => {
    const result = decideResearchScope({
      query: '把这个产品和其他网站的竞品做个比较',
      context: page,
    });

    expect(result.mode).toBe('suggest_topic');
    expect(result.missingInformation.join('')).toContain('其他网站');
  });

  it('suggests topic mode when the core entity is absent', () => {
    const result = decideResearchScope({
      query: '核实某供应商最近的处罚记录',
      context: page,
    });

    expect(result.mode).toBe('suggest_topic');
    expect(result.missingInformation.length).toBeGreaterThan(0);
  });

  it('suggests topic mode after deep follow-ups exceed page coverage', () => {
    const result = decideResearchScope({
      query: '它在海外市场具体采用了哪些渠道',
      context: page,
      followUpDepth: 4,
    });

    expect(result.mode).toBe('suggest_topic');
  });
});
