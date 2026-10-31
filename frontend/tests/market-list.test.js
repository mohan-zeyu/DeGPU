import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarketList, sortMarketRows } from '../src/market-list.js';

const IMAGE = 'image-classify-v1';
const RENDER = 'blender-render-v1';
const KEY = 'key-search-v1';
const provider = (id, overrides = {}) => ({
  id, address: `0x${id}`, registered: true, active: true, lockedJobs: 0,
  offers: { [IMAGE]: '0.0001', [RENDER]: '0.0002', [KEY]: '0.0003' }, ...overrides,
});
const close = (id, main, outcome = 'Delivered', taskType = IMAGE, found = null) => ({
  id, mode: taskType === KEY ? 'checked' : 'replicated', taskType, provider: main, itemCount: 2,
  closed: true, events: [{ name: 'JobCreated', args: { main } },
    ...(found ? [{ name: 'ResultsSubmitted', args: { found } }] : []),
    { name: 'JobClosed', args: { outcome } }],
});
const stateWith = (providers, jobs = []) => ({ providers, jobs,
  network: { historyComplete: true, historyFromBlock: 0 } });
const listIds = (state, options) => getMarketList(state, options).rows.map(row => row.id);

test('all registered machines remain discoverable, including zero quotes, delisted and offline machines', () => {
  const state = stateWith([provider('A'), provider('B', { offers: { [IMAGE]: '0' } }),
    provider('C', { listed: false }), provider('D'), provider('E', { active: false }),
    provider('F', { registered: false }), provider('G', { registered: 'true' })]);
  const list = getMarketList(state, { connectivityByProvider: { D: 'offline' } });
  assert.equal(list.total, 5);
  assert.equal(list.filteredTotal, 5);
  assert.equal(list.rows.find(row => row.id === 'B').availability.label, '暂停服务');
  assert.equal(list.rows.find(row => row.id === 'C').availability.label, '已下架');
  assert.equal(list.rows.find(row => row.id === 'D').availability.label, '离线');
  assert.deepEqual(listIds(state, { availability: 'available', connectivityByProvider: { D: 'offline' } }), ['A']);
  assert.deepEqual(listIds(state, { availability: 'unavailable', connectivityByProvider: { D: 'offline' } }), ['B', 'C', 'D', 'E']);
});

test('ownership and active rentals are independent filters; own identity takes precedence', () => {
  const state = stateWith(['A', 'B', 'C', 'D'].map(id => provider(id)), [{
    id: 'replicated:live', mode: 'replicated', taskType: IMAGE, clientId: 'client', provider: 'B', closed: false,
    events: [{ name: 'JobCreated', args: { client: '0xClient', main: '0xb' } }],
  }, {
    id: 'replicated:old', mode: 'replicated', taskType: IMAGE, clientId: 'client', provider: 'C', closed: false,
    events: [{ name: 'JobCreated', args: { client: '0xClient', main: '0xC' } }, { name: 'JobClosed' }],
  }]);
  state.account = { id: 'client', address: '0xClient' };
  const options = { ownedProviderIds: ['A'] };
  assert.deepEqual(listIds(state, options), ['A', 'B', 'C', 'D']);
  assert.deepEqual(listIds(state, { ...options, ownership: 'other' }), ['C', 'D']);
  assert.deepEqual(listIds(state, { ...options, ownership: 'own' }), ['A']);
  assert.deepEqual(listIds(state, { ...options, ownership: 'rented' }), ['B']);
  assert.equal(getMarketList(state, { ...options, ownership: 'all' }).total, 4);
  assert.deepEqual(listIds(state, { ownedProviderIds: ['B'], ownership: 'rented' }), []);
  assert.deepEqual(listIds(state, { ...options, account: null, ownership: 'other' }), ['B', 'C', 'D']);
});

test('search matches name, machine ID and address without widening other filters', () => {
  const state = stateWith([provider('A', { name: 'Studio GPU' }), provider('B', { address: '0xAbCd' }),
    provider('GPU-12', { name: 'Worker' })]);
  assert.deepEqual(listIds(state, { query: ' studio ' }), ['A']);
  assert.deepEqual(listIds(state, { query: 'aBcD' }), ['B']);
  assert.deepEqual(listIds(state, { query: 'gpu-' }), ['GPU-12']);
  assert.deepEqual(listIds(state, { query: 'studio', ownedProviderIds: ['A'], ownership: 'other' }), []);
  assert.equal(getMarketList(state, { query: '  Studio ' }).query, 'Studio');
});

