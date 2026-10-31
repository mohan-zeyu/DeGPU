import { test } from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import http from 'node:http';
import { createNetworkClient, ethToWei, weiToEth } from '../src/network-client.js';
import { applyProviderBehavior } from '../src/provider-presentation.js';
import { createDemoServer } from '../server.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const wallet = { name: 'alice', address: ALICE };
const tasks = [
  { name: 'image-classify-v1', mode: 'replicated', task_id: 2, default_price_wei: '100000000000000', runs_here: true, result: 'value', fields: [{ name: 'model', type: 'file' }, { name: 'images', type: 'files' }, { name: 'limit', type: 'int', default: 200 }] },
  { name: 'key-search-v1', mode: 'checked', task_id: 1, default_price_wei: '100000000000000', runs_here: true, result: 'value', fields: [{ name: 'keys', type: 'int', default: 10 }, { name: 'bits', type: 'int', default: 16 }, { name: 'impossible', type: 'int', default: 0 }] },
  { name: 'blender-render-v1', mode: 'replicated', task_id: 1, default_price_wei: '1000000000000000', runs_here: false, result: 'file', fields: [{ name: 'scene', type: 'file' }, { name: 'frames', type: 'str', default: '1-12' }] },
];
const provider = { address: BOB, registered: true, active: true, stake_wei: '1000000000000000001', open_jobs: 2,
  prices_wei: { 'image-classify-v1': '100000000000001', 'key-search-v1': '100000000000000', 'blender-render-v1': '0' },
  record: { replicated: { verified_completed: 7, unverified_completed: 4, checks_completed: 2, missed: 1 }, checked: { completed: 8, items_solved: 17, items_not_found: 1 } },
};
const closedJob = { ref: 'checked:1', id: 1, mode: 'checked', task: 'key-search-v1', role: 'client', status: 'closed', outcome: 'delivered', closed: true, client: ALICE, main: BOB, num_items: 2, deposit_wei: '200000000000000', deadline: 1792920285, solved: 1,
  timeline: [{ event: 'JobCreated', block: 20, time: 1792919980, args: { client: ALICE, main: BOB } }, { event: 'JobAccepted', block: 21, time: 1792919981, args: {} },
    { event: 'ResultsSubmitted', block: 22, time: 1792919982, args: { solved: 1 } }, { event: 'Payout', block: 22, time: 1792919982, args: { to: ALICE, amount: '100000000000000' } },
    { event: 'Payout', block: 22, time: 1792919982, args: { to: BOB, amount: '100000000000000' } }, { event: 'JobClosed', block: 22, time: 1792919982, args: { outcome: 2 } }],
};

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
function fixture({ unlocked = true, jobs = [], handler, storage } = {}) {
  const requests = [];
  const values = {
    '/api/status': { unlocked, wallet: unlocked ? wallet : null, network: { url: 'http://192.168.1.20:8600', name: 'DeGPU', chain_id: 31337 }, serving: true },
    '/api/wallets': [wallet, { name: 'bob', address: BOB }],
    '/api/account': { address: ALICE, balance_wei: '2000000000000000001' },
    '/api/tasks': tasks, '/api/providers': [provider],
    '/api/provider': { ...provider, address: ALICE, serving: true, behavior: 'honest', min_stake_wei: '800000000000000000' },
    '/api/jobs': jobs, '/api/activity': [{ seq: 1, time: 1792919980, message: 'posted job' }],
    '/api/jobs/checked%3A1': closedJob,
  };
  const fetcher = async (path, options) => {
    requests.push({ path, ...options });
    const handled = await handler?.(path, options, values);
    if (handled) return handled;
    if (!(path in values)) throw new Error(`Unexpected API request: ${path}`);
    return response(values[path]);
  };
  return { client: createNetworkClient({ fetcher, pollMs: 0, storage }), requests, values, fetcher };
}

