import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteClient, createLiveAccountService } from '../src/remote-client.js';

const state = id => ({ network: { chainId: 31337 }, users: [
  { id: 'user-01', name: '本地账户 1', address: '0x01' },
  { id: 'user-02', name: '本地账户 2', address: '0x02' },
], account: { id }, providers: [], jobs: [], blocks: [], transactions: [] });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('live connection failures do not manufacture a demo network', async () => {
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async () => { throw new Error('RPC disconnected'); } });
  await assert.rejects(client.connect(), /RPC disconnected/);
  assert.equal(client.getState().network.mode, 'live');
  assert.equal(client.getState().network.connected, false);
  assert.deepEqual(client.getState().jobs, []);
  await assert.rejects(client.createJob({}), /未连接/);
});

test('invalid upstream responses explain which services need checking', async () => {
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async () => ({ status: 404, json: async () => { throw new SyntaxError('Not found'); } }) });
  await assert.rejects(client.connect(), /HTTP 404.*Python 服务/);
  assert.equal(client.getState().network.connected, false);
});

test('upload sends actual bytes, then task creation uses the returned upload IDs and account', async () => {
  const requests = [];
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('/api/state')) return response(state('user-01'));
    if (url.startsWith('/api/uploads')) return response({ id: 'upload-123' });
    return response({ id: 'replicated:7' });
  } });
  await client.connect();
  const file = new File([new Uint8Array([0, 255, 127, 1])], 'input.jpg');
  const upload = await client.uploadFile(file);
  const uploadBody = JSON.parse(requests.find(request => request.url.startsWith('/api/uploads')).options.body);
  assert.deepEqual([...Buffer.from(uploadBody.data, 'base64')], [0, 255, 127, 1]);
  assert.equal(uploadBody.accountId, 'user-01');
  assert.equal(await client.createJob({ taskType: 'image-classify-v1', provider: 'B', uploadIds: { images: [upload.id] } }), 'replicated:7');
  const jobBody = JSON.parse(requests.find(request => request.url.startsWith('/api/jobs')).options.body);
  assert.equal(jobBody.providerId, 'B');
  assert.deepEqual(jobBody.uploadIds.images, ['upload-123']);
});

test('switching local chain accounts cannot reuse demo credentials or accept an older account response', async () => {
  let release;
  let delayed = false;
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async url => {
    if (delayed && url.includes('accountId=user-01')) return new Promise(resolve => { release = () => resolve(response(state('user-01'))); });
    return response(state(url.includes('user-02') ? 'user-02' : 'user-01'));
  } });
  await client.connect();
  const auth = createLiveAccountService(client);
  delayed = true;
  const pending = client.refresh();
  await client.selectAccount('user-02');
  release(); await pending;
  assert.equal(auth.currentAccount().id, 'user-02');
  assert.throws(() => auth.register({}), /开发账户/);
});

test('background polling cannot supersede the snapshot confirming an account connection', async t => {
  let poll;
  t.mock.method(globalThis, 'setInterval', callback => { poll = callback; return 41; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const pending = [];
  let delayed = true;
  const client = createRemoteClient({ pollMs: 10, storage: null, fetcher: async url => {
    if (url.includes('accountId=user-02') && delayed) return new Promise(resolve => {
      pending.push(() => resolve(response(state('user-02'))));
    });
    return response(state(url.includes('user-02') ? 'user-02' : 'user-01'));
  } });
  await client.connect();
  const selection = client.selectAccount('user-02');
  const polling = poll();
  try {
    assert.equal(pending.length, 1, 'polling must pause while the selected account is being confirmed');
    pending.shift()();
    assert.equal((await selection).id, 'user-02');
    assert.equal(client.getState().account.id, 'user-02');
    delayed = false;
    await poll();
    assert.equal(client.getState().account.id, 'user-02');
  } finally {
    pending.forEach(release => release());
    await Promise.allSettled([selection, polling]);
    client.disconnect();
  }
});

test('a rejected account connection restores the previous request identity and saved selection', async () => {
  const saved = new Map();
  const requests = [];
  let rejectSelection = true;
  const client = createRemoteClient({ pollMs: 0,
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetcher: async url => {
      requests.push(url);
      if (url.includes('accountId=user-02') && rejectSelection) return response({ error: 'service unavailable' }, 503);
      return response(state(url.includes('user-02') ? 'user-02' : 'user-01'));
    },
  });
  await client.connect();
  await assert.rejects(client.selectAccount('user-02'), /service unavailable/);
  assert.equal(client.getState().account.id, 'user-01');
  assert.equal(saved.get('degpu.live.account'), 'user-01');
  rejectSelection = false;
  await client.refresh();
  assert.match(requests.at(-1), /accountId=user-01/);
  assert.equal(client.getState().account.id, 'user-01');
  assert.equal((await client.selectAccount('user-02')).id, 'user-02');
  assert.equal(saved.get('degpu.live.account'), 'user-02');
});

test('a confirmed task is not reported as failed when the following state refresh loses connectivity', async () => {
  let reads = 0;
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async url => {
    if (url.startsWith('/api/jobs')) return response({ id: 'checked:9' });
    if (++reads === 1) return response(state('user-01'));
    throw new Error('lost connection');
  } });
  await client.connect();
  assert.equal(await client.createJob({ provider: 'B' }), 'checked:9');
  assert.equal(client.getState().network.connected, false);
});

