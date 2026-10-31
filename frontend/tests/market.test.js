import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarketStats, getNetworkOutcomeStats, getProviderQuoteComparison, getRentedProviderIds } from '../src/market.js';

const IMAGE = 'image-classify-v1';
const KEY = 'key-search-v1';
const RENDER = 'blender-render-v1';
const provider = (id, quote = '0.0001', overrides = {}) => ({
  id, address: `0x${id}`, registered: true, active: true,
  offers: { [IMAGE]: quote, [KEY]: '0.0002', [RENDER]: '0.0003' },
  statsByMode: {
    replicated: { verified: 0, unverified: 0, missed: 0, outvoted: 0, checksCompleted: 0, checksMissed: 0, checksOutvoted: 0 },
    checked: { completed: 0, missed: 0, itemsSolved: 0, itemsNotFound: 0 },
  }, ...overrides,
});
const payout = (to, amount) => ({ name: 'Payout', args: { to, amount, amountEth: '9999' } });
const settled = (overrides = {}) => ({
  id: 'replicated:1', provider: 'A', taskType: IMAGE, mode: 'replicated', itemCount: 100,
  closed: true, outcome: 'Verified', phase: 'Closed',
  settlement: { main: '9999', refund: '9999' },
  events: [{ name: 'JobCreated', args: { main: '0xA' } }, payout('0xa', '10000000000000000')],
  ...overrides,
});
const withStats = (id, mode, values, overrides = {}) => {
  const entry = provider(id, '0.0001', overrides);
  entry.statsByMode[mode] = { ...entry.statsByMode[mode], ...values };
  return entry;
};

test('offers are separate by service and zero, stale, ineligible, or unregistered prices are excluded', () => {
  const state = { providers: [provider('A', '0.0001'), provider('B', '0.0002'), provider('C', '0.0002'),
    provider('D', '9', { active: false }), provider('E', '-1'), provider('F', 'unknown'),
    provider('G', '0'), provider('H', '2', { registered: false }),
    provider('old', '3', { offers: undefined, pricePerItem: '3' })], jobs: [] };
  const stats = getMarketStats(state);
  assert.equal(stats.quoteCount, 3);
  assert.equal(stats.averageQuote, '0.000166666666666667');
  assert.deepEqual(stats.distribution, [{ price: '0.0001', count: 1 }, { price: '0.0002', count: 2 }]);
  assert.equal(getProviderQuoteComparison(state, 'A').differencePercent, '-40');
  assert.equal(getProviderQuoteComparison(state, 'B').differencePercent, '+20');
  assert.equal(getProviderQuoteComparison(state, 'G').quote, null);
  assert.equal(getMarketStats(state, KEY).averageQuote, '0.0002');
  assert.equal(getMarketStats(state, RENDER).averageQuote, '0.0003');
  assert.equal(getMarketStats(state, 'nonce-search-v1').quoteCount, 0);
});

test('realized replicated price uses actual successful main Payouts, excluding refunds, checks, and penalties', () => {
  const state = { providers: [provider('A')], jobs: [
    settled({ events: [{ name: 'JobCreated', args: { main: '0xA' } },
      payout('0xa', '10000000000000000'), payout('0xB', '900000000000000000'),
      payout('0xClient', '900000000000000000')] }),
    settled({ itemCount: 300, outcome: 'Delivered', events: [payout('0xA', '60000000000000000')] }),
    settled({ outcome: 'VerifierOutvoted', events: [payout('0xA', '10000000000000000')] }),
    settled({ outcome: 'MainOutvoted', events: [payout('0xA', '999000000000000000')] }),
    settled({ outcome: 'MainMissed', events: [payout('0xA', '999000000000000000')] }),
    settled({ taskType: RENDER }), settled({ events: [] }), settled({ itemCount: 0 }),
  ] };
  const stats = getMarketStats(state);
  assert.equal(stats.settledCount, 3);
  assert.equal(stats.settledItems, 500);
  assert.equal(stats.settledAverage, '0.00016');
});