test('locked app is reachable without pretending that local wallets are unlocked accounts', async () => {
  const { client, requests } = fixture({ unlocked: false });
  const state = await client.connect();
  assert.equal(state.network.connected, true);
  assert.equal(state.network.joined, false);
  assert.equal(state.unlocked, false);
  assert.equal(state.wallets.length, 2);
  assert.deepEqual(state.users, []);
  assert.deepEqual(state.account, {});
  assert.deepEqual(requests.map(entry => entry.path), ['/api/status', '/api/wallets']);
  await assert.rejects(client.createJob({}), /先解锁/);
  assert.throws(() => client.selectAccount('bob'), /需要密码/);
});

test('live data uses exact wei, on-chain counters and actual events, with no invented transactions or hardware', async () => {
  const { client, requests } = fixture({ jobs: [closedJob] });
  const state = await client.connect();
  assert.equal(state.users.length, 1);
  assert.equal(state.account.id, ALICE);
  assert.equal(state.account.balance, '2.000000000000000001');
  assert.equal(state.providers[0].stake, '1.000000000000000001');
  assert.equal(state.providers[0].offers['image-classify-v1'], '0.000100000000000001');
  assert.deepEqual(state.providers[0].record, provider.record);
  assert.equal(state.providers[0].verified, 7);
  assert.equal(state.providers[0].statsByMode.checked.itemsSolved, 17);
  const job = state.jobs[0];
  assert.equal(job.id, 'checked:1');
  assert.equal(job.chainJobId, 1);
  assert.equal(job.phase, 'Closed');
  assert.equal(job.outcome, 'Delivered');
  assert.equal(job.events[0].blockNumber, 20);
  assert.equal(job.events[0].timestamp, 1792919980);
  assert.equal(job.events[0].transactionHash, undefined);
  assert.equal(job.settlement.clientNet, '-0.0001');
  assert.equal(job.settlement.main, '0.0001');
  assert.equal(state.network.historyComplete, false);
  assert.deepEqual(state.transactions, []);
  assert.deepEqual(state.blocks, []);
  assert.deepEqual(state.telemetry.providers, []);
  state.jobs[0].events[0].args.client = 'changed outside the client';
  assert.equal(client.getState().jobs[0].events[0].args.client, ALICE);
  await client.refresh();
  assert.equal(requests.filter(entry => entry.path === '/api/jobs/checked%3A1').length, 1, 'closed timelines are cached instead of scanning every poll');
});

test('a local clock ahead of the chain cannot turn a running job into a timeout before successful delivery', async t => {
  t.mock.method(Date, 'now', () => 4102444800000);
  const running = { ...closedJob, closed: false, status: 'working', outcome: 'none', deadline: 1792927878,
    timeline: [
      { event: 'JobCreated', block: 27, time: 1792927561, args: {} },
      { event: 'JobAccepted', block: 28, time: 1792927562, args: {} },
    ] };
  const { client, values } = fixture({ jobs: [running] });
  values['/api/jobs/checked%3A1'] = running;
  const state = await client.connect();
  assert.equal(state.network.timestamp, null, 'the API does not provide a current chain clock');
  assert.equal(state.jobs[0].deadlinePassed, false);
  assert.equal(state.jobs[0].status, '搜索中');
  assert.equal(state.jobs[0].nextAction, 'wait');
  values['/api/jobs/checked%3A1'] = { ...closedJob, deadline: running.deadline };
  await client.refresh();
  assert.equal(client.getState().jobs[0].status, '交付完成');
  assert.equal(client.getState().jobs[0].deadlinePassed, false);
});

test('a closed summary without its closing event is reloaded until settlement is confirmed', async () => {
  const incomplete = { ...closedJob, timeline: closedJob.timeline.slice(0, 2) };
  const { client, values, requests } = fixture({ jobs: [incomplete] });
  values['/api/jobs/checked%3A1'] = incomplete;
  await client.connect();
  assert.equal(client.getState().jobs[0].settlement, null);
  values['/api/jobs/checked%3A1'] = closedJob;
  await client.refresh();
  assert.equal(client.getState().jobs[0].settlement.clientNet, '-0.0001');
  await client.refresh();
  assert.equal(requests.filter(entry => entry.path === '/api/jobs/checked%3A1').length, 2);
});

