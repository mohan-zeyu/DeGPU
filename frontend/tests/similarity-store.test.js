import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { createDataClient } from '../src/data-client.js';

const job = (store, id) => store.getState().jobs.find(entry => entry.id === id);
const wei = value => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')); };
function until(store, id, phase) {
  let attempts = 24;
  while (job(store, id).phase !== phase && attempts-- > 0) store.advanceJob(id);
  assert.equal(job(store, id).phase, phase);
}
const render = (store, input = {}) => store.createJob({ taskType: 'blender-render-v1', itemCount: 4, ...input });

test('full Python task registration separates comparison and market-local IDs', () => {
  const state = createDemoStore().getState();
  assert.deepEqual(state.taskTypes.map(({ id, chainId, mode, compare, secondsPerItem }) => [id, chainId, mode, compare, secondsPerItem]), [
    ['image-classify-v1', 2, 'replicated', 'exact', 1],
    ['blender-render-v1', 1, 'replicated', 'similar', 30],
    ['key-search-v1', 1, 'checked', undefined, 2],
  ]);
  assert.ok(state.providers.every(provider => !('nonce-search-v1' in provider.offers)));
});

test('render publication reveals file references and always stops for client review', () => {
  const store = createDemoStore();
  const id = render(store, { frames: [1, 7, 7, 12], sceneName: '产品.blend' });
  store.advanceJob(id);
  assert.equal(job(store, id).deadline, store.getState().transactions.at(-1).timestamp + 600 + 4 * 30);
  until(store, id, 'Disputing');
  const result = job(store, id);
  assert.equal(result.closed, false);
  assert.equal(result.progress.review, 'current');
  assert.equal(result.progress.settle, 'pending');
  assert.equal(result.deadline, store.getState().transactions.at(-1).timestamp + 300);
  assert.ok(result.resultsURI);
  assert.equal(result.verifierResultsURIs.length, 2);
  assert.equal(result.review.compared, false, 'the adapter does not claim to run the actual PNG metric');
  assert.equal(result.resultFilesAvailable, false);
  assert.deepEqual(result.results.map(row => row.frame), [1, 7, 7, 12]);
  assert.ok(result.results.every(row => row.filename.endsWith('.png') && row.digest && !row.verified));
  const published = result.events.find(entry => entry.name === 'ResultsPublished');
  const revealed = result.events.find(entry => entry.name === 'CheckRevealed');
  assert.notEqual(published.args.leaves[0], revealed.args.leaves[0], 'similar outputs need not have identical hashes');
  assert.equal(published.args.resultsURI, result.resultsURI);
  assert.equal(revealed.args.resultsURI, result.verifierResultsURIs[0]);
  store.acceptResults(id);
  const closed = job(store, id);
  assert.equal(closed.outcome, 'Verified');
  assert.equal(closed.closeMethod, 'acceptResults');
  assert.equal(closed.progress.review, 'done');
  assert.equal(closed.progress.dispute, 'skipped');
  assert.equal(closed.settlement.disputeBond, '0.000');
  assert.deepEqual(store.getState().transactions.at(-1).events.map(entry => entry.name), ['Payout', 'Payout', 'Payout', 'JobClosed']);
});

for (const [scenario, outcome, verdict] of [['main-cheat', 'MainOutvoted', 2], ['similar-missing', 'MainOutvoted', 2], ['verifier-cheat', 'VerifierOutvoted', 1], ['dispute-rejected', 'DisputeRejected', 3]]) {
  test(`${scenario}: dispute bond, verdict and closing receipt conserve all wei`, () => {
    const store = createDemoStore();
    const before = wei(store.getState().account.balance);
    const id = render(store, { scenario });
    until(store, id, 'Disputing');
    const submitted = store.getState();
    store.advanceJob(id);
    const disputed = job(store, id);
    assert.equal(disputed.phase, 'TieBreak');
    assert.equal(disputed.disputeBond, '0.002');
    assert.equal(wei(store.getState().account.balance), wei(submitted.account.balance) - wei('0.002'));
    assert.equal(wei(store.getState().account.locked), wei(submitted.account.locked) + wei('0.002'));
    const receipt = store.getState().transactions.at(-1);
    assert.equal(receipt.method, 'dispute');
    assert.equal(receipt.value, '0.002');
    assert.deepEqual(receipt.events.map(entry => entry.name), ['ResultsDisputed', 'TiebreakStarted']);
    store.advanceJob(id);
    store.advanceJob(id);
    const result = job(store, id);
    assert.equal(result.outcome, outcome);
    assert.ok(result.verdicts.every(value => value === verdict));
    assert.equal(result.closeMethod, 'submitJudgement');
    assert.equal(result.events.some(entry => entry.name === 'TiebreakSubmitted'), false);
    assert.equal(store.getState().transactions.at(-1).events[0].name, 'JudgementSubmitted');
    const s = result.settlement;
    assert.equal(wei(s.deposit) + wei(s.disputeBond) + wei(s.slashed), ['main', 'verifierB', 'verifierC', 'tiebreak', 'refund'].reduce((sum, key) => sum + wei(s[key]), 0n));
    assert.equal(wei(store.getState().account.balance), before + wei(s.refund) - wei(s.totalDeposited));
    assert.equal(wei(s.tiebreak), wei('0.002'));
    if (outcome === 'DisputeRejected') assert.equal(wei(s.slashed), 0n);
  });
}