test('price ordering compares integer wei exactly and puts absent prices last in either direction', () => {
  const quote = amount => ({ offers: { [IMAGE]: amount } });
  const state = stateWith([provider('A', quote('10000000000000000.000000000000000002')),
    provider('B', quote('10000000000000000.000000000000000001')),
    provider('C', quote('0')), provider('D', quote('invalid'))]);
  assert.deepEqual(listIds(state, { sort: 'price-asc' }), ['B', 'A', 'C', 'D']);
  assert.deepEqual(listIds(state, { sort: 'price-desc' }), ['A', 'B', 'C', 'D']);
});

test('natural default order and optional availability ordering keep every machine accessible', () => {
  const state = stateWith([provider('10'), provider('2'), provider('C', { offers: { [IMAGE]: '0.0002' } }),
    provider('D', { offers: { [IMAGE]: '0.00001' }, lockedJobs: 1 }), provider('E')], [
    close('replicated:1', 'E'), close('replicated:2', 'E'), close('replicated:3', 'C'),
  ]);
  assert.deepEqual(listIds(state), ['2', '10', 'C', 'D', 'E']);
  assert.deepEqual(listIds(state, { sort: 'available' }), ['E', '2', '10', 'C', 'D']);
  assert.deepEqual(listIds(state, { sort: 'completed-desc' }), ['E', 'C', '2', '10', 'D']);
});

test('service-specific rate ordering uses confirmed public results and unknown rates remain last', () => {
  const state = stateWith(['A', 'B', 'C', 'D'].map(id => provider(id)), [
    close('replicated:1', 'A', 'MainMissed'), close('replicated:2', 'A'),
    close('replicated:3', 'B'), close('replicated:4', 'B', 'MainOutvoted'),
    close('replicated:5', 'C'), close('replicated:6', 'C', 'NoMajority'),
    close('replicated:7', 'A', 'MainMissed', RENDER),
    close('checked:1', 'A', 'Delivered', KEY, [true, false]),
    close('checked:2', 'B', 'Delivered', KEY, [true, true]),
  ]);
  assert.deepEqual(listIds(state, { sort: 'timeoutRate-asc' }), ['B', 'C', 'A', 'D']);
  assert.deepEqual(listIds(state, { sort: 'failureRate-asc' }), ['A', 'B', 'C', 'D']);
  assert.deepEqual(listIds(state, { sort: 'outvotedRate-asc' }), ['A', 'C', 'B', 'D']);
  assert.deepEqual(listIds(state, { taskType: KEY, sort: 'notFoundRate-asc' }), ['B', 'A', 'C', 'D']);
  assert.deepEqual(listIds(state, { taskType: RENDER, sort: 'timeoutRate-asc' }), ['A', 'B', 'C', 'D']);
});

test('unsupported metric modes and invalid filters fall back to usable defaults', () => {
  const state = stateWith([provider('A')]);
  for (const taskType of [IMAGE, RENDER]) {
    assert.equal(getMarketList(state, { taskType, sort: 'notFoundRate-asc' }).sort, 'available');
    assert.equal(getMarketList(state, { taskType, sort: 'outvotedRate-asc' }).sort, 'outvotedRate-asc');
  }
  assert.equal(getMarketList(state, { taskType: KEY, sort: 'outvotedRate-asc' }).sort, 'available');
  const list = getMarketList(state, { ownership: 'bad', availability: 'bad', sort: 'bad', query: {} });
  assert.equal(list.ownership, 'all');
  assert.equal(list.availability, 'all');
  assert.equal(list.sort, 'available');
  assert.equal(list.query, '');
});