test('only valid chain time strictly after the cutoff enables timeout handling, and closure wins', async () => {
  const running = { ...closedJob, closed: false, status: 'working', outcome: 'none', timeline: [] };
  const { client, values } = fixture({ jobs: [running] });
  values['/api/jobs/checked%3A1'] = running;
  for (const time of [null, '', false, 'not a timestamp', running.deadline * 1000, running.deadline]) {
    values['/api/status'].chain_timestamp = time;
    await client.refresh();
    assert.equal(client.getState().jobs[0].deadlinePassed, false);
  }
  values['/api/status'].chain_timestamp = running.deadline + 1;
  await client.refresh();
  assert.equal(client.getState().jobs[0].status, '到期待处理');
  assert.equal(client.getState().jobs[0].nextAction, 'expire');
  values['/api/jobs/checked%3A1'] = { ...closedJob, outcome: 'main_missed',
    timeline: [{ event: 'JobClosed', block: 23, time: running.deadline + 1, args: { outcome: 3 } }] };
  await client.refresh();
  assert.equal(client.getState().jobs[0].status, '提供方超时');
  assert.equal(client.getState().jobs[0].closed, true);
  assert.equal(client.getState().jobs[0].deadlinePassed, false);
  assert.equal(client.getState().jobs[0].nextAction, null);
});

test('unconfirmed events and newer records from another task cannot expire an older task snapshot', async () => {
  const running = { ...closedJob, ref: 'checked:4', id: 4, closed: false, status: 'working', outcome: 'none', deadline: 1000,
    timeline: [
      { event: 'JobCreated', block: 1, time: 100, args: {} },
      { event: 'JobAccepted', block: 2, time: 200, args: {} },
      { event: 'ResultsSubmitted', block: 3, time: 2000, confirmed: false, args: {} },
      { event: 'ResultsSubmitted', block: 4, time: 2001, status: '0x0', args: {} },
    ] };
  const { client, values } = fixture({ jobs: [running, closedJob] });
  values['/api/jobs/checked%3A4'] = running;
  const state = await client.connect();
  assert.equal(state.jobs[0].observedChainTimestamp, 200);
  assert.equal(state.jobs[0].deadlinePassed, false);
  assert.equal(state.jobs[0].status, '搜索中');
});

test('a registry replacement on the same host discards cached closed task snapshots', async () => {
  const { client, values, requests } = fixture({ jobs: [closedJob] });
  values['/api/status'].network.registry = 'old-registry';
  await client.connect();
  values['/api/status'].network.registry = 'new-registry';
  values['/api/jobs/checked%3A1'] = { ...closedJob, closed: false, status: 'working', outcome: 'none', timeline: [] };
  await client.refresh();
  assert.equal(requests.filter(entry => entry.path === '/api/jobs/checked%3A1').length, 2);
  assert.equal(client.getState().jobs[0].status, '搜索中');
  assert.equal(client.getState().jobs[0].deadlinePassed, false);
});

test('confirmed acceptance advances a stale Open summary without using its old deadline', async () => {
  for (const [mode, task, phase, label] of [
    ['checked', 'key-search-v1', 'Working', '搜索中'],
    ['replicated', 'image-classify-v1', 'Committing', '计算中'],
  ]) {
    const running = { ...closedJob, ref: `${mode}:4`, id: 4, mode, task,
      closed: false, status: 'open', outcome: 'none', deadline: 300,
      timeline: [{ event: 'JobCreated', block: 1, time: 100, args: {} },
        { event: 'JobAccepted', block: 2, time: 200, args: {} }] };
    const { client, values } = fixture({ jobs: [running] });
    const path = `/api/jobs/${encodeURIComponent(running.ref)}`;
    values[path] = running;
    values['/api/status'].chain_timestamp = 400;
    const { jobs: [job] } = await client.connect();
    assert.equal(job.chainStatus, 'open');
    assert.equal(job.chainOutcome, 'none');
    assert.equal(job.phase, phase);
    assert.equal(job.status, label);
    assert.equal(job.closed, false);
    assert.equal(job.deadline, null, 'the stale acceptance cutoff must not be shown as the work cutoff');
    assert.equal(job.deadlinePending, true);
    assert.equal(job.deadlinePassed, false);
    assert.equal(job.nextAction, 'wait');
    values[path] = { ...running, status: phase.toLowerCase(), deadline: 600 };
    await client.refresh();
    assert.equal(client.getState().jobs[0].deadline, 600);
    assert.equal(client.getState().jobs[0].deadlinePending, false);
  }
});