test('rendering prices are per frame and a rejected dispute counts delivery without adding its bond or judge payout', () => {
  const state = { providers: [provider('A')], jobs: [
    settled({ id: 'replicated:render', taskType: RENDER, itemCount: 10, outcome: 'DisputeRejected',
      events: [{ name: 'JobCreated', args: { main: '0xA' } },
        { name: 'JudgementSubmitted', args: { verdicts: [3] } },
        payout('0xA', '3000000000000000'), payout('0xJudge', '2000000000000000'),
        payout('0xClient', '3000000000000000'), { name: 'JobClosed', args: { outcome: 11 } }] }),
    settled({ id: 'replicated:classify', taskType: IMAGE, itemCount: 10 }),
  ] };
  const stats = getMarketStats(state, RENDER);
  assert.equal(stats.mode, 'replicated');
  assert.equal(stats.settledCount, 1);
  assert.equal(stats.settledItems, 10);
  assert.equal(stats.settledAverage, '0.0003');
  const outcomes = getNetworkOutcomeStats(state, RENDER);
  assert.equal(outcomes.completed, 1);
  assert.equal(outcomes.failureRate, 0);
  assert.equal(outcomes.outvotedRate, 0);
  assert.equal(outcomes.notFoundRate, null);
});

test('checked realized unit price divides by solved items and does not turn refunded inputs into discounts', () => {
  const jobs = [settled({ id: 'checked:1', mode: 'checked', taskType: KEY,
    itemCount: 10, solved: 4, outcome: 'Delivered',
    events: [payout('0xA', '800000000000000'), payout('0xClient', '1200000000000000')] }),
  settled({ id: 'checked:2', mode: 'checked', taskType: KEY, itemCount: 10, solved: 0,
    outcome: 'Delivered', events: [payout('0xClient', '2000000000000000')] }),
  settled({ mode: 'checked', taskType: KEY, solved: 101, outcome: 'Delivered' }),
  settled({ mode: 'checked', taskType: KEY, solved: undefined, outcome: 'Delivered' })];
  const stats = getMarketStats({ providers: [provider('A')], jobs }, KEY);
  assert.equal(stats.settledCount, 1);
  assert.equal(stats.settledItems, 4);
  assert.equal(stats.settledAverage, '0.0002');
  assert.equal(getMarketStats({ jobs }, RENDER).settledCount, 0);
});

test('missing and malformed payment data never become a zero price; event main address wins over aliases', () => {
  const state = { providers: [provider('A', '1', { address: '0xNew' })], jobs: [
    settled(), settled({ events: [payout('0xNew', '-1')] }),
    settled({ events: [payout('0xNew', '1.5')] }), settled({ events: [] }),
    settled({ events: [{ name: 'Payout', args: { to: '0xNew', amountEth: '9' } }] }),
  ] };
  assert.equal(getMarketStats(state).settledCount, 1);
  assert.equal(getMarketStats(state).settledAverage, '0.0001');
  assert.equal(getMarketStats({}).settledAverage, null);
  assert.equal(getProviderQuoteComparison({}, 'A').differencePercent, null);
});

test('market demand filters by task name and exact wei arithmetic remains immutable', () => {
  const state = { providers: [provider('A', '0.000000000000000001'), provider('B', '0.000000000000000002')],
    jobs: [settled({ closed: false, phase: 'Open' }), settled({ taskType: KEY, closed: false, phase: 'Working' })] };
  const before = structuredClone(state);
  const stats = getMarketStats(state);
  assert.equal(stats.averageQuote, '0.000000000000000002');
  assert.equal(stats.openJobs, 1);
  assert.equal(stats.inProgressJobs, 0);
  assert.equal(getMarketStats(state, KEY).inProgressJobs, 1);
  assert.deepEqual(state, before);
  assert.ok(Object.isFrozen(stats) && Object.isFrozen(stats.distribution) && Object.isFrozen(stats.distribution[0]));
  state.providers[0].offers[IMAGE] = '0.1';
  assert.equal(stats.averageQuote, '0.000000000000000002');
});

const closureJob = (id, taskType, outcome, overrides = {}) => ({
  id, taskType, mode: taskType === KEY ? 'checked' : 'replicated', itemCount: 4,
  closed: true, outcome,
  events: [{ name: 'JobClosed', args: { outcome } }], ...overrides,
});

