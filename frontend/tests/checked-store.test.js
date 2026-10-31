import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { KEY_FIXTURES, checkedSubmission, keccak256, word } from '../src/checked-tasks.js';

const job = (store, id) => store.getState().jobs.find((entry) => entry.id === id);
const provider = (store, id = 'A') => store.getState().providers.find((entry) => entry.id === id);
const wei = (value) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')); };
const create = (store, input = {}) => store.createJob({ taskType: 'key-search-v1', itemCount: 8, ...input });

test('markets count IDs independently and mixed transactions can share one block', () => {
  const store = createDemoStore();
  const batch = store.createJobsInBlock([{ taskType: 'key-search-v1', itemCount: 8 }, {}, { taskType: 'key-search-v1', itemCount: 4 }]);
  assert.deepEqual(batch.jobIds, ['checked:1', 'replicated:4', 'checked:2']);
  const receipts = store.getState().transactions.slice(-3);
  assert.equal(new Set(receipts.map((entry) => entry.blockHash)).size, 1);
  assert.deepEqual(receipts.map((entry) => entry.chainJobId), [1, 4, 2]);
  assert.deepEqual(receipts.map((entry) => entry.events[0].args.jobId), [1, 4, 2]);
  assert.equal(receipts[0].to, store.getState().network.markets.checked);
  assert.equal(receipts[1].to, store.getState().network.markets.replicated);
  assert.equal(job(store, batch.jobIds[0]).deposit, '0.00096');
  assert.equal(job(store, batch.jobIds[0]).taskTypeId, 1);
  assert.equal(job(store, batch.jobIds[2]).taskTypeId, 1);
});

for (const [scenario, solved] of [['checked-success', 8], ['checked-partial', 4], ['checked-none', 0]]) {
  test(`${scenario}: only found and verified items receive payment; all submissions count as completed`, () => {
    const store = createDemoStore();
    const before = provider(store);
    const balance = wei(store.getState().account.balance);
    const id = create(store, { scenario });
    store.advanceJob(id);
    assert.equal(job(store, id).phase, 'Working');
    assert.equal(job(store, id).deadline, store.getState().transactions.at(-1).timestamp + 300 + 16);
    assert.equal(provider(store).lockedJobs, before.lockedJobs + 1);
    store.advanceJob(id);
    const result = job(store, id);
    assert.equal(result.outcome, 'Delivered');
    assert.equal(result.solved, solved);
    assert.equal(result.closeMethod, 'submitResults');
    assert.equal(result.verifiers.length, 0);
    assert.equal(wei(result.settlement.main), BigInt(solved) * wei(result.unitPrice));
    assert.equal(wei(result.settlement.refund), BigInt(8 - solved) * wei(result.unitPrice));
    assert.equal(wei(store.getState().account.balance), balance - wei(result.settlement.main));
    assert.deepEqual(provider(store).statsByMode.replicated, before.statsByMode.replicated);
    assert.deepEqual(provider(store).statsByMode.checked, { completed: 1, missed: 0, itemsSolved: solved, itemsNotFound: 8 - solved });
    assert.equal(provider(store).lockedJobs, before.lockedJobs);
    const receipt = store.getState().transactions.at(-1);
    assert.deepEqual(receipt.events.map((entry) => entry.name), ['ResultsSubmitted', 'Payout', ...(solved && solved !== 8 ? ['Payout'] : []), 'JobClosed']);
    assert.deepEqual(receipt.events[0].args.answers, result.answers);
    assert.deepEqual(receipt.events[0].args.found, result.found);
    assert.ok(result.results.every((row) => row.found ? typeof row.key === 'string' && row.verified : row.key === null && !row.verified));
  });
}

test('incorrect answer, item commitment, sender, length and ABI types reject the entire submission atomically', () => {
  const store = createDemoStore();
  const id = create(store);
  store.advanceJob(id);
  const valid = checkedSubmission(job(store, id));
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const invalids = [
    { ...valid, answers: [word(217), ...valid.answers.slice(1)] },
    { ...valid, items: [KEY_FIXTURES[1].item, ...valid.items.slice(1)] },
    { ...valid, providerId: 'B' },
    { ...valid, found: valid.found.slice(1) },
    { ...valid, answers: ['0x00', ...valid.answers.slice(1)] },
    { ...valid, found: [1, ...valid.found.slice(1)] },
  ];
  for (const submission of invalids) {
    assert.throws(() => store.submitResults(id, submission));
    assert.deepEqual(store.getState(), before);
  }
  assert.equal(notifications, 0);
  store.submitResults(id, valid);
  assert.equal(store.getState().transactions.length, before.transactions.length + 1);
  assert.equal(store.getState().blocks.length, before.blocks.length + 1);
});

test('not-found ignores an ABI-valid answer, does not pay or slash, and does not prove nonexistence', () => {
  const store = createDemoStore();
  const before = provider(store);
  const id = create(store, { itemCount: 1, fixtureIds: ['key-impossible'] });
  store.advanceJob(id);
  store.submitResults(id, { answers: [word((1n << 256n) - 1n)], found: [false] });
  assert.equal(job(store, id).solved, 0);
  assert.equal(job(store, id).outcome, 'Delivered');
  assert.equal(provider(store).stake, before.stake);
  assert.equal(provider(store).statsByMode.checked.completed, 1);
  assert.equal(provider(store).statsByMode.checked.itemsNotFound, 1);
});