test('confirmed closure overrides stale status and uses each market outcome enum for settlement', async () => {
  for (const [mode, code, outcome, label] of [
    ['checked', 2, 'Delivered', '交付完成'],
    ['checked', 3, 'MainMissed', '提供方超时'],
    ['replicated', 8, 'MainMissed', '提供方超时'],
  ]) {
    const delivered = outcome === 'Delivered';
    const closing = { ...closedJob, ref: `${mode}:4`, id: 4, mode,
      closed: false, status: 'open', outcome: 'none', deadline: 150,
      timeline: [{ event: 'JobCreated', block: 1, time: 100, args: {} },
        { event: 'JobAccepted', block: 2, time: 110, args: {} },
        { event: 'Payout', block: 3, time: 200, args: { to: delivered ? BOB : ALICE, amount: '200000000000000' } },
        { event: 'Payout', block: 3, time: 200, status: '0x0', args: { to: BOB, amount: '999999999999999' } },
        { event: 'JobClosed', block: 3, time: 200, args: { outcome: code } }] };
    const { client, values } = fixture({ jobs: [closing] });
    values[`/api/jobs/${encodeURIComponent(closing.ref)}`] = closing;
    const { jobs: [job] } = await client.connect();
    assert.equal(job.chainStatus, 'open');
    assert.equal(job.chainOutcome, 'none');
    assert.equal(job.phase, 'Closed');
    assert.equal(job.closed, true);
    assert.equal(job.outcome, outcome);
    assert.equal(job.status, label);
    assert.equal(job.deadlinePassed, false);
    assert.equal(job.nextAction, null);
    assert.equal(job.settlement.main, delivered ? '0.0002' : '0.000');
    assert.equal(job.settlement.refund, delivered ? '0.000' : '0.0002');
    assert.equal(job.progress.settle, 'done');
  }
});

test('unconfirmed or failed acceptance and closure cannot advance a live task snapshot', async () => {
  for (const rejection of [{ confirmed: false }, { status: 0 }, { status: '0x0' }, { status: 'reverted' }]) {
    const running = { ...closedJob, closed: false, status: 'open', outcome: 'none',
      timeline: [{ event: 'JobCreated', block: 1, time: 100, args: {} },
        { event: 'JobAccepted', block: 2, time: 200, args: {}, ...rejection },
        { event: 'JobClosed', block: 3, time: 300, args: { outcome: 2 }, ...rejection }] };
    const { client, values } = fixture({ jobs: [running] });
    values['/api/jobs/checked%3A1'] = running;
    const { jobs: [job] } = await client.connect();
    assert.equal(job.phase, 'Open');
    assert.equal(job.status, '等待接单');
    assert.equal(job.closed, false);
    assert.equal(job.deadline, running.deadline);
    assert.equal(job.deadlinePending, false);
    assert.equal(job.settlement, null);
    assert.equal(job.progress.accept, undefined);
    assert.equal(job.progress.settle, undefined);
  }
});

test('an earlier acceptance event never regresses an already advanced task phase', async () => {
  const running = { ...closedJob, ref: 'replicated:4', id: 4, mode: 'replicated',
    task: 'image-classify-v1', closed: false, status: 'checking', outcome: 'none', deadline: 600,
    timeline: [{ event: 'JobCreated', block: 1, time: 100, args: {} },
      { event: 'JobAccepted', block: 2, time: 200, args: {} }] };
  const { client, values } = fixture({ jobs: [running] });
  values['/api/jobs/replicated%3A4'] = running;
  const { jobs: [job] } = await client.connect();
  assert.equal(job.phase, 'Checking');
  assert.equal(job.status, '复核计算中');
  assert.equal(job.deadline, 600);
  assert.equal(job.deadlinePending, false);
});

