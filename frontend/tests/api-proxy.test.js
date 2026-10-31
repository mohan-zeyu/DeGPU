import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDemoServer } from '../server.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('same-origin proxy preserves file data, account and API status; external origins are refused', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, body });
    res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'real-upload' }));
  });
  const upstreamUrl = await listen(upstream);
  const server = createDemoServer({ apiUrl: upstreamUrl });
  const url = await listen(server);
  try {
    const content = JSON.stringify({ name: 'a.jpg', data: 'AP8=', accountId: 'user-02' });
    const result = await fetch(`${url}/api/uploads?accountId=user-02`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: content });
    assert.equal(result.status, 201);
    assert.deepEqual(await result.json(), { id: 'real-upload' });
    assert.deepEqual(received, [{ url: '/api/uploads?accountId=user-02', body: content }]);
    assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal(received.length, 1);
    assert.equal((await fetch(`${url}/bridge/runtime.py`)).status, 403);
    assert.equal((await fetch(`${url}/.private`)).status, 403);
  } finally { await close(server); await close(upstream); }
});

test('unavailable execution service returns a visible error without fixture state', async () => {
  const temporary = http.createServer();
  const upstreamUrl = await listen(temporary); await close(temporary);
  const server = createDemoServer({ apiUrl: upstreamUrl });
  const url = await listen(server);
  try {
    const result = await fetch(`${url}/api/state`);
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /未连接/);
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally { await close(server); }
  assert.throws(() => createDemoServer({ apiUrl: 'http://example.com' }), /loopback/);
});