test('a dispute of one verifier range penalizes only the owning verifier', () => {
  const store = createDemoStore();
  const id = render(store, { scenario: 'verifier-cheat' });
  until(store, id, 'Disputing');
  store.disputeResults(id, [0]);
  store.advanceJob(id);
  store.advanceJob(id);
  const result = job(store, id);
  assert.equal(result.outcome, 'VerifierOutvoted');
  assert.deepEqual(result.verifierStates, ['Outvoted', 'Revealed']);
  assert.equal(result.settlement.verifierB, '0.000');
  assert.equal(wei(result.settlement.verifierC), 2n * wei(result.unitPrice));
});

test('only client may accept or dispute; malformed disputes leave wallets, phase and receipts unchanged', () => {
  const store = createDemoStore();
  const id = render(store);
  until(store, id, 'Disputing');
  const clientId = store.getState().account.id;
  store.registerAccount({ name: '其他人', address: `0x${'b'.repeat(40)}` });
  const other = store.getState();
  assert.throws(() => store.acceptResults(id), /仅任务客户/);
  assert.throws(() => store.disputeResults(id, [0]), /仅任务客户/);
  assert.deepEqual(store.getState(), other);
  store.selectAccount(clientId);
  const before = store.getState();
  for (const items of [[], [-1], [4], [1, 0], [0, 0], [0.5], '0']) {
    assert.throws(() => store.disputeResults(id, items), /争议序号/);
    assert.deepEqual(store.getState(), before);
  }
  assert.throws(() => store.disputeResults('replicated:1', [0]), /结果检查阶段/);
  assert.deepEqual(store.getState(), before);
});

test('review deadline expiration closes without an automatic transaction or a dispute bond', () => {
  const store = createDemoStore();
  const id = render(store, { verify: false });
  until(store, id, 'Disputing');
  assert.equal(job(store, id).verifiers.length, 0);
  const before = store.getState();
  store.passDeadline(id);
  assert.equal(job(store, id).closed, false);
  assert.deepEqual(store.getState().transactions, before.transactions);
  assert.throws(() => store.disputeResults(id, [0]), /截止时间/);
  store.expireJob(id);
  assert.equal(job(store, id).outcome, 'Delivered');
  assert.equal(job(store, id).closeMethod, 'expire');
  assert.equal(job(store, id).disputeBond, '0.000');
});

test('frame zero, order and repeated inputs survive task creation and publication', () => {
  const store = createDemoStore();
  const id = render(store, { itemCount: 3, frames: [0, 2, 2] });
  assert.deepEqual(job(store, id).frames, [0, 2, 2]);
  until(store, id, 'Disputing');
  assert.deepEqual(job(store, id).results.map(row => row.frame), [0, 2, 2]);
  assert.deepEqual(job(store, id).results.map(row => row.filename), ['frame-0000.png', 'frame-0002.png', 'frame-0002.png']);
});