test('wallet operations send the documented header and never persist passwords in view state', async () => {
  const { client, requests, values } = fixture({ unlocked: false, handler(path, options) {
    if (options.method !== 'POST') return;
    if (path === '/api/wallets') return response({ name: 'new-wallet', address: BOB });
    if (path === '/api/unlock') {
      values['/api/status'] = { ...values['/api/status'], unlocked: true, wallet };
      return response(values['/api/status']);
    }
    if (path === '/api/lock') {
      values['/api/status'] = { ...values['/api/status'], unlocked: false, wallet: null };
      return response(values['/api/status']);
    }
  } });
  await client.connect();
  await client.createWallet({ name: 'new-wallet', password: 'private-password' });
  await client.unlockWallet({ name: 'alice', password: 'private-password', network: 'http://192.168.1.20:8600' });
  assert.equal(client.getState().unlocked, true);
  const unlock = requests.find(entry => entry.path === '/api/unlock');
  assert.equal(unlock.headers['X-DeGPU'], '1');
  assert.deepEqual(JSON.parse(unlock.body), { name: 'alice', password: 'private-password', network: 'http://192.168.1.20:8600' });
  assert.ok(!JSON.stringify(client.getState()).includes('private-password'));
  await client.lockWallet();
  assert.equal(client.getState().unlocked, false);
  assert.deepEqual(client.getState().jobs, []);
  assert.deepEqual(client.getState().account, {});
});

test('job creation sends original files as named multipart fields and retains all task inputs', async () => {
  const job = { ...closedJob, ref: 'replicated:4', id: 4, mode: 'replicated', task: 'image-classify-v1', status: 'open', outcome: 'none', closed: false, timeline: [] };
  const { client, requests } = fixture({ handler(path, options) {
    if (path === '/api/jobs' && options.method === 'POST') return response(job);
  } });
  await client.connect();
  const model = new File(['model bytes'], 'model.onnx');
  const first = new File(['first image'], 'a.jpg');
  const second = new File(['second image'], 'b.jpg');
  const id = await client.createJob({ taskType: 'image-classify-v1', provider: BOB, itemCount: 2, verify: true,
    files: { model, images: [first, second] }, fields: { limit: 2 } });
  assert.equal(id, 'replicated:4');
  const posted = requests.find(entry => entry.path === '/api/jobs' && entry.method === 'POST');
  assert.ok(posted.body instanceof FormData);
  assert.equal(posted.headers['Content-Type'], undefined, 'fetch must set the multipart boundary');
  assert.equal(posted.headers['X-DeGPU'], '1');
  assert.equal(posted.body.get('task'), 'image-classify-v1');
  assert.equal(posted.body.get('main'), BOB);
  assert.equal(posted.body.get('verify'), 'true');
  assert.equal(posted.body.get('limit'), '2');
  assert.equal(await posted.body.get('model').text(), 'model bytes');
  assert.deepEqual(posted.body.getAll('images').map(file => file.name), ['a.jpg', 'b.jpg']);
  assert.equal(client.getState().jobs[0].id, id);
  assert.equal(client.getState().jobs[0].deadlinePassed, false, 'newly posted tasks also avoid the local-clock timeout');
});

test('key and render fields follow the new backend instead of the former bridge format', async () => {
  let sequence = 0;
  const { client, requests } = fixture({ handler(path, options) {
    if (path === '/api/jobs' && options.method === 'POST') return response({ ...closedJob, ref: `checked:${++sequence + 1}`, timeline: [] });
  } });
  await client.connect();
  await client.createJob({ taskType: 'key-search-v1', provider: BOB, itemCount: 3, fields: { keys: 3, bits: 8, impossible: 1 } });
  await client.createJob({ taskType: 'blender-render-v1', provider: BOB, verify: false, fields: { frames: '1,5,9' }, files: { scene: new File(['scene'], 'example.blend') } });
  const posts = requests.filter(entry => entry.path === '/api/jobs' && entry.method === 'POST');
  assert.equal(posts[0].body.get('keys'), '3');
  assert.equal(posts[0].body.get('bits'), '8');
  assert.equal(posts[0].body.get('impossible'), '1');
  assert.equal(posts[0].body.get('verify'), null);
  assert.equal(posts[1].body.get('frames'), '1,5,9');
  assert.equal(posts[1].body.get('scene').name, 'example.blend');
});

