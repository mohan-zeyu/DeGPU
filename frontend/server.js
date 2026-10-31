import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATIC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function send(req, res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Same-origin bridge to the Python service. Both listeners stay on loopback;
// browsers cannot select an arbitrary upstream or proxy external URLs.
function proxyApi(req, res, apiOrigin) {
  const origin = req.headers.origin;
  if (origin) {
    let expected;
    try { expected = new URL(origin); } catch { send(req, res, 403, 'Invalid origin'); return; }
    if (!['http:', 'https:'].includes(expected.protocol) || expected.host !== req.headers.host) {
      send(req, res, 403, 'Cross-origin request denied'); return;
    }
  }
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) { send(req, res, 413, 'Request too large'); return; }
  const headers = { host: apiOrigin.host, ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
    ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
    ...(req.method === 'POST' ? { 'x-degpu': '1' } : {}) };
  const upstream = http.request({ hostname: apiOrigin.hostname, port: apiOrigin.port || 80, path: req.url, method: req.method, headers }, response => {
    res.writeHead(response.statusCode, { 'Content-Type': response.headers['content-type'] || 'application/json',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(response.headers['content-disposition'] ? { 'Content-Disposition': response.headers['content-disposition'] } : {}) });
    response.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy(new Error('Backend timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) send(req, res, 502, JSON.stringify({ error: 'DeGPU 服务未连接。请在桌面 DeGPU-main 仓库启动：uv run degpu app --locked（默认端口 8700）。' }), 'application/json');
    else res.destroy();
  });
  let received = 0;
  req.on('data', chunk => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) { upstream.destroy(); if (!res.headersSent) send(req, res, 413, 'Request too large'); }
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

export function createDemoServer({ apiUrl = process.env.DEGPU_API_URL || 'http://127.0.0.1:8700' } = {}) {
  const apiOrigin = new URL(apiUrl);
  if (apiOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(apiOrigin.hostname)
      || apiOrigin.username || apiOrigin.password || apiOrigin.pathname !== '/' || apiOrigin.search || apiOrigin.hash) throw new Error('API URL must be a loopback HTTP origin.');
  const canonicalRoot = realpath(STATIC_ROOT);
  return http.createServer(async (req, res) => {
    let requestHost;
    try { requestHost = new URL(`http://${req.headers.host}`).hostname; } catch { send(req, res, 403, 'Invalid host'); return; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestHost)) { send(req, res, 403, 'Invalid host'); return; }
    if (req.url === '/api' || req.url?.startsWith('/api/')) { proxyApi(req, res, apiOrigin); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
      return;
    }

    let pathname;
    try {
      // Decode before path resolution so encoded separators cannot bypass traversal checks.
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      send(req, res, 400, 'Invalid request path');
      return;
    }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) {
      send(req, res, 403, 'Forbidden');
      return;
    }
    if (pathname.startsWith('/bridge/') || pathname === '/bridge' || pathname.split('/').some(part => part.startsWith('.'))) {
      send(req, res, 403, 'Forbidden');
      return;
    }
    if (pathname === '/health') {
      send(req, res, 200, JSON.stringify({ ok: true, mode: 'demo' }), 'application/json; charset=utf-8');
      return;
    }

    const candidate = path.resolve(STATIC_ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!isWithinRoot(STATIC_ROOT, candidate)) {
      send(req, res, 403, 'Forbidden');
      return;
    }

    try {
      const [root, target] = await Promise.all([canonicalRoot, realpath(candidate)]);
      if (!isWithinRoot(root, target)) {
        send(req, res, 403, 'Forbidden');
        return;
      }
      if (!(await stat(target)).isFile()) {
        send(req, res, 404, 'Not found');
        return;
      }
      const body = await readFile(target);
      send(req, res, 200, body, CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
    } catch (error) {
      const status = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 500;
      send(req, res, status, status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Server error');
    }
  });
}

function readPort(args) {
  let value = process.env.PORT || '5173';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') value = args[++i];
    else if (args[i].startsWith('--port=')) value = args[i].slice(7);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!/^\d+$/.test(value ?? '') || Number(value) > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  return Number(value);
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    const port = readPort(process.argv.slice(2));
    const server = createDemoServer();
    server.on('error', error => {
      console.error(`DeGPU server: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`DeGPU: http://127.0.0.1:${server.address().port} (API ${process.env.DEGPU_API_URL || 'http://127.0.0.1:8700'})`);
    });
  } catch (error) {
    console.error(`DeGPU server: ${error.message}`);
    process.exitCode = 1;
  }
}
