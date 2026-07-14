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

createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1:4173');
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-model-test',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        model: payload.model,
      }));
    });
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
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`,
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
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}).listen(4173, '127.0.0.1');