test('provider operations enforce own wallet and use wei and real presentation behavior', async () => {
  const { client, requests } = fixture({ handler(path, options) {
    if (options.method === 'POST') return response(provider);
  } });
  await client.connect();
  await client.registerMachine({ stake: '1.000000000000000001', offers: { 'key-search-v1': '0.0001' } });
  await client.updateProviderOffers({ providerId: ALICE, offers: { 'key-search-v1': '0' } });
  await client.setProviderServing({ providerId: ALICE, on: true, behavior: 'cheat' });
  await client.stakeProvider({ amount: '0.5' });
  await client.withdrawProvider({ amount: '0.25' });
  const posts = requests.filter(entry => entry.method === 'POST').map(entry => [entry.path, JSON.parse(entry.body)]);
  assert.deepEqual(posts, [
    ['/api/provider/register', { stake_wei: '1000000000000000001', prices_wei: { 'key-search-v1': '100000000000000' } }],
    ['/api/provider/prices', { prices_wei: { 'key-search-v1': '0' } }],
    ['/api/provider/serve', { on: true, behavior: 'cheat' }],
    ['/api/provider/stake', { amount_wei: '500000000000000000' }],
    ['/api/provider/withdraw', { amount_wei: '250000000000000000' }],
  ]);
  await assert.rejects(client.updateProviderOffers({ providerId: BOB, offers: {} }), /当前钱包/);
});

test('real presentation choices survive refresh and only change the current wallet provider', async () => {
  const { client, requests, values } = fixture({ handler(path, options) {
    if (path === '/api/provider/serve' && options.method === 'POST') {
      const input = JSON.parse(options.body);
      Object.assign(values['/api/provider'], { behavior: input.behavior, serving: input.on });
      return response(values['/api/provider']);
    }
  } });
  values['/api/providers'].push({ ...provider, address: ALICE, open_jobs: 0 });
  values['/api/provider'].open_jobs = 0;
  await client.connect();
  for (const behavior of ['cheat', 'liar', 'offline', 'honest']) {
    await applyProviderBehavior(client, client.getState().selfProvider, behavior);
    await client.refresh();
    const current = client.getState().providers.find(entry => entry.id === ALICE);
    assert.equal(current.behavior, behavior);
    assert.equal(current.autoProcess, true);
  }
  assert.deepEqual(requests.filter(entry => entry.method === 'POST').map(entry => [entry.path, JSON.parse(entry.body)]),
    ['cheat', 'liar', 'offline', 'honest'].map(behavior => ['/api/provider/serve', { on: true, behavior }]));
  await assert.rejects(client.setProviderServing({ providerId: BOB, on: true, behavior: 'cheat' }), /当前钱包/);
});

test('key-search impossible challenges are additional items, even when they exceed solvable keys', async () => {
  const { client } = fixture({ handler(path, options) {
    if (path !== '/api/jobs' || options.method !== 'POST') return;
    const total = Number(options.body.get('keys')) + Number(options.body.get('impossible'));
    return response({ ...closedJob, ref: 'checked:8', id: 8, num_items: total,
      deposit_wei: String(BigInt(total) * 100000000000000n), timeline: [] });
  } });
  await client.connect();
  await client.createJob({ taskType: 'key-search-v1', provider: BOB, itemCount: 3, fields: { keys: 3, impossible: 5, bits: 8 } });
  assert.equal(client.getState().jobs[0].itemCount, 8);
  assert.equal(client.getState().jobs[0].deposit, '0.0008');
});

