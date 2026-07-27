import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let monitorValue = '库存正常';

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function createFixtureModelAnswer(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const system = String(messages.find((item) => item?.role === 'system')?.content || '');
  if (/页面诊断助手/.test(system)) {
    return '问题摘要：测试页捕获到脚本错误。\n风险等级：中。\n可能原因：E2E fixture 主动触发错误。\n定位步骤：检查控制台错误来源。\n修复建议：修复对应脚本。\n需要补充的信息：无。';
  }
  if (/资料问答助手/.test(system)) {
    return '结论：资料要求保留来源引用。【来源：需求说明.md，第 2 页，验收标准】';
  }
  return '这是来自 E2E 模型夹具的流式回复。';
}

createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1:4173');
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const answer = createFixtureModelAnswer(payload);
      if (payload.stream === true) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const userContent = String(
          (Array.isArray(payload.messages) ? payload.messages : [])
            .filter((item) => item?.role === 'user')
            .at(-1)?.content || '',
        );
        const chunks = userContent.includes('LONG_STREAM_TEST')
          ? Array.from({ length: 80 }, (_, index) => `片段${index + 1} `)
          : Array.from(answer);
        let index = 0;
        const timer = setInterval(() => {
          if (index >= chunks.length) {
            clearInterval(timer);
            response.write(`data: ${JSON.stringify({
              id: 'chatcmpl-model-test',
              choices: [{ delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            response.write('data: [DONE]\n\n');
            response.end();
            return;
          }
          response.write(`data: ${JSON.stringify({
            id: 'chatcmpl-model-test',
            choices: [{ delta: { content: chunks[index] }, finish_reason: null }],
          })}\n\n`);
          index += 1;
        }, userContent.includes('LONG_STREAM_TEST') ? 80 : 10);
        response.on('close', () => clearInterval(timer));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-model-test',
        choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        model: payload.model,
      }));
    });
    return;
  }
  if (url.pathname === '/monitor/set') {
    monitorValue = url.searchParams.get('value') || '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, value: monitorValue }));
    return;
  }
  if (url.pathname === '/monitor.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html lang="zh-CN">
        <head><meta charset="utf-8"><title>库存监控测试页</title></head>
        <body>
          <main>
            <h1>库存状态</h1>
            <p id="monitor-value">${monitorValue}</p>
            <table><thead><tr><th>商品</th><th>库存</th></tr></thead>
              <tbody><tr><td>甘草</td><td>${monitorValue}</td></tr></tbody>
            </table>
          </main>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (url.pathname.startsWith('/download/')) {
    const filename = decodeURIComponent(url.pathname.split('/').pop() || 'report.xlsx');
    response.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    response.end('fixture workbook content');
    return;
  }

  const requested = url.pathname === '/' ? 'business.html' : url.pathname.replace(/^\//, '');
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  const sendFile = () => {
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  };
  const loadDelay = url.pathname === '/search-result.html'
    ? Math.max(0, Math.min(5000, Number(url.searchParams.get('loadDelay') || 0)))
    : 0;
  if (loadDelay) setTimeout(sendFile, loadDelay);
  else sendFile();
}).listen(4173, '127.0.0.1');