test('raw key inputs and uint256 answers are not limited to the built-in search range', () => {
  const store = createDemoStore();
  const key = (1n << 200n) + 42n;
  const item = `${keccak256(word(key))}${word(key).slice(2)}${word(key + 1n).slice(2)}`;
  const id = create(store, { taskType: 'key-search-v1', itemCount: 1, items: [item] });
  store.advanceJob(id);
  store.submitResults(id, { answers: [word(key)], found: [true] });
  assert.equal(job(store, id).results[0].key, key.toString());
  assert.equal(job(store, id).results[0].answer.length, 66);
});

test('expired Open jobs refund the owner without locks or reputation changes', () => {
  const store = createDemoStore();
  const before = store.getState();
  const id = create(store);
  const created = store.getState();
  store.passDeadline(id);
  assert.deepEqual(store.getState().blocks, created.blocks);
  assert.equal(job(store, id).closed, false);
  assert.equal(job(store, id).nextAction, 'expire');
  store.expireJob(id);
  assert.equal(job(store, id).outcome, 'Cancelled');
  assert.equal(job(store, id).closeMethod, 'expire');
  assert.equal(store.getState().account.balance, before.account.balance);
  assert.deepEqual(store.getState().providers, before.providers);
});

test('Working timeout slashes current shared stake by ten percent and updates only checked missed', () => {
  const store = createDemoStore();
  const before = provider(store);
  const id = create(store, { scenario: 'checked-offline' });
  store.advanceJob(id);
  assert.throws(() => store.expireJob(id), /截止时间/);
  const working = store.getState();
  store.passDeadline(id);
  assert.deepEqual(store.getState().blocks, working.blocks);
  assert.equal(job(store, id).closed, false);
  const passed = store.getState();
  assert.throws(() => store.submitResults(id, checkedSubmission(job(store, id))), /截止时间/);
  assert.deepEqual(store.getState(), passed);
  store.expireJob(id);
  const result = job(store, id);
  assert.equal(result.outcome, 'MainMissed');
  assert.equal(result.settlement.slashed, '0.100');
  assert.equal(provider(store).stake, '0.900');
  assert.equal(provider(store).lockedJobs, before.lockedJobs);
  assert.deepEqual(provider(store).statsByMode.checked, { completed: 0, missed: 1, itemsSolved: 0, itemsNotFound: 0 });
  assert.deepEqual(provider(store).statsByMode.replicated, before.statsByMode.replicated);
  assert.deepEqual(store.getState().transactions.at(-1).events.map((entry) => entry.name), ['ProviderSlashed', 'Payout', 'JobClosed']);
});

test('Open cancellation returns a single-price deposit and does not unlock another market task', () => {
  const store = createDemoStore();
  const before = store.getState();
  const id = create(store);
  store.cancelJob(id);
  assert.equal(job(store, id).closeMethod, 'cancel');
  assert.equal(store.getState().account.balance, before.account.balance);
  assert.deepEqual(store.getState().providers, before.providers);
});

test('accept and submit allow the exact deadline but reject the following block without mutation', () => {
  const store = createDemoStore();
  const id = create(store, { itemCount: 6 });
  const acceptDeadline = job(store, id).deadline;
  for (let index = 0; index < 24; index += 1) store.createJob({ itemCount: 1 });
  store.advanceJob(id);
  assert.equal(store.getState().transactions.at(-1).timestamp, acceptDeadline);
  for (let index = 0; index < 25; index += 1) store.createJob({ itemCount: 1 });
  store.submitResults(id, checkedSubmission(job(store, id)));
  assert.equal(store.getState().transactions.at(-1).timestamp, job(store, id).deadline);
  const late = create(store, { itemCount: 6 });
  store.advanceJob(late);
  for (let index = 0; index < 26; index += 1) store.createJob({ itemCount: 1 });
  const before = store.getState();
  assert.throws(() => store.submitResults(late, checkedSubmission(job(store, late))), /下一块时间/);
  assert.deepEqual(store.getState(), before);
});

test('a rejected fixture can be corrected; local rejection metadata never creates a receipt', () => {
  const store = createDemoStore();
  const id = create(store, { scenario: 'checked-invalid' });
  store.advanceJob(id);
  const before = store.getState();
  assert.throws(() => store.advanceJob(id), /未通过链上校验/);
  const rejected = store.getState();
  const rejectedJob = rejected.jobs.find((entry) => entry.id === id);
  assert.equal(rejectedJob.lastRejected.confirmed, false);
  assert.match(rejectedJob.lastSubmissionError, /未通过链上校验/);
  delete rejectedJob.lastRejected;
  delete rejectedJob.lastSubmissionError;
  assert.deepEqual(rejected, before);
  store.advanceJob(id);
  assert.equal(job(store, id).closed, true);
  assert.equal(job(store, id).lastSubmissionError, undefined);
  assert.equal(job(store, id).events.filter((entry) => entry.name === 'ResultsSubmitted').length, 1);
});

test('invalid checked job parameters are rejected before escrow or sequence changes', () => {
  const store = createDemoStore();
  const before = store.getState();
  for (const input of [{ itemCount: 0 }, { itemCount: 1001 }, { itemCount: 1.5 }, { itemCount: 2, items: ['0x00'] },
    { itemCount: 1, items: ['not-hex'] }, { itemCount: 2, fixtureIds: ['key-1'] }, { scenario: 'main-cheat' }, { mode: 'replicated' }]) {
    assert.throws(() => create(store, input));
    assert.deepEqual(store.getState(), before);
  }
});

test('removed mining service is rejected before escrow or sequence changes', () => {
  const store = createDemoStore();
  const before = store.getState();
  assert.throws(() => store.createJob({ taskType: 'nonce-search-v1' }), /仅已注册/);
  assert.deepEqual(store.getState(), before);
});