test('stopping and restarting a provider restores public quotes after reload without exposing passwords', async () => {
  const persisted = new Map();
  const storage = { getItem: key => persisted.get(key) ?? null, setItem: (key, value) => persisted.set(key, value) };
  const { client, values, fetcher, requests } = fixture({ storage, handler(path, options, current) {
    if (options.method !== 'POST') return;
    if (path === '/api/provider/prices') {
      const prices = JSON.parse(options.body).prices_wei;
      current['/api/provider'] = { ...current['/api/provider'], prices_wei: prices };
      current['/api/providers'] = [current['/api/provider']];
      return response(current['/api/provider']);
    }
    if (path === '/api/provider/serve') {
      const serving = JSON.parse(options.body).on;
      current['/api/status'].serving = serving;
      current['/api/provider'].serving = serving;
      return response(current['/api/provider']);
    }
  } });
  values['/api/providers'] = [values['/api/provider']];
  values['/api/provider'].open_jobs = 0;
  await client.connect();
  const original = client.getState().selfProvider.offers;
  await client.setProviderListing({ providerId: ALICE, enabled: false });
  await client.setProviderAutomation({ providerId: ALICE, enabled: false });
  assert.equal(client.getState().selfProvider.listed, false);
  assert.equal(client.getState().selfProvider.serving, false);
  assert.equal(persisted.size, 1);
  const restarted = createNetworkClient({ fetcher, pollMs: 0, storage });
  await restarted.connect();
  assert.deepEqual(restarted.getState().selfProvider.savedOffers, original);
  // Start the worker before making it eligible for newly drawn jobs.
  await restarted.setProviderAutomation({ providerId: ALICE, enabled: true });
  await restarted.setProviderListing({ providerId: ALICE, enabled: true });
  assert.equal(restarted.getState().selfProvider.serving, true);
  assert.deepEqual(restarted.getState().selfProvider.offers, original);
  assert.deepEqual(requests.filter(entry => entry.method === 'POST').map(entry => entry.path),
    ['/api/provider/prices', '/api/provider/serve', '/api/provider/serve', '/api/provider/prices']);
  assert.ok([...persisted.values()].every(value => !value.includes('password') && !value.includes('private_key')));
});

test('result values stay exact and file results expose real backend download URLs', async () => {
  let files = false;
  const { client } = fixture({ jobs: [closedJob], handler(path) {
    if (path === '/api/jobs/checked%3A1/results') return response(files
      ? { ref: 'checked:1', kind: 'file', suffix: '.png', items: [{ index: 0, file: '/api/jobs/checked:1/results/0', size: 15, mismatched: true }] }
      : { ref: 'checked:1', kind: 'value', items: [{ index: 0, value: '51710091667562486550356512692475758814', mismatched: false }, { index: 1, value: null, mismatched: false }] });
  } });
  await client.connect();
  await client.getResults('checked:1');
  assert.equal(client.getState().jobs[0].results[0].key, '51710091667562486550356512692475758814');
  assert.equal(client.getState().jobs[0].results[1].found, false);
  files = true;
  await client.getResults('checked:1');
  assert.equal(client.getState().jobs[0].results[0].previewUrl, '/api/jobs/checked:1/results/0');
  assert.equal(client.getState().jobs[0].results[0].disputed, true);
});

test('backend errors remain visible and wallet rejection never falls back to demo state', async () => {
  let unavailable = false;
  const { client } = fixture({ unlocked: false, handler(path, options) {
    if (unavailable) throw new Error('network offline');
    if (path === '/api/unlock' && options.method === 'POST') return response({ detail: 'wrong password' }, 400);
  } });
  await client.connect();
  await assert.rejects(client.unlockWallet({ name: 'alice', password: 'bad' }), /wrong password/);
  assert.equal(client.getState().unlocked, false);
  unavailable = true;
  await assert.rejects(client.refresh(), /network offline/);
  assert.equal(client.getState().network.connected, false);
  assert.match(client.getState().network.connectionError, /network offline/);
  assert.deepEqual(client.getState().providers, []);
});