test('all twelve render frames have metadata without implying real output files', () => {
  const store = createDemoStore();
  const frames = Array.from({ length: 12 }, (_, index) => index + 1);
  const id = render(store, { itemCount: frames.length, frames });
  until(store, id, 'Disputing');
  const result = job(store, id);
  const leaves = result.events.find(entry => entry.name === 'ResultsPublished').args.leaves;
  assert.equal(result.results.length, 12);
  assert.deepEqual(result.results.map(row => row.frame), frames);
  assert.deepEqual(result.results.map(row => row.digest), leaves);
  assert.equal(result.results[11].filename, 'frame-0012.png');
  assert.ok(result.results.every(row => row.comparisonSource === 'local-protocol-fixture' && !row.verified));
  assert.equal(result.resultFilesAvailable, false);
  assert.equal(result.review.compared, false);
  assert.equal(result.executionSource, 'local-protocol-fixtures');
});

test('the client can accept after the review deadline while a new dispute is rejected atomically', () => {
  const store = createDemoStore();
  const id = render(store);
  until(store, id, 'Disputing');
  store.passDeadline(id);
  const expired = store.getState();
  assert.equal(job(store, id).phase, 'Disputing');
  assert.equal(job(store, id).closed, false);
  assert.throws(() => store.disputeResults(id, [0]), /争议截止时间/);
  assert.deepEqual(store.getState(), expired);
  store.acceptResults(id);
  assert.equal(job(store, id).outcome, 'Verified');
  assert.equal(job(store, id).closeMethod, 'acceptResults');
  assert.equal(store.getState().transactions.at(-1).method, 'acceptResults');
});

for (const shared of [false, true]) {
  test(`dispute timeout ${shared ? 'after sharing penalizes only the absent arbitrator' : 'without sharing refunds bond without paying arbitrator'}`, () => {
    const store = createDemoStore();
    const before = wei(store.getState().account.balance);
    const id = render(store, { scenario: 'main-cheat' });
    until(store, id, 'Disputing');
    store.disputeResults(id, [0]);
    const tie = job(store, id).tieProvider;
    const arbitrator = store.getState().providers.find(provider => provider.id === tie);
    if (shared) store.advanceJob(id);
    const waiting = store.getState();
    store.passDeadline(id);
    assert.equal(job(store, id).closed, false);
    assert.deepEqual(store.getState().transactions, waiting.transactions);
    store.expireJob(id);
    const result = job(store, id);
    const currentTie = store.getState().providers.find(provider => provider.id === tie);
    assert.equal(result.closeMethod, 'expire');
    assert.equal(result.outcome, shared ? 'TiebreakerMissed' : 'TieClientNoShare');
    assert.equal(result.settlement.tiebreak, '0.000');
    assert.equal(currentTie.checksCompleted, arbitrator.checksCompleted);
    assert.equal(currentTie.lockedJobs, arbitrator.lockedJobs - 1);
    assert.equal(wei(currentTie.stake), wei(arbitrator.stake) - (shared ? wei(arbitrator.stake) / 20n : 0n));
    assert.equal(currentTie.checksMissed, arbitrator.checksMissed + (shared ? 1 : 0));
    assert.equal(wei(result.settlement.main), shared ? 0n : wei(result.price));
    assert.equal(wei(result.settlement.verifierB), shared ? 0n : 2n * wei(result.unitPrice));
    assert.equal(wei(result.settlement.verifierC), 2n * wei(result.unitPrice));
    const s = result.settlement;
    assert.equal(wei(s.deposit) + wei(s.disputeBond) + wei(s.slashed), ['main', 'verifierB', 'verifierC', 'tiebreak', 'refund'].reduce((sum, key) => sum + wei(s[key]), 0n));
    assert.equal(wei(store.getState().account.balance), before + wei(s.refund) - wei(s.totalDeposited));
    assert.ok(wei(s.refund) >= wei('0.002'), 'a successful or unresolved dispute does not burn its bond');
    assert.equal(result.events.some(entry => entry.name === 'JudgementSubmitted'), false);
  });
}

test('render input validation is atomic and review actions remain optional adapter capabilities', () => {
  const store = createDemoStore();
  const before = store.getState();
  for (const frames of [[], [1], [1, 2, -1, 4], [1, 2, 3.5, 4], [1, 2, 3, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => render(store, { frames }), /帧列表/);
    assert.deepEqual(store.getState(), before);
  }
  const client = createDataClient(store);
  assert.equal(typeof client.acceptResults, 'function');
  assert.equal(typeof client.disputeResults, 'function');
  const { acceptResults, disputeResults, ...legacy } = store;
  assert.equal(createDataClient(legacy).acceptResults, undefined);
  assert.equal(createDataClient(legacy).disputeResults, undefined);
});