test('the default list contains all machines while explicit pagination remains supported', () => {
  const state = stateWith(Array.from({ length: 14 }, (_, index) => provider(`GPU-${14 - index}`)));
  assert.equal(listIds(state).length, 14);
  assert.deepEqual(listIds(state).slice(0, 6), ['GPU-1', 'GPU-2', 'GPU-3', 'GPU-4', 'GPU-5', 'GPU-6']);
  const last = getMarketList(state, { page: 100, pageSize: 6 });
  assert.equal(last.page, 3);
  assert.equal(last.pageCount, 3);
  assert.deepEqual(last.rows.map(row => row.id), ['GPU-13', 'GPU-14']);
  const filtered = getMarketList(state, { query: 'GPU-1', page: 3, pageSize: 2 });
  assert.equal(filtered.total, 14);
  assert.equal(filtered.filteredTotal, 6);
  assert.deepEqual(filtered.rows.map(row => row.id), ['GPU-13', 'GPU-14']);
  const empty = getMarketList(state, { query: 'missing', page: 3 });
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(empty.rows, []);
  assert.equal(getMarketList(state, { page: -1, pageSize: 0 }).rows.length, 14);
});

test('all quote columns and stake sort using exact wei with unknown measurements last', () => {
  const state = stateWith([provider('A', { stake: '1.000000000000000002',
    offers: { [IMAGE]: '0.0001', [RENDER]: '0.000000000000000002', [KEY]: '0' } }),
  provider('B', { stake: '1.000000000000000001', active: false,
    offers: { [IMAGE]: '0.0002', [RENDER]: '0.000000000000000001', [KEY]: '0.0003' } }),
  provider('C', { stake: 'invalid', active: null, offers: {} })]);
  for (const key of ['stake', 'renderQuote']) {
    assert.deepEqual(listIds(state, { sort: `${key}-asc` }), ['B', 'A', 'C']);
    assert.deepEqual(listIds(state, { sort: `${key}-desc` }), ['A', 'B', 'C']);
  }
  assert.deepEqual(listIds(state, { sort: 'imageQuote-asc' }), ['A', 'B', 'C']);
  assert.deepEqual(listIds(state, { sort: 'keyQuote-desc' }), ['B', 'A', 'C']);
  assert.deepEqual(listIds(state, { sort: 'active-desc' }), ['A', 'B', 'C']);
  const rows = getMarketList(state).rows;
  assert.deepEqual(sortMarketRows(rows, 'id-desc').map(row => row.id), ['C', 'B', 'A']);
  assert.deepEqual(rows.map(row => row.id), ['A', 'B', 'C'], 'sorting does not mutate the projection');
});

test('aggregate registry completions count each market once and remain separate from selected task history', () => {
  const state = stateWith([provider('A', { lockedJobs: 2, record: {
    replicated: { verified_completed: 7, unverified_completed: 4 }, checked: { completed: 3 },
  } }), provider('B', { lockedJobs: 1, record: { checked: { completed: 20 } } })],
  [close('replicated:1', 'A')]);
  const image = getMarketList(state, { sort: 'totalCompleted-desc' });
  assert.deepEqual(image.rows.map(row => row.id), ['B', 'A']);
  assert.equal(image.rows[1].stats.totalCompleted, 14);
  assert.equal(image.rows[1].stats.completed, 1);
  assert.equal(getMarketList(state, { taskType: RENDER }).rows[0].stats.totalCompleted, 14);
  assert.deepEqual(listIds(state, { sort: 'lockedJobs-asc' }), ['B', 'A']);
  state.providers[0].record.checked.completed = 99;
  assert.equal(image.rows[1].stats.totalCompleted, 14, 'registry records do not alias a mutable backend object');
});

test('rows expose only public projections, do not alias private objects, and leave source state unchanged', () => {
  const state = stateWith([provider('A', { privateKey: 'secret', settings: { autoProcess: true } })], [
    { ...close('replicated:1', 'A'), inputs: ['private file'], results: ['private output'] },
  ]);
  const before = structuredClone(state);
  const list = getMarketList(state);
  const row = list.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['address', 'availability', 'id', 'identity', 'stats']);
  assert.equal(row.identity, 'other');
  assert.ok(!JSON.stringify(list).includes('private'));
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list.rows) && Object.isFrozen(row));
  assert.deepEqual(state, before);
  state.providers[0].offers[IMAGE] = '100';
  assert.equal(row.stats.quote, '0.0001');
  assert.deepEqual(getMarketList(undefined).rows, []);
});