test('network summaries keep rendering separate from classification and directly checked key tasks', () => {
  const state = { providers: [withStats('A', 'checked', { completed: 9999, missed: 9999,
    itemsSolved: 9999, itemsNotFound: 9999 }, { active: false })], jobs: [
    closureJob('checked:1', KEY, 'Delivered', { events: [
      { name: 'ResultsSubmitted', args: { found: [true, false, false, false] } },
      { name: 'JobClosed', args: { outcome: 'Delivered' } },
    ] }),
    closureJob('checked:2', KEY, 'MainMissed'),
    closureJob('replicated:2', RENDER, 'Delivered', { events: [
      { name: 'JobClosed', args: { outcome: 'Delivered' } },
    ] }),
    closureJob('replicated:3', RENDER, 'Verified', { events: [
      { name: 'JobClosed', args: { outcome: 'Delivered' } },
    ] }),
    closureJob('replicated:4', RENDER, 'Cancelled'),
    closureJob('replicated:1', IMAGE, 'Verified'),
  ] };
  const before = structuredClone(state);
  const nonce = getNetworkOutcomeStats(state, KEY);
  const key = getNetworkOutcomeStats(state, RENDER);
  assert.equal(nonce.source, 'task-events');
  assert.equal(nonce.completed, 1);
  assert.equal(nonce.mainResolved, 2);
  assert.equal(nonce.timeoutRate, 50);
  assert.equal(nonce.failureRate, 50);
  assert.equal(nonce.outvotedRate, null);
  assert.equal(nonce.itemsSolved, 1);
  assert.equal(nonce.itemsNotFound, 3);
  assert.equal(nonce.notFoundRate, 75);
  assert.equal(key.completed, 2);
  assert.equal(key.mainResolved, 2);
  assert.equal(key.timeoutRate, 0);
  assert.equal(key.mode, 'replicated');
  assert.equal(key.failureRate, 0);
  assert.equal(key.itemsReported, null, 'rendered frames are not checked search answers');
  assert.equal(key.notFoundRate, null);
  assert.equal(key.outvotedRate, 0);
  assert.equal(getNetworkOutcomeStats(state, IMAGE).completed, 1);
  assert.deepEqual(state, before);
  assert.ok(Object.isFrozen(nonce));
});

test('replicated type failures count actual terminal outcomes and exclude cancellation and other services', () => {
  const state = { jobs: ['Delivered', 'Verified', 'VerifierOutvoted', 'MainMissed', 'MainOutvoted',
    'BothOutvoted', 'NoMajority', 'TiebreakerMissed', 'TieClientNoShare', 'Cancelled']
    .map((outcome, index) => closureJob(`replicated:${index + 1}`, IMAGE, outcome)) };
  state.jobs.push(closureJob('checked:1', KEY, 'MainMissed'));
  const image = getNetworkOutcomeStats(state, IMAGE);
  assert.equal(image.completed, 3);
  assert.equal(image.mainResolved, 9);
  assert.equal(image.missed, 1);
  assert.equal(image.outvoted, 2);
  assert.equal(image.failed, 6);
  assert.equal(image.timeoutRate, 1 / 9 * 100);
  assert.equal(image.outvotedRate, 2 / 9 * 100);
  assert.equal(image.failureRate, 6 / 9 * 100);
});

