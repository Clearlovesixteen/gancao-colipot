const main = document.querySelector('#main');
const routeLabel = document.querySelector('#route-label');
const fixtureOptions = new URLSearchParams(window.location.search);

document.querySelectorAll('.menu-parent').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.closest('section');
    const children = section.querySelector('.menu-children');
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    children.hidden = expanded;
  });
});

document.querySelectorAll('.menu-child').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.menu-child').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const moduleName = button.closest('section').dataset.module;
    history.replaceState({}, '', `#/${encodeURIComponent(moduleName)}/inventory-warning`);
    routeLabel.textContent = `${moduleName} / 库存预警`;
    main.innerHTML = '<div class="empty">列表加载中...</div>';
    window.setTimeout(() => renderWarningList(moduleName), 450);
  });
});

document.querySelector('#file-center-link').addEventListener('click', () => {
  history.replaceState({}, '', '#/file-center');
  routeLabel.textContent = '文件中心';
  renderFileCenter();
});

function download(filename) {
  const anchor = document.createElement('a');
  anchor.href = `/download/${encodeURIComponent(filename)}`;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function renderWarningList(moduleName) {
  const exportAction = fixtureOptions.get('noExport') === '1'
    ? ''
    : '<button id="export-button" aria-label="导出库存预警">导 出</button>';
  main.innerHTML = `
    <h1>${moduleName}库存预警</h1>
    <div class="toolbar">${exportAction}</div>
    <table aria-label="库存预警列表">
      <thead><tr><th>商品</th><th>状态</th><th>操作</th></tr></thead>
      <tbody><tr><td>艾叶炭</td><td class="status">异常</td><td><button aria-label="下载第一条数据" title="下载" class="icon-button">⇩</button></td></tr></tbody>
    </table>`;
  document.querySelector('#export-button')?.addEventListener('click', () => download(`${moduleName}-库存预警.xlsx`));
  document.querySelector('.icon-button').addEventListener('click', () => download(`${moduleName}-第一条.xlsx`));
}

function renderFileCenter() {
  main.innerHTML = `
    <h1>文件中心</h1>
    <div class="form" role="form">
      <label>子系统<select id="subsystem" required><option value="">请选择</option><option>智慧药房WMS仓储</option><option>其他系统</option></select></label>
      <label>用户花名<input id="user-alias" placeholder="请输入用户花名" required /></label>
      <button id="search-button">查询</button>
    </div>
    <table aria-label="文件列表">
      <thead><tr><th>文件名</th><th>状态</th><th>用户花名</th><th>操作</th></tr></thead>
      <tbody id="file-rows"><tr><td colspan="4">请输入条件查询</td></tr></tbody>
    </table>`;
  document.querySelector('#search-button').addEventListener('click', () => {
    const subsystem = document.querySelector('#subsystem').value;
    const alias = document.querySelector('#user-alias').value;
    const rows = document.querySelector('#file-rows');
    if (subsystem === '智慧药房WMS仓储' && alias === '秋枫') {
      rows.innerHTML = `
        <tr><td>库存预警-秋枫-001.xlsx</td><td class="status">已生成</td><td>秋枫</td><td><button class="row-download icon-button" aria-label="下载文件" title="下载">⇩</button></td></tr>
        <tr><td>库存预警-秋枫-002.xlsx</td><td class="status">已生成</td><td>秋枫</td><td><button class="row-download icon-button" aria-label="下载文件" title="下载">⇩</button></td></tr>`;
      rows.querySelectorAll('.row-download').forEach((button, index) => button.addEventListener('click', () => download(`库存预警-秋枫-00${index + 1}.xlsx`)));
    } else {
      rows.innerHTML = '<tr><td colspan="4">暂无数据</td></tr>';
    }
  });
}