test('successful post keeps its confirmed reference if the subsequent refresh fails', async () => {
  let posted = false;
  const { client } = fixture({ handler(path, options) {
    if (path === '/api/jobs' && options.method === 'POST') { posted = true; return response(closedJob); }
    if (posted) throw new Error('host disconnected after transaction');
  } });
  await client.connect();
  assert.equal(await client.createJob({ taskType: 'key-search-v1', provider: BOB, itemCount: 2 }), 'checked:1');
  assert.equal(client.getState().network.connected, false);
  assert.equal(client.getState().jobs[0].id, 'checked:1');
});

test('a slow old refresh cannot restore account data after a newer lock state', async () => {
  let releaseAccount;
  let accountRequested;
  const reachedAccount = new Promise(resolve => { accountRequested = resolve; });
  const { client, values } = fixture({ handler(path) {
    if (path === '/api/account') {
      accountRequested();
      return new Promise(resolve => { releaseAccount = () => resolve(response(values['/api/account'])); });
    }
  } });
  const staleRefresh = client.refresh();
  await reachedAccount;
  values['/api/status'] = { unlocked: false, wallet: null, network: null, serving: false };
  await client.refresh();
  releaseAccount();
  await staleRefresh;
  assert.equal(client.getState().unlocked, false);
  assert.deepEqual(client.getState().users, []);
  assert.deepEqual(client.getState().account, {});
});

test('locking clears private state even if refreshing status after the lock fails', async () => {
  let locked = false;
  const { client } = fixture({ jobs: [closedJob], handler(path, options) {
    if (path === '/api/lock' && options.method === 'POST') {
      locked = true;
      return response({ unlocked: false, wallet: null, network: null, serving: false });
    }
    if (locked) throw new Error('app stopped after lock');
  } });
  await client.connect();
  assert.equal(client.getState().jobs.length, 1);
  await client.lockWallet();
  assert.equal(client.getState().unlocked, false);
  assert.deepEqual(client.getState().jobs, []);
  assert.deepEqual(client.getState().account, {});
  assert.equal(client.getState().network.connected, false);
});

test('a result read that finishes after locking cannot restore old decrypted results', async () => {
  let releaseResults;
  let resultsRequested;
  const reachedResults = new Promise(resolve => { resultsRequested = resolve; });
  const { client, values } = fixture({ jobs: [closedJob], handler(path) {
    if (path === '/api/jobs/checked%3A1/results') {
      resultsRequested();
      return new Promise(resolve => { releaseResults = () => resolve(response({ kind: 'value', items: [{ index: 0, value: 'secret result' }] })); });
    }
  } });
  await client.connect();
  const staleRead = client.getResults('checked:1');
  await reachedResults;
  values['/api/status'] = { unlocked: false, wallet: null, network: null, serving: false };
  await client.refresh();
  releaseResults();
  await assert.rejects(staleRead, /钱包已切换/);
  assert.deepEqual(client.getState().jobs, []);
});

test('wei conversion never rounds a wei and rejects excess precision', () => {
  assert.equal(ethToWei('0.000000000000000001'), '1');
  assert.equal(weiToEth('1000000000000000001'), '1.000000000000000001');
  assert.throws(() => ethToWei('0.0000000000000000001'), /18/);
  assert.throws(() => ethToWei('-1'), /非负/);
});

test('frontend proxy streams multipart bytes and adds the required DeGPU header after checking origin', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ref":"replicated:1"}');
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const upstreamUrl = await listen(upstream);
  const server = createDemoServer({ apiUrl: upstreamUrl });
  const frontendUrl = await listen(server);
  try {
    const form = new FormData();
    form.append('task', 'image-classify-v1');
    form.append('model', new File(['original bytes'], 'model.onnx'));
    const posted = await fetch(`${frontendUrl}/api/jobs`, { method: 'POST', headers: { Origin: frontendUrl }, body: form });
    assert.equal(posted.status, 200);
    assert.equal(received[0].headers['x-degpu'], '1');
    assert.match(received[0].headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(received[0].body, /filename="model.onnx"/);
    assert.match(received[0].body, /original bytes/);
    const refused = await fetch(`${frontendUrl}/api/lock`, { method: 'POST', headers: { Origin: 'https://external.example' } });
    assert.equal(refused.status, 403);
    assert.equal(received.length, 1);
  } finally {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
  }
});
