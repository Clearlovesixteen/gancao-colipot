import { beforeEach, describe, expect, it } from 'vitest';
import { extractPageFields, extractPageStructuredData, extractPageTables, getConsoleErrors, handleToolExecution, observePage, recordConsoleError } from './tools';

describe('page extractor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts standard tables', () => {
    document.body.innerHTML = `
      <table id="orders">
        <tr><th>订单</th><th>金额</th></tr>
        <tr><td>A001</td><td>100</td></tr>
      </table>
    `;

    const result = extractPageTables();

    expect(result.tables[0].headers).toEqual(['订单', '金额']);
    expect(result.tables[0].rows).toEqual([['A001', '100']]);
  });

  it('extracts Ant Design tables', () => {
    document.body.innerHTML = `
      <div class="ant-table">
        <table>
          <thead class="ant-table-thead"><tr><th>姓名</th><th>状态</th></tr></thead>
          <tbody class="ant-table-tbody"><tr><td>李四</td><td>已完成</td></tr></tbody>
        </table>
      </div>
    `;

    const result = extractPageTables();

    expect(result.tables.some((table: any) => table.title.includes('AntD'))).toBe(true);
  });

  it('extracts label-value fields and filters hidden text', () => {
    document.body.innerHTML = `
      <label for="name">姓名</label><input id="name" value="王五" />
      <dl><dt>科室</dt><dd>内科</dd></dl>
      <div style="display:none">隐藏字段：不要出现</div>
      <p>编号：NO-1</p>
    `;

    const result = extractPageFields();
    const labels = result.fields.map((field: any) => field.label);

    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '姓名', value: '王五' }),
      expect.objectContaining({ label: '科室', value: '内科' }),
      expect.objectContaining({ label: '编号', value: 'NO-1' }),
    ]));
    expect(labels).not.toContain('隐藏字段');
  });

  it('returns empty structured data instead of throwing on empty pages', () => {
    const result = extractPageStructuredData();

    expect(result.fields).toEqual([]);
    expect(result.tables).toEqual([]);
    expect(result.lists).toEqual([]);
  });

  it('returns captured console errors', () => {
    const since = Date.now();
    recordConsoleError({
      source: 'console.error',
      level: 'error',
      message: 'test console failure',
      stack: 'Error: test console failure',
    });

    const result = getConsoleErrors({ since, limit: 5 });

    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.errors[result.errors.length - 1]).toEqual(expect.objectContaining({
      source: 'console.error',
      message: 'test console failure',
    }));
  });

  it('observes interactive elements with stable element ids', async () => {
    document.body.innerHTML = `
      <button id="save">保存</button>
      <input aria-label="姓名" value="王五" />
      <a href="/detail">详情</a>
    `;

    const result = await observePage({ limit: 10 });

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'button', text: '保存', enabled: true }),
      expect.objectContaining({ role: 'textbox', value: '王五' }),
      expect.objectContaining({ role: 'link', text: '详情' }),
    ]));
    expect(result.elements[0].elementId).toMatch(/^el_/);
  });

  it('marks search inputs and buttons in page observation', async () => {
    document.body.innerHTML = `
      <form>
        <input id="kw" name="wd" aria-label="搜索" />
        <input id="su" type="submit" value="百度一下" />
      </form>
    `;

    const result = await observePage({ limit: 10 });

    expect(result.pageState).toEqual(expect.objectContaining({
      kind: 'search_page',
      searchInputId: expect.any(String),
      searchButtonId: expect.any(String),
    }));
    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: 'search_input', score: 0.98 }),
      expect.objectContaining({ purpose: 'search_button', score: 0.98 }),
    ]));
  });

  it('observes sidebar menu items for business navigation', async () => {
    document.body.innerHTML = `
      <aside class="ant-layout-sider">
        <div class="ant-menu-item">基础设置</div>
        <div class="ant-menu-submenu-title">颗粒剂管理</div>
        <div class="ant-menu-item">库存预警</div>
      </aside>
    `;

    const result = await observePage({ limit: 20 });

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '颗粒剂管理', purpose: 'menu_item', level: expect.any(Number) }),
      expect.objectContaining({ text: '库存预警', purpose: 'menu_item' }),
    ]));
  });

  it('marks active menu and icon-like export buttons in observation', async () => {
    document.body.innerHTML = `
      <aside class="ant-layout-sider">
        <div class="ant-menu-item ant-menu-item-selected" aria-selected="true">库存预警</div>
      </aside>
      <main>
        <button class="ant-btn" title="导出 Excel"><span role="img" aria-label="download"></span></button>
      </main>
    `;

    const result = await observePage({ limit: 20 });

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '库存预警', purpose: 'menu_item', active: true }),
      expect.objectContaining({ purpose: 'download_button' }),
    ]));
  });

  it('keeps spaced export buttons even when many earlier candidates exist', async () => {
    document.body.innerHTML = `
      <main>
        ${Array.from({ length: 30 }, (_, index) => `<button>普通操作 ${index}</button>`).join('')}
        <button class="ant-btn">导 出</button>
      </main>
    `;

    const result = await observePage({ limit: 5 });

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '导 出', purpose: 'download_button' }),
    ]));
  });

  it('can observe deep sidebar items beyond the old 200 element cap', async () => {
    document.body.innerHTML = `
      <aside class="ant-layout-sider">
        ${Array.from({ length: 230 }, (_, index) => `<div class="nav-item leaf">普通菜单 ${index}</div>`).join('')}
        <div class="nav-item leaf">库存预警</div>
      </aside>
    `;

    const result = await observePage({ limit: 260 });

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '库存预警', purpose: 'menu_item' }),
    ]));
  });

  it('clicks the first real Baidu result instead of hao123 navigation', async () => {
    document.body.innerHTML = `
      <input id="kw" name="wd" value="菜鸟" />
      <div id="s-top-left"><a id="hao" href="https://www.hao123.com/">hao123</a></div>
      <div id="content_left">
        <div class="result">
          <h3><a id="first" target="_blank" href="https://www.baidu.com/link?url=cainiao">菜鸟集团-电商物流行业的全球领导者</a></h3>
          <div>菜鸟集团官网介绍</div>
        </div>
      </div>
    `;
    const input = document.querySelector('#kw') as HTMLElement;
    const hao = document.querySelector('#hao') as HTMLElement;
    const first = document.querySelector('#first') as HTMLElement;
    input.getBoundingClientRect = () => ({ x: 120, y: 18, width: 600, height: 44, top: 18, left: 120, right: 720, bottom: 62, toJSON: () => {} }) as DOMRect;
    hao.getBoundingClientRect = () => ({ x: 520, y: 34, width: 56, height: 20, top: 34, left: 520, right: 576, bottom: 54, toJSON: () => {} }) as DOMRect;
    first.getBoundingClientRect = () => ({ x: 150, y: 126, width: 390, height: 26, top: 126, left: 150, right: 540, bottom: 152, toJSON: () => {} }) as DOMRect;

    let clicked = '';
    hao.addEventListener('click', () => { clicked = 'hao123'; });
    first.addEventListener('click', () => {
      clicked = first.getAttribute('target') || '';
    });

    const results = await handleToolExecution('get_search_results', { limit: 3 });
    expect(results.results[0]).toEqual(expect.objectContaining({
      title: '菜鸟集团-电商物流行业的全球领导者',
      text: '菜鸟集团-电商物流行业的全球领导者',
      url: 'https://www.baidu.com/link?url=cainiao',
      elementId: expect.stringMatching(/^el_/),
    }));

    const result = await handleToolExecution('click_search_result', { index: 1 });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      text: '菜鸟集团-电商物流行业的全球领导者',
      href: 'https://www.baidu.com/link?url=cainiao',
    }));
    expect(clicked).toBe('');
    expect(first.getAttribute('target')).toBe('_blank');
  });

  it('filters hao123-like Baidu link redirects from natural search results', async () => {
    document.body.innerHTML = `
      <input id="kw" name="wd" value="123" />
      <div id="content_left">
        <div class="result">
          <h3><a id="bad" href="https://www.baidu.com/link?url=from_pc_logon_hao123">hao123_上网从这里开始</a></h3>
        </div>
        <div class="result">
          <h3><a id="first" href="https://www.baidu.com/link?url=real-first-result">123 官方信息</a></h3>
          <div>真正的第一个自然结果</div>
        </div>
      </div>
    `;
    const input = document.querySelector('#kw') as HTMLElement;
    const bad = document.querySelector('#bad') as HTMLElement;
    const first = document.querySelector('#first') as HTMLElement;
    input.getBoundingClientRect = () => ({ x: 120, y: 18, width: 600, height: 44, top: 18, left: 120, right: 720, bottom: 62, toJSON: () => {} }) as DOMRect;
    bad.getBoundingClientRect = () => ({ x: 150, y: 126, width: 300, height: 26, top: 126, left: 150, right: 450, bottom: 152, toJSON: () => {} }) as DOMRect;
    first.getBoundingClientRect = () => ({ x: 150, y: 172, width: 260, height: 26, top: 172, left: 150, right: 410, bottom: 198, toJSON: () => {} }) as DOMRect;

    let clicked = '';
    bad.addEventListener('click', () => { clicked = 'bad'; });
    first.addEventListener('click', () => { clicked = 'first'; });

    const results = await handleToolExecution('get_search_results', { limit: 3 });
    expect(results.results.map((result: any) => result.text)).toEqual(['123 官方信息']);

    const result = await handleToolExecution('click_search_result', { index: 1 });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      text: '123 官方信息',
      href: 'https://www.baidu.com/link?url=real-first-result',
    }));
    expect(clicked).toBe('');
  });

  it('counts search result blocks instead of nested links inside the first block', async () => {
    document.body.innerHTML = `
      <input id="kw" name="wd" value="甘草医生" />
      <div id="content_left">
        <div class="result" id="r1">
          <h3><a id="main1" href="https://www.baidu.com/link?url=main-1">甘草医生-官方结果</a></h3>
          <a id="sub1" href="https://www.baidu.com/link?url=sub-1">关于我们</a>
          <a id="sub2" href="https://www.baidu.com/link?url=sub-2">新闻动态</a>
        </div>
        <div class="result" id="r2">
          <h3><a id="main2" href="https://www.baidu.com/link?url=main-2">甘草医生 第二个结果</a></h3>
        </div>
        <div class="result" id="r3">
          <h3><a id="main3" href="https://www.baidu.com/link?url=main-3">甘草医生 第三个结果</a></h3>
        </div>
      </div>
    `;
    const input = document.querySelector('#kw') as HTMLElement;
    input.getBoundingClientRect = () => ({ x: 120, y: 18, width: 600, height: 44, top: 18, left: 120, right: 720, bottom: 62, toJSON: () => {} }) as DOMRect;
    ['main1', 'sub1', 'sub2'].forEach((id, index) => {
      const el = document.querySelector(`#${id}`) as HTMLElement;
      el.getBoundingClientRect = () => ({ x: 150 + index * 20, y: 126 + index * 18, width: 280, height: 24, top: 126 + index * 18, left: 150, right: 430, bottom: 150 + index * 18, toJSON: () => {} }) as DOMRect;
    });
    const main2 = document.querySelector('#main2') as HTMLElement;
    const main3 = document.querySelector('#main3') as HTMLElement;
    main2.getBoundingClientRect = () => ({ x: 150, y: 226, width: 280, height: 24, top: 226, left: 150, right: 430, bottom: 250, toJSON: () => {} }) as DOMRect;
    main3.getBoundingClientRect = () => ({ x: 150, y: 326, width: 280, height: 24, top: 326, left: 150, right: 430, bottom: 350, toJSON: () => {} }) as DOMRect;
    ['r1', 'r2', 'r3'].forEach((id, index) => {
      const el = document.querySelector(`#${id}`) as HTMLElement;
      el.getBoundingClientRect = () => ({ x: 140, y: 120 + index * 100, width: 520, height: 80, top: 120 + index * 100, left: 140, right: 660, bottom: 200 + index * 100, toJSON: () => {} }) as DOMRect;
    });

    const results = await handleToolExecution('get_search_results', { limit: 5 });

    expect(results.results.map((result: any) => result.text)).toEqual([
      '甘草医生-官方结果',
      '甘草医生 第二个结果',
      '甘草医生 第三个结果',
    ]);

    const clicked = await handleToolExecution('click_search_result', { index: 3 });

    expect(clicked).toEqual(expect.objectContaining({
      success: true,
      index: 3,
      text: '甘草医生 第三个结果',
      href: 'https://www.baidu.com/link?url=main-3',
    }));
  });

  it('extracts YouTube video search results as ordered result blocks', async () => {
    document.body.innerHTML = `
      <input id="search" type="search" value="贝爷" />
      <nav><a id="home" href="https://www.youtube.com/">首页</a></nav>
      <ytd-video-renderer id="v1">
        <a id="video-title" href="https://www.youtube.com/watch?v=one" title="贝爷荒野求生 第一集">贝爷荒野求生 第一集</a>
        <div class="metadata">100万次观看</div>
      </ytd-video-renderer>
      <ytd-video-renderer id="v2">
        <a id="video-title" href="https://www.youtube.com/watch?v=two" title="贝爷荒野求生 第二集">贝爷荒野求生 第二集</a>
      </ytd-video-renderer>
      <ytd-video-renderer id="v3">
        <a id="video-title" href="https://www.youtube.com/watch?v=three" title="贝爷荒野求生 第三集">贝爷荒野求生 第三集</a>
      </ytd-video-renderer>
    `;
    const input = document.querySelector('#search') as HTMLElement;
    input.getBoundingClientRect = () => ({ x: 180, y: 20, width: 600, height: 40, top: 20, left: 180, right: 780, bottom: 60, toJSON: () => {} }) as DOMRect;
    const home = document.querySelector('#home') as HTMLElement;
    home.getBoundingClientRect = () => ({ x: 20, y: 20, width: 40, height: 20, top: 20, left: 20, right: 60, bottom: 40, toJSON: () => {} }) as DOMRect;
    ['v1', 'v2', 'v3'].forEach((id, index) => {
      const container = document.querySelector(`#${id}`) as HTMLElement;
      const anchor = container.querySelector('a') as HTMLElement;
      const y = 120 + index * 120;
      container.getBoundingClientRect = () => ({ x: 120, y, width: 760, height: 100, top: y, left: 120, right: 880, bottom: y + 100, toJSON: () => {} }) as DOMRect;
      anchor.getBoundingClientRect = () => ({ x: 220, y: y + 12, width: 420, height: 26, top: y + 12, left: 220, right: 640, bottom: y + 38, toJSON: () => {} }) as DOMRect;
    });

    const results = await handleToolExecution('get_search_results', { limit: 5 });

    expect(results.results.map((result: any) => result.text)).toEqual([
      '贝爷荒野求生 第一集',
      '贝爷荒野求生 第二集',
      '贝爷荒野求生 第三集',
    ]);

    const clicked = await handleToolExecution('click_search_result', { index: 1 });

    expect(clicked).toEqual(expect.objectContaining({
      success: true,
      index: 1,
      text: '贝爷荒野求生 第一集',
      href: 'https://www.youtube.com/watch?v=one',
    }));
  });
});