test('transaction rejection is surfaced rather than advancing local protocol state', async () => {
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async url => url.startsWith('/api/state')
    ? response(state('user-01')) : response({ error: 'execution reverted: NotClient' }, 403) });
  await client.connect();
  await assert.rejects(client.cancelJob('replicated:3'), /NotClient/);
  assert.equal(client.getState().jobs.length, 0);
  assert.throws(() => client.passDeadline('replicated:3'), /实际时间/);
});

test('provider automation uses the selected account and refreshes the server setting', async () => {
  const requests = [];
  let automatic = true;
  const snapshot = () => ({ ...state('user-01'), network: { chainId: 31337, providerAutomation: true },
    providers: [{ id: 'A', ownerId: 'user-01', autoProcess: automatic }, { id: 'B', ownerId: 'user-02' }] });
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('/api/state')) return response(snapshot());
    if (url.startsWith('/api/providers/A/automation')) {
      automatic = JSON.parse(options.body).enabled;
      return response({ providerId: 'A', autoProcess: automatic });
    }
    return response({ providerId: 'A', progressed: true });
  } });
  await client.connect();
  assert.deepEqual(await client.setProviderAutomation({ providerId: 'A', enabled: false }), { providerId: 'A', autoProcess: false });
  assert.equal(client.getState().providers[0].autoProcess, false);
  assert.deepEqual(await client.processProvider({ providerId: 'A' }), { providerId: 'A', progressed: true });
  const automation = requests.find(request => request.url.startsWith('/api/providers/A/automation'));
  assert.equal(automation.options.method, 'POST');
  assert.deepEqual(JSON.parse(automation.options.body), { enabled: false, accountId: 'user-01' });
  const process = requests.find(request => request.url.startsWith('/api/providers/A/process'));
  assert.deepEqual(JSON.parse(process.options.body), { accountId: 'user-01' });
  const before = requests.length;
  await assert.rejects(client.setProviderAutomation({ providerId: 'B', enabled: false }), /自己的机器/);
  await assert.rejects(client.processProvider({ providerId: 'unknown' }), /自己的机器/);
  await assert.rejects(client.setProviderAutomation({ providerId: 'A', enabled: 'false' }), /布尔值/);
  assert.equal(requests.length, before);
});

test('old services cannot pretend to save automation and failed writes preserve the server setting', async () => {
  let capable = false;
  let writes = 0;
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async url => {
    if (url.startsWith('/api/state')) return response({ ...state('user-01'), network: { providerAutomation: capable }, providers: [{ id: 'A', ownerId: 'user-01', autoProcess: true }] });
    writes++;
    return response({ error: 'provider busy' }, 409);
  } });
  await client.connect();
  await assert.rejects(client.setProviderAutomation({ providerId: 'A', enabled: false }), /尚未支持/);
  await assert.rejects(client.processProvider({ providerId: 'A' }), /尚未支持/);
  assert.equal(writes, 0);
  capable = true;
  await client.refresh();
  await assert.rejects(client.setProviderAutomation({ providerId: 'A', enabled: false }), /provider busy/);
  assert.equal(client.getState().providers[0].autoProcess, true);
});

test('account changes during provider operations retain the original authorization and current view', async () => {
  let release;
  let sent;
  const client = createRemoteClient({ pollMs: 0, storage: null, fetcher: async (url, options) => {
    if (url.startsWith('/api/state')) {
      const account = url.includes('user-02') ? 'user-02' : 'user-01';
      return response({ ...state(account), network: { providerAutomation: true }, providers: [{ id: 'A', ownerId: 'user-01', autoProcess: true }] });
    }
    sent = JSON.parse(options.body);
    return new Promise(resolve => { release = () => resolve(response({ providerId: 'A', autoProcess: false })); });
  } });
  await client.connect();
  const pending = client.setProviderAutomation({ providerId: 'A', enabled: false });
  await client.selectAccount('user-02');
  release();
  await pending;
  assert.equal(sent.accountId, 'user-01');
  assert.equal(client.getState().account.id, 'user-02');
  await assert.rejects(client.processProvider({ providerId: 'A' }), /自己的机器/);
});
