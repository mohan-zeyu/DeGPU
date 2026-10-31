import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderMarketPoints, getProviderPublicStats } from '../src/provider-stats.js';
import { renderProviderProfile } from '../src/provider-view.js';
import { renderMarketPage } from '../src/market-view.js';

const IMAGE = 'image-classify-v1';
const KEY = 'key-search-v1';
const RENDER = 'blender-render-v1';
const provider = (id, overrides = {}) => ({
  id, address: `0x${id}`, registered: true, active: true, stake: '1.000', lockedJobs: 0,
  offers: { [IMAGE]: '0.0001', [KEY]: '0.0002', [RENDER]: '0.0003' },
  statsByMode: {
    replicated: { verified: 70, unverified: 30, missed: 2, outvoted: 1, checksCompleted: 400, checksMissed: 0, checksOutvoted: 0 },
    checked: { completed: 10, missed: 1, itemsSolved: 80, itemsNotFound: 20 },
  }, ...overrides,
});

const outcomeJob = (id, taskType, outcome = 'Delivered', { main = '0xA', found = null, ...overrides } = {}) => ({
  id, taskType, mode: taskType === KEY ? 'checked' : 'replicated', itemCount: 4,
  closed: true, outcome, provider: 'stale-alias',
  events: [{ name: 'JobCreated', args: { main } },
    ...(found ? [{ name: 'ResultsSubmitted', args: { found } }] : []),
    { name: 'JobClosed', args: { outcome } }], ...overrides,
});