test('only confirmed close evidence counts, using market-specific numeric outcome enums and unique task identity', () => {
  const first = closureJob('replicated:1', IMAGE, 'stale', { closed: false,
    events: [{ name: 'JobClosed', args: { outcome: 3 } }] });
  const state = { jobs: [first, structuredClone(first),
    closureJob('replicated:2', IMAGE, 'MainMissed', { events: [] }),
    closureJob('replicated:3', IMAGE, 'MainMissed', { events: [{ name: 'JobClosed', confirmed: false, args: { outcome: 'MainMissed' } }] }),
    closureJob('replicated:4', IMAGE, 'MainMissed', { events: [{ name: 'JobClosed', status: 0, args: { outcome: 'MainMissed' } }] }),
    closureJob('replicated:5', IMAGE, 'Unknown'),
    closureJob('replicated:6', IMAGE, 'Verified', { mode: 'checked' }),
    closureJob('checked:1', KEY, 'stale', { events: [{ name: 'JobClosed', args: { outcome: 3 } }] }),
    closureJob('checked:2', KEY, 'None'),
  ] };
  const image = getNetworkOutcomeStats(state, IMAGE);
  const nonce = getNetworkOutcomeStats(state, KEY);
  assert.equal(image.completed, 1, 'confirmed event overrides stale display flags and duplicate snapshots');
  assert.equal(image.mainResolved, 1);
  assert.equal(image.failureRate, 0);
  assert.equal(nonce.mainResolved, 1);
  assert.equal(nonce.missed, 1, 'numeric outcome 3 is MainMissed only in checked');
  assert.equal(nonce.failureRate, 100);
});

test('absent service history stays unavailable and never falls back to shared market counters', () => {
  const state = { providers: [withStats('A', 'checked', { completed: 123, missed: 3 })] };
  const empty = getNetworkOutcomeStats(state, RENDER);
  assert.equal(empty.mainResolved, 0);
  assert.equal(empty.completed, 0);
  assert.equal(empty.timeoutRate, null);
  assert.equal(empty.failureRate, null);
  assert.equal(empty.outvotedRate, null);
  assert.equal(empty.notFoundRate, null);
  assert.equal(getNetworkOutcomeStats({}, IMAGE).timeoutRate, null);
  assert.equal(getNetworkOutcomeStats(state, 'nonce-search-v1').mode, null);
});

test('missing checked item evidence does not fabricate found counts or mark a delivered task as failed', () => {
  const state = { jobs: [closureJob('checked:1', KEY, 'Delivered', { solved: 4,
    events: [{ name: 'ResultsSubmitted', args: { found: [true, false, 'false', false] } },
      { name: 'JobClosed', args: { outcome: 'Delivered' } }] })] };
  const stats = getNetworkOutcomeStats(state, KEY);
  assert.equal(stats.completed, 1);
  assert.equal(stats.failureRate, 0);
  assert.equal(stats.itemsSolved, null);
  assert.equal(stats.itemsReported, null);
  assert.equal(stats.notFoundRate, null);
});


test('rented machine identities follow the current customer active rentals rather than supplied machines or stale aliases', () => {
  const account = { id: 'user-1', address: '0xClient1' };
  const state = { account, providers: [
    provider('A', '1', { ownerId: 'user-1' }), provider('B', '1', { ownerId: 'user-2' }),
    provider('C', '1', { ownerId: 'user-3' }), provider('D', '1', { ownerId: 'user-1' }),
  ], jobs: [
    { id: 'replicated:1', clientId: account.id, provider: 'A', closed: false,
      events: [{ name: 'JobCreated', args: { client: '0xclient1', main: '0xb' } }] },
    { id: 'checked:1', clientId: account.id, provider: 'B', closed: false },
    { id: 'checked:2', clientId: account.id, provider: 'C', closed: true },
    { id: 'checked:3', clientId: account.id, provider: 'C', closed: false,
      events: [{ name: 'JobClosed', args: { outcome: 'Delivered' } }] },
    { id: 'replicated:2', clientId: 'user-2', clientAddress: '0xClient2', provider: 'A', closed: false },
    { id: 'checked:4', clientId: account.id, provider: 'D', closed: false,
      events: [{ name: 'JobCreated', confirmed: false, args: { main: '0xc' } }] },
    { id: 'checked:5', clientId: account.id, provider: 'unknown-machine', closed: false },
  ] };
  const before = structuredClone(state);
  const rented = getRentedProviderIds(state);
  assert.deepEqual(rented, ['B', 'D']);
  assert.ok(Object.isFrozen(rented));
  assert.deepEqual(getRentedProviderIds(state, { account: null }), []);
  assert.deepEqual(getRentedProviderIds(state, { account: { id: 'user-2', address: '0xClient2' } }), ['A']);
  assert.deepEqual(state, before);
});
