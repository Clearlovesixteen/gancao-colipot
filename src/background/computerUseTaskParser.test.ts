import { describe, expect, it } from 'vitest';
import { buildSearchUrl, parseComputerUseTask } from './computerUseTaskParser';

describe('computerUseTaskParser', () => {
  it('parses a Baidu search task from natural language', () => {
    const intent = parseComputerUseTask('帮我打开百度，输入豆哥牛逼，再点击搜索');

    expect(intent).toEqual(expect.objectContaining({
      startUrl: 'https://www.baidu.com/',
      siteName: 'baidu',
      actionType: 'search',
      query: '豆哥牛逼',
    }));
    expect(intent.successCriteria).toContain('豆哥牛逼');
  });

  it('normalizes explicit start URLs', () => {
    const intent = parseComputerUseTask('打开 example.com 搜索订单', 'www.example.com');

    expect(intent.startUrl).toBe('https://www.example.com');
  });

  it('builds search result URL for known engines', () => {
    const intent = parseComputerUseTask('打开百度，搜索豆哥牛逼');
    const url = buildSearchUrl(intent);

    expect(url).toBe('https://www.baidu.com/s?wd=%E8%B1%86%E5%93%A5%E7%89%9B%E9%80%BC');
  });

  it('keeps post search click intent for first result', () => {
    const intent = parseComputerUseTask('打开百度输入java,然后搜索，再点击第一个结果');

    expect(intent).toEqual(expect.objectContaining({
      actionType: 'search',
      query: 'java',
      postSearchAction: 'click_first_result',
      targetResultIndex: 1,
    }));
    expect(intent.successCriteria).toContain('点击');
  });

  it('keeps post search click intent for arbitrary result index', () => {
    const intent = parseComputerUseTask('打开百度，输入甘草医生，然后进入第三个搜索结果');

    expect(intent).toEqual(expect.objectContaining({
      actionType: 'search',
      query: '甘草医生',
      postSearchAction: 'click_first_result',
      targetResultIndex: 3,
    }));
    expect(intent.successCriteria).toContain('第3个结果');
  });

  it('parses numeric search result indexes', () => {
    const intent = parseComputerUseTask('打开百度搜索甘草医生，点击第10条搜索结果');

    expect(intent).toEqual(expect.objectContaining({
      query: '甘草医生',
      postSearchAction: 'click_first_result',
      targetResultIndex: 10,
    }));
  });
});