const machineRows = html => [...html.matchAll(/<tr\b[^>]*data-node-id="[^"]+"[^>]*>[\s\S]*?<\/tr>/g)].map(match => match[0]);
const machineRow = (html, id) => machineRows(html).find(row => row.includes(`data-node-id="${id}"`)) ?? '';
const metricCell = (row, metric) => row.match(new RegExp(`<td\\b[^>]*data-metric="${metric}"[^>]*>([\\s\\S]*?)<\\/td>`))?.[1] ?? '';

test('one machine has separate service histories rather than inheriting shared registry counts', () => {
  const state = { providers: [provider('A', { completed: 9999 })], jobs: [
    outcomeJob('replicated:1', IMAGE, 'Verified'),
    outcomeJob('replicated:2', IMAGE, 'Delivered'),
    outcomeJob('replicated:3', IMAGE, 'MainMissed'),
    outcomeJob('replicated:4', IMAGE, 'MainOutvoted'),
    outcomeJob('replicated:5', IMAGE, 'BothOutvoted'),
    outcomeJob('replicated:6', IMAGE, 'NoMajority'),
    outcomeJob('checked:1', KEY, 'Delivered', { found: [true, false, false, false] }),
    outcomeJob('checked:2', KEY, 'MainMissed'),
    outcomeJob('replicated:7', RENDER, 'Verified'),
    outcomeJob('checked:4', KEY, 'MainMissed', { main: '0xB' }),
  ] };
  const image = getProviderPublicStats(state, 'A');
  assert.equal(image.source, 'task-events');
  assert.equal(image.completed, 2);
  assert.equal(image.verified, 1);
  assert.equal(image.unverified, 1);
  assert.equal(image.checksCompleted, null, 'shared registry check counters are not claimed as per-service data');
  assert.equal(image.mainResolved, 6);
  assert.equal(image.timeoutRate, 1 / 6 * 100);
  assert.equal(image.outvotedRate, 2 / 6 * 100);
  assert.equal(image.failureRate, 4 / 6 * 100);
  assert.equal(image.quote, '0.0001');
  assert.equal(image.stake, '1');
  const nonce = getProviderPublicStats(state, '0xa', KEY);
  assert.equal(nonce.id, 'A');
  assert.equal(nonce.mode, 'checked');
  assert.equal(nonce.completed, 1);
  assert.equal(nonce.mainResolved, 2);
  assert.equal(nonce.timeoutRate, 50);
  assert.equal(nonce.notFoundRate, 75);
  assert.equal(nonce.failureRate, 50);
  assert.equal(nonce.quote, '0.0002');
  assert.equal(nonce.outvotedRate, null);
  const key = getProviderPublicStats(state, 'A', RENDER);
  assert.equal(key.completed, 1);
  assert.equal(key.mainResolved, 1);
  assert.equal(key.timeoutRate, 0);
  assert.equal(key.mode, 'replicated');
  assert.equal(key.unit, '帧');
  assert.equal(key.verified, 1);
  assert.equal(key.notFoundRate, null);
  assert.equal(key.failureRate, 0);
  assert.equal(key.quote, '0.0003');
  assert.equal(getProviderPublicStats(state, 'missing'), null);
  assert.equal(getProviderMarketPoints(state, KEY)[0].timeoutRate, 50);
  assert.equal(getProviderMarketPoints(state, RENDER)[0].timeoutRate, 0);
});

test('render dispute rejection is a successful main delivery and confirms only publicly revealed checks', () => {
  const checkedRender = outcomeJob('replicated:render-checked', RENDER, 'DisputeRejected');
  checkedRender.events.splice(1, 0, { name: 'CheckRevealed', args: { slot: 0, leaves: ['file-hash'] } });
  const uncheckedRender = outcomeJob('replicated:render-unchecked', RENDER, 'DisputeRejected');
  uncheckedRender.events.at(-1).args.outcome = 11;
  const ignoredCheck = outcomeJob('replicated:render-unconfirmed', RENDER, 'DisputeRejected');
  ignoredCheck.events.splice(1, 0, { name: 'CheckRevealed', confirmed: false, args: { slot: 0 } });
  const state = { providers: [provider('A')], jobs: [checkedRender, uncheckedRender, ignoredCheck,
    outcomeJob('replicated:image', IMAGE, 'MainOutvoted'),
    outcomeJob('checked:key', KEY, 'MainMissed')] };
  const stats = getProviderPublicStats(state, 'A', RENDER);
  assert.equal(stats.completed, 3);
  assert.equal(stats.verified, 1);
  assert.equal(stats.unverified, 2);
  assert.equal(stats.failureRate, 0);
  assert.equal(stats.outvotedRate, 0);
  assert.equal(stats.itemsSolved, null);
  assert.equal(stats.itemsNotFound, null);
  assert.equal(stats.unit, '帧');
  const profile = renderProviderProfile(stats);
  assert.match(profile, /Blender 渲染/);
  assert.match(profile, /ETH \/ 帧/);
  assert.match(profile, /争议驳回后的成功交付/);
  assert.doesNotMatch(profile, /找到项数|未找到占比/);
  const market = renderMarketPage(state, { taskType: RENDER });
  const table = market.slice(market.indexOf('aria-label="机器列表"'));
  assert.match(table, /ETH \/ 帧/);
  assert.match(table, /总完成/);
  assert.doesNotMatch(table, /否决率|未找到占比|失败率/);
  assert.equal(metricCell(machineRow(market, 'A'), 'totalCompleted'), '3');
  assert.equal(metricCell(machineRow(market, 'A'), 'renderQuote'), '0.00030000');
});

test('selected service history resolves public address roles and exposes only public metadata', () => {
  const base = { mode: 'replicated', taskType: IMAGE };
  const state = { providers: [provider('A')], jobs: [
    { ...base, id: 'replicated:1', provider: 'renamed', updatedBlock: 1,
      events: [{ name: 'JobCreated', args: { main: '0xa' } }] },
    { ...base, id: 'replicated:2', provider: 'B', verifiers: ['renamed'], verifierStates: ['Outvoted'], updatedBlock: 2,
      events: [{ name: 'VerifiersDrawn', args: { verifiers: ['0xa'] } }] },
    { ...base, id: 'replicated:3', provider: 'B', updatedBlock: 3,
      events: [{ name: 'TiebreakStarted', args: { tiebreaker: '0xA' } }] },
    { ...base, id: 'replicated:4', provider: 'A', events: [{ name: 'JobCreated', args: { main: '0xB' } }] },
    { id: 'checked:1', mode: 'checked', taskType: KEY, provider: 'A', updatedBlock: 4,
      inputs: ['private'], results: ['answer'], encPubKey: 'key', events: [] },
    { id: 'replicated:5', mode: 'replicated', taskType: RENDER, provider: 'A', updatedBlock: 5 },
  ] };
  const image = getProviderPublicStats(state, 'A').history;
  assert.deepEqual(image.map(row => [row.id, row.role]), [['replicated:3', 'tie'], ['replicated:2', 'check'], ['replicated:1', 'main']]);
  assert.equal(image[1].verifierState, 'Outvoted');
  const nonce = getProviderPublicStats(state, 'A', KEY).history;
  assert.deepEqual(nonce.map(row => row.id), ['checked:1']);
  assert.ok(nonce.every(row => !('inputs' in row) && !('results' in row) && !('encPubKey' in row) && !('events' in row)));
  assert.ok(Object.isFrozen(image) && Object.isFrozen(image[0]));
});

test('missing or unconfirmed service evidence stays unknown and cannot borrow assignment or shared counters', () => {
  const a = provider('A');
  const state = { providers: [a], jobs: [
    outcomeJob('checked:1', KEY, 'Delivered', { events: [] }),
    outcomeJob('checked:2', KEY, 'Delivered', { events: [
      { name: 'JobCreated', args: { main: '0xA' } },
      { name: 'JobClosed', confirmed: false, args: { outcome: 'Delivered' } },
    ] }),
    outcomeJob('checked:3', KEY, 'Unknown'),
    outcomeJob('checked:4', KEY, 'Delivered', { events: [
      { name: 'JobCreated', status: 0, args: { main: '0xA' } },
      { name: 'JobClosed', args: { outcome: 'Delivered' } },
    ] }),
    outcomeJob('checked:5', KEY, 'Delivered', { provider: 'A', main: '0xB' }),
    outcomeJob('checked:6', KEY, 'Cancelled'),
    outcomeJob('replicated:7', RENDER, 'Verified'),
  ] };
  const nonce = getProviderPublicStats(state, 'A', KEY);
  assert.equal(nonce.completed, null);
  assert.equal(nonce.mainResolved, 0);
  assert.equal(nonce.timeoutRate, null);
  assert.equal(nonce.failureRate, null);
  assert.equal(nonce.notFoundRate, null);
  assert.equal(nonce.itemsReported, null);
  assert.equal(getProviderMarketPoints(state, KEY)[0].completed, null);
  assert.equal(getProviderPublicStats(state, 'A', RENDER).completed, 1);
  assert.equal(getProviderPublicStats(state, 'A', IMAGE).completed, null);
  state.jobs.push(outcomeJob('checked:8', KEY, 'Delivered', { found: [true, 'false', false, false] }));
  const missingItems = getProviderPublicStats(state, 'A', KEY);
  assert.equal(missingItems.completed, 1);
  assert.equal(missingItems.failureRate, 0);
  assert.equal(missingItems.itemsSolved, null);
  assert.equal(missingItems.notFoundRate, null);
});

test('complete history from genesis shows new machines at zero completions without inventing rates', () => {
  const state = { network: { historyComplete: true, historyFromBlock: 0 },
    providers: [provider('A'), provider('B'), provider('C')], jobs: [] };
  for (const taskType of [IMAGE, RENDER, KEY]) {
    const stats = getProviderPublicStats(state, 'A', taskType);
    assert.equal(stats.completed, 0, 'shared registry counts must never substitute for this service');
    assert.equal(stats.mainResolved, 0);
    for (const metric of ['verified', 'unverified', 'missed', 'outvoted', 'failed', 'timeoutRate',
      'outvotedRate', 'failureRate', 'notFoundRate', 'itemsSolved', 'itemsNotFound', 'itemsReported']) {
      assert.equal(stats[metric], null, `${metric} stays unknown with no settled samples`);
    }
    assert.deepEqual(getProviderMarketPoints(state, taskType).map(point => point.completed), [0, 0, 0]);
    const market = renderMarketPage(state, { taskType });
    assert.equal(machineRows(market).length, 3, 'equal-price machines remain individually accessible');
    for (const id of ['A', 'B', 'C']) {
      assert.equal(metricCell(machineRow(market, id), 'totalCompleted'), '0');
      assert.doesNotMatch(machineRow(market, id), /data-metric="(?:timeoutRate|failureRate)"/);
    }
    assert.match(market, /href="#\/new\?provider=B/,
      'a quoted, idle machine can be rented before its first completed task');
  }
  state.jobs.push(outcomeJob('checked:existing', KEY, 'Delivered', { found: [true, true, false, false] }));
  assert.equal(getProviderPublicStats(state, 'A', KEY).completed, 1);
  assert.equal(getProviderPublicStats(state, 'A', KEY).failureRate, 0);
  assert.equal(getProviderPublicStats(state, 'A', IMAGE).completed, 0, 'other service remains a real zero');
  assert.equal(getProviderPublicStats(state, 'B', KEY).completed, 0, 'other machine remains a real zero');
});

test('partial and unknown history keep missing completion counts unknown even on a live network', () => {
  for (const network of [undefined, { mode: 'live' }, { historyComplete: true },
    { historyFromBlock: 0 }, { historyComplete: false, historyFromBlock: 0 },
    { historyComplete: true, historyFromBlock: 1 }, { historyComplete: true, historyFromBlock: '0' }]) {
    const state = { network, providers: [provider('A')], jobs: [] };
    assert.equal(getProviderPublicStats(state, 'A', IMAGE).completed, null);
    assert.equal(getProviderMarketPoints(state, KEY)[0].completed, null);
    assert.equal(getProviderPublicStats(state, 'A', IMAGE).failureRate, null);
  }
  assert.equal(getProviderPublicStats({ network: { historyComplete: true, historyFromBlock: 0 },
    providers: [provider('A')] }, 'A', IMAGE).completed, null, 'an absent job collection is not an empty history');
});

test('market nodes require registration, active stake, and a positive offer for the selected service', () => {
  const a = provider('A');
  const b = provider('B', { active: false });
  const c = provider('C', { registered: false });
  const d = provider('D', { offers: { [IMAGE]: '0', [KEY]: '0.0007' } });
  const old = provider('old', { offers: undefined, pricePerItem: '0.0001' });
  const state = { providers: [a, b, c, d, old] };
  assert.deepEqual(getProviderMarketPoints(state).map(row => row.id), ['A']);
  assert.deepEqual(getProviderMarketPoints(state, KEY).map(row => [row.id, row.quote]), [['A', '0.0002'], ['D', '0.0007']]);
  assert.equal(getProviderPublicStats(state, 'D').quote, null);
  assert.deepEqual(getProviderMarketPoints(state, 'nonce-search-v1'), []);
  assert.deepEqual(getProviderMarketPoints(undefined), []);
});

test('market can retain quoted registered machines whose current availability is limited', () => {
  const state = { providers: [
    provider('A'), provider('B', { active: false }), provider('C', { active: null }),
    provider('D', { registered: false }), provider('E', { offers: { [IMAGE]: '0' } }),
    provider('F', { lockedJobs: 2 }),
  ] };
  assert.deepEqual(getProviderMarketPoints(state).map(row => row.id), ['A', 'F']);
  const points = getProviderMarketPoints(state, IMAGE, { includeUnavailable: true });
  assert.deepEqual(points.map(row => row.id), ['A', 'B', 'C', 'F']);
  assert.ok(Object.isFrozen(points) && points.every(Object.isFrozen));
  assert.deepEqual(getProviderMarketPoints(state, 'nonce-search-v1', { includeUnavailable: true }), []);
});

test('market rows show public availability and disable unavailable rentals while retaining own management', () => {
  const state = { providers: [provider('A'), provider('B', { active: false }), provider('C', { lockedJobs: 1 })], jobs: [] };
  const idle = machineRow(renderMarketPage(state), 'A');
  assert.match(idle, /market-machine-row is-available/);
  assert.match(idle, /market-active-label is-active">已达标/);
  assert.match(idle, /title="Active 仅表示已注册且质押达标；在线状态未提供"/);
  assert.match(idle, /href="#\/new\?provider=A/);
  const offline = machineRow(renderMarketPage(state, { connectivityByProvider: { A: 'offline' } }), 'A');
  assert.match(offline, /market-machine-row is-unavailable/);
  assert.match(offline, /<button[^>]*disabled[^>]*>离线<\/button>/);
  assert.match(offline, /market-active-label is-active">已达标/, 'eligibility does not claim the provider is online');
  assert.doesNotMatch(offline, /href="#\/new/);
  const inactive = machineRow(renderMarketPage(state), 'B');
  assert.match(inactive, /未满足接单条件/);
  assert.match(inactive, />未达标<\/span>/);
  const busy = machineRow(renderMarketPage(state), 'C');
  assert.match(busy, /disabled[^>]*>任务占用<\/button>/);
  assert.equal(metricCell(busy, 'lockedJobs'), '1');
  const own = machineRow(renderMarketPage(state, { ownership: 'own', ownedProviderIds: ['C'] }), 'C');
  assert.match(own, /href="#\/supply\?machine=C">管理/);
  assert.doesNotMatch(own, />暂不可选用<\/button>/);
});

test('public projections are immutable snapshots without secret or telemetry references', () => {
  const state = { providers: [provider('A', { telemetry: { secret: 1 }, encPubKey: 'sensitive' })], jobs: [outcomeJob('replicated:1', IMAGE, 'Verified')] };
  const before = structuredClone(state);
  const stats = getProviderPublicStats(state, 'A');
  const points = getProviderMarketPoints(state);
  assert.deepEqual(state, before);
  assert.ok(Object.isFrozen(stats) && Object.isFrozen(points) && Object.isFrozen(points[0]));
  assert.equal('telemetry' in stats, false);
  assert.equal('encPubKey' in stats, false);
  state.providers[0].statsByMode.replicated.verified = 0;
  assert.equal(stats.completed, 1);
});

test('the market keeps all per-item quotes visible while checked profiles preserve service-specific metrics', () => {
  const state = { providers: [provider('A'), provider('B')], jobs: [outcomeJob('checked:1', KEY, 'Delivered', { found: [true, false, false, false] }), outcomeJob('replicated:1', IMAGE, 'Verified')] };
  const html = renderMarketPage(state, { taskType: KEY });
  assert.match(html, /id="market-service-select"/);
  assert.match(html, /value="key-search-v1" selected/);
  assert.match(html, /ETH \/ 项/);
  const marketPanel = html.slice(html.indexOf('class="panel market-panel"'));
  assert.doesNotMatch(marketPanel, /否决|复核|outvotedRate/);
  assert.doesNotMatch(html, /否决率不适用/);
  assert.match(html, /type=key-search-v1/);
  assert.match(html, /aria-label="机器列表"/);
  assert.equal(metricCell(machineRow(html, 'A'), 'keyQuote'), '0.00020000');
  assert.equal(metricCell(machineRow(html, 'A'), 'totalCompleted'), '2');
  assert.doesNotMatch(marketPanel, /未找到占比|失败率|超时率/);
  const profile = renderProviderProfile(getProviderPublicStats(state, 'A', KEY), { taskType: KEY });
  assert.match(profile, /0.0002 ETH \/ 项/);
  assert.match(profile, /找到项数/);
  assert.doesNotMatch(profile, /否决|复核/);
  const image = renderMarketPage(state, { taskType: IMAGE });
  assert.match(image, /ETH \/ 张/);
  assert.equal(metricCell(machineRow(image, 'A'), 'keyQuote'), '0.00020000');
  assert.equal(metricCell(machineRow(image, 'A'), 'totalCompleted'), '2');
});

test('no selected offer hides booking, and provider profile escapes public labels and tiny rates', () => {
  const state = { providers: [provider('A', { offers: { [IMAGE]: '0.0001' } })], jobs: [] };
  const html = renderMarketPage(state, { taskType: KEY });
  assert.doesNotMatch(html, /href="#\/new\?provider=/);
  assert.match(html, /暂停服务/);
  assert.match(html, /disabled[^>]*>暂停服务<\/button>/);
  const stats = { ...getProviderPublicStats(state, 'A'), address: '<script>alert(1)</script>', timeoutRate: 0.01 };
  const profile = renderProviderProfile(stats);
  assert.doesNotMatch(profile, /<script>/);
  assert.match(profile, /&lt;script&gt;/);
  assert.match(profile, /&lt;0.1%/);
  assert.doesNotMatch(profile, /&amp;lt;0.1%/);
});

test('market and public profile round visible ETH values while keeping source values exact', () => {
  const state = { providers: [provider('A', { offers: { [IMAGE]: '0.0001' }, stake: '1.234567895' }),
    provider('B', { offers: { [IMAGE]: '0.0002' } }),
    provider('C', { offers: { [IMAGE]: '0.0002' } })], jobs: [] };
  const before = structuredClone(state);
  const market = renderMarketPage(state);
  assert.match(market, /<strong[^>]*>0\.00016667<span/);
  assert.doesNotMatch(market, /<strong[^>]*>0\.000166666666666667/);
  assert.equal(metricCell(machineRow(market, 'A'), 'stake'), '1.23456790');
  const profile = renderProviderProfile(getProviderPublicStats(state, 'A'));
  assert.match(profile, /1\.2345679 ETH/);
  assert.deepEqual(state, before);
});

test('ownership filtering lists every owned machine with management while other machines remain rentable', () => {
  const state = { account: { id: 'user-1' }, providers: [provider('A'), provider('B'), provider('C')], jobs: ['A', 'B', 'C'].map((id, index) => outcomeJob(`replicated:${index + 1}`, IMAGE, 'Verified', { main: `0x${id}` })) };
  const own = renderMarketPage(state, { ownership: 'own', ownedProviderIds: ['A', 'C'] });
  assert.equal(machineRows(own).length, 2);
  for (const id of ['A', 'C']) {
    const row = machineRow(own, id);
    assert.match(row, /market-machine-row is-available is-own/);
    assert.match(row, /class="own-node-label">我的机器/);
    assert.match(row, new RegExp(`href="#/supply\\?machine=${id}">管理`));
  }
  assert.doesNotMatch(own, /href="#\/new\?provider=/);
  assert.equal(machineRow(own, 'B'), '');
  const foreign = renderMarketPage(state, { ownedProviderIds: ['A', 'C'] });
  assert.equal(machineRows(foreign).length, 3, 'the default table also includes owned machines');
  assert.match(machineRow(foreign, 'A'), /<span class="own-node-label">/);
  assert.match(machineRow(foreign, 'B'), /href="#\/new\?provider=B/);
  assert.match(machineRow(foreign, 'B'), />选用<\/a>/);
});

test('public provider task history renders identifiers without task properties or metadata', () => {
  const stats = getProviderPublicStats({ providers: [provider('A')], jobs: [] }, 'A');
  const html = renderProviderProfile({ ...stats, history: [{
    id: 'replicated:private-id', taskType: 'secret-task-type', role: 'secret-role',
    status: 'secret-task-status', updatedBlock: 987654321, itemCount: 7654321,
    inputs: ['secret-input'], results: ['secret-output'], verify: true,
  }] });
  const history = html.slice(html.indexOf('aria-label="提供方公开任务记录"'));
  assert.match(history, /replicated:private-id/);
  assert.match(history, /href="#\/jobs\/replicated%3Aprivate-id\/events"/);
  assert.doesNotMatch(history, /secret-|987654321|7654321|最新区块|当前状态|<th>职责|<th>服务/);
  assert.doesNotMatch(history, /title="[^"]*(secret|当前服务)/);
});


test('market header always shows three service descriptions and mean prices while filters change only the list', () => {
  const closed = (id, taskType, outcome) => ({ id, taskType,
    mode: taskType === KEY ? 'checked' : 'replicated',
    events: [{ name: 'JobClosed', args: { outcome } }],
  });
  const state = { providers: [provider('A')], jobs: [
    closed('replicated:1', IMAGE, 'MainOutvoted'),
    closed('checked:1', KEY, 'MainMissed'),
    closed('checked:2', KEY, 'Delivered'),
    closed('replicated:2', RENDER, 'Delivered'),
  ] };
  const image = renderMarketPage(state, { taskType: IMAGE });
  const key = renderMarketPage(state, { taskType: RENDER, ownership: 'all', availability: 'available' });
  const header = image.slice(0, image.indexOf('<section class="panel market-panel"'));
  assert.equal(header, key.slice(0, key.indexOf('<section class="panel market-panel"')));
  const columns = [...header.matchAll(/<article class="stat market-service-stat" data-service="([^"]+)">([\s\S]*?)<\/article>/g)];
  assert.deepEqual(columns.map(match => match[1]), [IMAGE, RENDER, KEY]);
  assert.ok(columns.every(([, , column]) => /市场均价/.test(column) && /market-service-description/.test(column)));
  assert.match(columns[0][2], />0\.00010000<span/);
  assert.match(columns[1][2], />0\.00030000<span/);
  assert.match(columns[2][2], />0\.00020000<span/);
  assert.doesNotMatch(header, /超时率|失败率|否决率|market-service-rates|JobClosed/);
  assert.match(key, /<table[^>]*aria-label="机器列表"/);
  assert.match(key, /id="market-service-select"/);
  assert.equal((key.match(/class="market-column-sort"/g) ?? []).length, 8);
  assert.doesNotMatch(key, /<aside|market-scatter|market-group-node-select|market-metric-select/);
});


test('public profile preserves chosen-service history while the market labels its completion aggregate', () => {
  const state = { providers: [provider('A')], jobs: [
    outcomeJob('checked:1', KEY, 'MainMissed'),
    outcomeJob('replicated:1', RENDER, 'Delivered'),
  ] };
  const profile = renderProviderProfile(getProviderPublicStats(state, 'A', KEY));
  assert.match(profile, /本类可见记录/);
  assert.match(profile, /本类可见确认历史/);
  assert.doesNotMatch(profile, /市场累计|含 Nonce 与密钥|复核与裁决/);
  const nonce = machineRow(renderMarketPage(state, { taskType: KEY }), 'A');
  const key = machineRow(renderMarketPage(state, { taskType: RENDER }), 'A');
  assert.doesNotMatch(nonce, /data-metric="(?:completed|timeoutRate)"/);
  assert.doesNotMatch(key, /data-metric="(?:completed|timeoutRate)"/);
  assert.equal(metricCell(nonce, 'totalCompleted'), '1');
  assert.equal(metricCell(key, 'totalCompleted'), '1');
});


test('machine rows show every quote and simple public totals without a profile detour or statistical clutter', () => {
  const state = { account: { id: 'user-1' }, providers: [provider('A')], jobs: [
    outcomeJob('checked:1', KEY, 'MainMissed'),
    outcomeJob('checked:2', KEY, 'Delivered', { found: [true, false, false, false] }),
    outcomeJob('replicated:1', IMAGE, 'MainOutvoted'),
  ] };
  const html = renderMarketPage(state, { taskType: KEY });
  const table = html.slice(html.indexOf('aria-label="机器列表"'));
  assert.doesNotMatch(table, /公开资料|详细信息|否决|样本数|超时率|失败率|未找到占比/);
  for (const label of ['图像分类', 'Blender 渲染', '密钥搜索', '接单资格', 'Active', '质押', '进行中', '总完成']) assert.match(table, new RegExp(label));
  const row = machineRow(html, 'A');
  assert.equal(metricCell(row, 'totalCompleted'), '1');
  assert.equal(metricCell(row, 'keyQuote'), '0.00020000');
  assert.equal(metricCell(row, 'imageQuote'), '0.00010000');
  assert.equal(metricCell(row, 'renderQuote'), '0.00030000');
  assert.match(row, />选用<\/a>/);
  const image = renderMarketPage(state, { taskType: IMAGE });
  const imageTable = image.slice(image.indexOf('aria-label="机器列表"'));
  assert.doesNotMatch(imageTable, /否决率/);
  assert.equal(metricCell(machineRow(image, 'A'), 'totalCompleted'), '1');
});

test('machine rows distinguish ownership and current rentals while logged-out views have no rental identity', () => {
  const account = { id: 'user-1', address: '0xClient1' };
  const state = { account, providers: [provider('A'), provider('B')], jobs: [
    outcomeJob('replicated:1', IMAGE, 'Verified'),
    outcomeJob('replicated:2', IMAGE, 'Verified', { main: '0xB' }),
    { id: 'replicated:3', taskType: IMAGE, mode: 'replicated', clientId: account.id,
      closed: false, provider: 'B', phase: 'Committing', events: [
        { name: 'JobCreated', args: { client: account.address, main: '0xB' } },
      ] },
  ] };
  const rented = machineRow(renderMarketPage(state, { ownership: 'rented', ownedProviderIds: ['A'] }), 'B');
  assert.match(rented, /market-machine-row is-available is-rented/);
  assert.match(rented, /class="rented-node-label">我租用中/);
  const own = machineRow(renderMarketPage(state, { ownership: 'own', ownedProviderIds: ['A'] }), 'A');
  assert.match(own, /market-machine-row is-available is-own/);
  assert.match(own, /class="own-node-label">我的机器/);
  const loggedOut = renderMarketPage(state, { account: null, ownedProviderIds: [] });
  assert.doesNotMatch(loggedOut, /rented-node-label|market-machine-row[^"]*is-rented/);
  assert.match(loggedOut, /href="#\/new\?provider=B&amp;type=image-classify-v1">登录选用/);
  assert.match(own, /href="#\/supply\?machine=A">管理/);
});
