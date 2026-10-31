import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { createDataClient } from '../src/data-client.js';

const job = (store, id) => store.getState().jobs.find((item) => item.id === id);
function finish(store, id) {
  let limit = 20;
  while (!job(store, id).closed && limit-- > 0) store.advanceJob(id);
  assert.equal(job(store, id).closed, true, 'scenario must reach closure');
  return job(store, id);
}
function until(store, id, phase) {
  let limit = 20;
  while (job(store, id).phase !== phase && limit-- > 0) store.advanceJob(id);
  assert.equal(job(store, id).phase, phase);
}

test('initial demo has two settled jobs and one genuinely waiting for C to reveal', () => {
  const state = createDemoStore().getState();
  assert.equal(state.network.mode, 'demo');
  assert.equal(state.network.latestBlock, 25);
  assert.deepEqual(state.jobs.map((item) => item.outcome), ['Delivered', 'Verified', null]);
  const third = state.jobs[2];
  assert.equal(third.phase, 'CheckReveal');
  assert.equal(third.coverage, 100);
  assert.equal(third.progress.revealB, 'done');
  assert.equal(third.progress.revealC, 'current');
  assert.equal(third.progress.publish, 'pending');
  assert.equal(third.progress.settle, 'pending');
  assert.equal(state.account.balance, '9.900');
  assert.equal(state.account.locked, '0.040');
  assert.equal(state.account.settledNet, '-0.060');
});

test('verified and unverified creation hide the decision and lock the same deposit', () => {
  const store = createDemoStore();
  const verified = store.createJob({ scenario: 'verified' });
  const unverified = store.createJob({ scenario: 'unverified' });
  assert.equal(job(store, verified).deposit, job(store, unverified).deposit);
  const creation = store.getState().transactions.filter((transaction) => [verified, unverified].includes(transaction.jobId));
  for (const transaction of creation) {
    assert.equal(transaction.value, '0.040');
    assert.equal('verify' in transaction.events[0].args, false);
    assert.equal(transaction.events[0].name, 'JobCreated');
  }
  assert.equal(job(store, verified).closed, false);
  assert.equal(creation[0].status, 1, 'a successful create receipt does not mean the job finished');
});

test('cancelling an owned Open job refunds all escrow without provider income, locks or penalties', () => {
  const store = createDemoStore();
  const before = store.getState();
  const id = store.createJob({ itemCount: 201, scenario: 'verified' });
  const created = job(store, id);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const state = store.cancelJob(id, before.account.id);
  const cancelled = job(store, id);
  assert.equal(notifications, 1);
  assert.equal(cancelled.closed, true);
  assert.equal(cancelled.phase, 'Closed');
  assert.equal(cancelled.outcome, 'Cancelled');
  assert.equal(cancelled.status, '已取消');
  assert.equal(cancelled.nextAction, null);
  assert.equal(cancelled.progress.create, 'done');
  assert.equal(cancelled.progress.accept, 'skipped');
  assert.equal(cancelled.progress.settle, 'done');
  assert.deepEqual(cancelled.settlement, {
    deposit: '0.0402', main: '0.000', verifierB: '0.000', verifierC: '0.000',
    tiebreak: '0.000', refund: '0.0402', slashed: '0.000', clientNet: '0.000',
  });
  assert.equal(state.account.balance, before.account.balance);
  assert.equal(state.account.locked, before.account.locked);
  assert.equal(state.account.net, before.account.net);
  assert.equal(state.account.settledNet, before.account.settledNet);
  assert.deepEqual(state.providers, before.providers, 'Open cancellation must not unlock or update any provider');
  const receipt = state.transactions.at(-1);
  assert.equal(receipt.method, 'cancel');
  assert.equal(receipt.from, before.account.address);
  assert.equal(receipt.value, '0.000');
  assert.equal(receipt.blockNumber, created.createdBlock + 1);
  assert.deepEqual(receipt.events.map((entry) => entry.name), ['Payout', 'JobClosed']);
  assert.equal(receipt.events[0].args.to, before.account.address);
  assert.equal(receipt.events[0].args.amount, '40200000000000000');
  assert.equal(receipt.events[0].args.amountEth, created.deposit);
  assert.equal(receipt.events[1].args.outcome, 'Cancelled');
  assert.deepEqual(cancelled.events.slice(-2), receipt.events);
  assert.equal(state.blocks[0].number, 0);
  const after = store.getState();
  assert.throws(() => store.cancelJob(id), /仅待接单/);
  assert.deepEqual(store.getState(), after);
});

test('cancellation requires current account ownership and an explicit clientId cannot impersonate its owner', () => {
  const store = createDemoStore();
  const owner = store.getState().account.id;
  const id = store.createJob({ scenario: 'unverified' });
  const other = store.registerAccount({ name: '另一账户', address: `0x${'a'.repeat(40)}` });
  const otherSelected = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  for (const claimed of [undefined, owner, other]) {
    assert.throws(() => store.cancelJob(id, claimed), /当前账户/);
    assert.deepEqual(store.getState(), otherSelected);
  }
  assert.equal(notifications, 0);
  store.selectAccount(owner);
  const ownerSelected = store.getState();
  notifications = 0;
  assert.throws(() => store.cancelJob(id, other), /当前账户/);
  assert.deepEqual(store.getState(), ownerSelected);
  assert.equal(notifications, 0);
  const cancelled = store.cancelJob(id);
  assert.equal(cancelled.jobs.find((entry) => entry.id === id).outcome, 'Cancelled');
  assert.deepEqual(cancelled.users.find((entry) => entry.id === other), otherSelected.account, 'refund belongs only to the job owner');
});

test('accepted, closed and unknown jobs cannot be cancelled and rejected calls leave state untouched', () => {
  const store = createDemoStore();
  const id = store.createJob({ scenario: 'unverified' });
  store.advanceJob(id);
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  for (const target of [id, 'replicated:1', '999']) {
    assert.throws(() => store.cancelJob(target), /仅待接单|任务不存在/);
    assert.deepEqual(store.getState(), before);
  }
  assert.equal(notifications, 0);
  assert.equal(job(store, id).phase, 'Committing');
  assert.equal(store.getState().providers.find((entry) => entry.id === 'A').lockedJobs, before.providers.find((entry) => entry.id === 'A').lockedJobs);
});

test('both verifier commitments precede every reveal; each transaction confirms one action', () => {
  const store = createDemoStore();
  const id = store.createJob({ provider: 'E', scenario: 'verified' });
  until(store, id, 'Checking');
  assert.deepEqual(job(store, id).verifiers, ['A', 'B']);
  assert.equal(job(store, id).verifiers.includes('E'), false);
  for (let index = 0; index < 3; index += 1) store.advanceJob(id);
  assert.equal(job(store, id).phase, 'Checking');
  assert.equal(job(store, id).progress.revealB, 'pending');
  assert.equal(job(store, id).coverage, 0);
  store.advanceJob(id);
  assert.equal(job(store, id).phase, 'CheckReveal');
  assert.equal(job(store, id).progress.revealB, 'current');
  assert.equal(job(store, id).progress.revealC, 'current');
  store.advanceJob(id);
  assert.equal(job(store, id).coverage, 100);
  assert.equal(job(store, id).closed, false);
  const result = finish(store, id);
  const commitments = result.events.filter((entry) => entry.name === 'CheckCommitted');
  const reveals = result.events.filter((entry) => entry.name === 'CheckRevealed');
  assert.equal(commitments.length, 2);
  assert.ok(Math.max(...commitments.map((entry) => entry.blockNumber)) < Math.min(...reveals.map((entry) => entry.blockNumber)));
});

for (const [scenario, outcome, clientNet, refund, slashed] of [
  ['unverified', 'Delivered', '-0.020', '0.020', '0.000'],
  ['verified', 'Verified', '-0.040', '0.000', '0.000'],
  ['main-cheat', 'MainOutvoted', '0.278', '0.318', '0.300'],
  ['verifier-cheat', 'VerifierOutvoted', '0.578', '0.618', '0.600'],
]) {
  test(`${scenario} matches contract outcome, money conservation, and atomic closing receipt`, () => {
    const store = createDemoStore();
    const before = Number(store.getState().account.balance);
    const id = store.createJob({ scenario });
    const result = finish(store, id);
    assert.equal(result.outcome, outcome);
    assert.equal(result.settlement.clientNet, clientNet);
    assert.equal(result.settlement.refund, refund);
    assert.equal(result.settlement.slashed, slashed);
    assert.ok(Math.abs(Number(store.getState().account.balance) - before - Number(clientNet)) < 1e-9);
    const { deposit, main, verifierB, verifierC, tiebreak } = result.settlement;
    assert.ok(Math.abs(Number(deposit) + Number(slashed) - Number(main) - Number(verifierB) - Number(verifierC) - Number(tiebreak) - Number(refund)) < 1e-9);
    const finalReceipt = store.getState().transactions.at(-1);
    assert.equal(finalReceipt.method, scenario.includes('cheat') ? 'submitTiebreak' : 'publishResults');
    assert.ok(finalReceipt.events.some((entry) => entry.name === 'Payout'));
    assert.ok(finalReceipt.events.some((entry) => entry.name === 'JobClosed'));
    assert.equal(result.progress.settle, 'done');
    assert.equal(result.nextAction, null);
    assert.throws(() => store.advanceJob(id), /任务已结束/);
  });
}

test('deadline passage does not itself mine an expire, slash stake, or close a job', () => {
  const store = createDemoStore();
  const id = store.createJob({ provider: 'F', scenario: 'main-offline' });
  assert.throws(() => store.expireJob(id), /截止时间/);
  store.advanceJob(id);
  assert.equal(job(store, id).nextAction, 'wait');
  assert.throws(() => store.advanceJob(id), /expire/);
  const before = store.getState();
  assert.equal(job(store, id).deadline, before.transactions.at(-1).timestamp + 600 + job(store, id).itemCount);
  store.passDeadline(id);
  const waiting = store.getState();
  assert.equal(waiting.transactions.length, before.transactions.length);
  assert.deepEqual(waiting.blocks, before.blocks);
  assert.equal(job(store, id).phase, 'Committing');
  assert.equal(job(store, id).closed, false);
  assert.equal(job(store, id).nextAction, 'expire');
  assert.equal(waiting.providers.find((provider) => provider.id === 'F').stake, '1.000');
  store.expireJob(id);
  assert.equal(job(store, id).outcome, 'MainMissed');
  assert.equal(job(store, id).settlement.clientNet, '0.100');
  assert.equal(store.getState().transactions.length, before.transactions.length + 1);
  assert.ok(store.getState().transactions.at(-1).timestamp > job(store, id).deadline);
  assert.equal(store.getState().providers.find((provider) => provider.id === 'F').stake, '0.900');
  assert.equal(store.getState().providers.find((provider) => provider.id === 'F').active, true, 'active means sufficient stake, not online');
});

for (const [scenario, expectedMismatches] of [['main-cheat', 40], ['verifier-cheat', 200]]) {
  test(`${scenario} records actual differing leaves and a majority consistent with its outcome`, () => {
    const store = createDemoStore();
    const id = store.createJob({ scenario });
    const result = finish(store, id);
    const main = result.events.find((entry) => entry.name === 'ResultsPublished').args.leaves;
    const checks = result.events.filter((entry) => entry.name === 'CheckRevealed').flatMap((entry) => entry.args.leaves);
    const mismatched = main.flatMap((leaf, index) => leaf !== checks[index] ? [index] : []);
    assert.equal(mismatched.length, expectedMismatches);
    assert.equal(result.mismatches, expectedMismatches);
    const tie = result.events.find((entry) => entry.name === 'TiebreakSubmitted').args.leaves;
    mismatched.forEach((index, offset) => {
      assert.equal(tie[offset], scenario === 'main-cheat' ? checks[index] : main[index]);
    });
  });
}

test('a main-node conviction preserves its disputed output and suspends insufficient stake', () => {
  const store = createDemoStore();
  const id = store.createJob({ provider: 'E', scenario: 'main-cheat' });
  until(store, id, 'TieBreak');
  const published = job(store, id).results;
  const result = finish(store, id);
  assert.deepEqual(result.results, published, 'majority adjudication does not repair the client output');
  assert.match(result.resultWarning, /不会自动修复/);
  assert.ok(result.results.some((row) => row.disputed));
  const provider = store.getState().providers.find((item) => item.id === 'E');
  assert.equal(provider.stake, '0.700');
  assert.equal(provider.active, false);
  assert.equal(provider.outvoted, 1);
  assert.throws(() => store.createJob({ provider: 'E' }), /质押不足/);
});

test('odd item counts split by integer range boundaries without losing a fee or an item', () => {
  const store = createDemoStore();
  const id = store.createJob({ itemCount: 201, scenario: 'verified' });
  const result = finish(store, id);
  assert.equal(result.coverage, 201);
  assert.equal(result.settlement.verifierB, '0.010');
  assert.equal(result.settlement.verifierC, '0.0101');
  assert.equal(result.settlement.deposit, '0.0402');
  assert.equal(result.settlement.refund, '0.000');
});

test('blocks link to parents and receipts/events are consistent across every view', () => {
  const state = createDemoStore().getState();
  state.blocks.forEach((block, index) => {
    if (index) assert.equal(block.parentHash, state.blocks[index - 1].hash);
    let logIndex = 0;
    let totalGas = 0;
    block.transactions.forEach((hash, transactionIndex) => {
      const transaction = state.transactions.find((item) => item.hash === hash);
      assert.equal(transaction.blockNumber, block.number);
      assert.equal(transaction.blockHash, block.hash);
      assert.equal(transaction.transactionIndex, transactionIndex);
      assert.equal(transaction.timestamp, block.timestamp);
      totalGas += transaction.gasUsed;
      transaction.events.forEach((entry) => {
        assert.equal(entry.transactionHash, transaction.hash);
        assert.equal(entry.transactionIndex, transactionIndex);
        assert.equal(entry.blockHash, block.hash);
        assert.equal(entry.logIndex, logIndex++);
        assert.ok(state.jobs.find((item) => item.id === transaction.jobId).events.some((item) => item.transactionHash === entry.transactionHash && item.logIndex === entry.logIndex));
      });
    });
    assert.equal(block.gasUsed, totalGas);
  });
});

test('several independent job creations share one block with ordered receipts and block-wide logs', () => {
  const store = createDemoStore();
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const batch = store.createJobsInBlock([
    { provider: 'A', itemCount: 200, scenario: 'verified' },
    { provider: 'B', itemCount: 1, scenario: 'unverified' },
    { provider: 'C', itemCount: 201, scenario: 'main-cheat' },
  ]);
  const state = store.getState();
  const block = state.blocks.at(-1);
  const receipts = state.transactions.slice(-3);
  assert.deepEqual(batch.jobIds, ['replicated:4', 'replicated:5', 'replicated:6']);
  assert.equal(block.number, 26);
  assert.equal(batch.blockNumber, block.number);
  assert.equal(batch.blockHash, block.hash);
  assert.deepEqual(batch.transactionHashes, block.transactions);
  assert.equal(state.blocks.length, before.blocks.length + 1);
  assert.equal(state.transactions.length, before.transactions.length + 3);
  assert.equal(block.timestamp, before.network.timestamp + 12);
  assert.equal(block.parentHash, before.blocks.at(-1).hash);
  assert.equal(new Set(state.transactions.map((entry) => entry.hash)).size, state.transactions.length);
  assert.equal(block.gasUsed, receipts.reduce((sum, entry) => sum + entry.gasUsed, 0));
  assert.equal(state.account.balance, '9.8196');
  assert.equal(state.account.locked, '0.1204');
  assert.equal(notifications, 1);
  receipts.forEach((receipt, index) => {
    assert.equal(receipt.method, 'createJob');
    assert.equal(receipt.jobId, batch.jobIds[index]);
    assert.equal(receipt.blockNumber, block.number);
    assert.equal(receipt.blockHash, block.hash);
    assert.equal(receipt.timestamp, block.timestamp);
    assert.equal(receipt.transactionIndex, index);
    assert.equal(receipt.from, state.account.address);
    assert.equal(receipt.to, state.network.marketAddress);
    assert.equal(receipt.status, 1);
    assert.equal(receipt.events[0].name, 'JobCreated');
    assert.equal(receipt.events[0].logIndex, index);
    assert.equal(receipt.events[0].transactionIndex, index);
    assert.equal(receipt.events[0].transactionHash, receipt.hash);
    assert.equal(receipt.events[0].blockHash, block.hash);
    const created = job(store, receipt.jobId);
    assert.equal(created.createdBlock, block.number);
    assert.equal(created.updatedBlock, block.number);
    assert.deepEqual(created.events, receipt.events);
    assert.equal(created.closed, false, 'one confirmed creation receipt is not task completion');
    assert.equal(created.deadline, block.timestamp + 300);
  });
});

test('a rejected batch leaves no jobs, funds, blocks, sequence changes, or subscriber notifications', () => {
  const store = createDemoStore();
  const control = createDemoStore();
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  for (const inputs of [undefined, [], [{}], Array(7).fill({}), [{}, { provider: 'Z' }], [{}, { itemCount: 0 }], [{}, null]]) {
    assert.throws(() => store.createJobsInBlock(inputs));
    assert.deepEqual(store.getState(), before);
  }
  assert.equal(notifications, 0);
  const inputs = [{ provider: 'A' }, { provider: 'B' }];
  assert.deepEqual(store.createJobsInBlock(inputs), control.createJobsInBlock(inputs));
  assert.deepEqual(store.getState(), control.getState(), 'rejected batches consume neither block nor transaction identities');
  assert.equal(notifications, 1);
});

test('batch escrow validation includes all deposits before committing any task', () => {
  const store = createDemoStore();
  for (let index = 0; index < 48; index += 1) store.createJob({ itemCount: 1000 });
  const before = store.getState();
  assert.equal(before.account.balance, '0.300');
  assert.throws(() => store.createJobsInBlock([{ itemCount: 1000 }, { itemCount: 1000 }]), /余额不足/);
  assert.deepEqual(store.getState(), before);
});

test('jobs created in the same block advance and settle independently, then reset deterministically', () => {
  const store = createDemoStore();
  const initial = store.getState();
  const { jobIds, blockNumber, transactionHashes } = store.createJobsInBlock([
    { provider: 'A', scenario: 'unverified' },
    { provider: 'B', scenario: 'verified' },
    { provider: 'C', scenario: 'main-cheat' },
  ]);
  const untouched = job(store, jobIds[1]);
  store.advanceJob(jobIds[0]);
  assert.equal(job(store, jobIds[0]).phase, 'Committing');
  assert.equal(job(store, jobIds[0]).updatedBlock, blockNumber + 1);
  assert.deepEqual(job(store, jobIds[1]), untouched);
  const firstLaterTx = store.getState().transactions.at(-1);
  assert.equal(transactionHashes.includes(firstLaterTx.hash), false);
  assert.equal(firstLaterTx.transactionIndex, 0);
  assert.equal(firstLaterTx.events[0].logIndex, 0);
  assert.deepEqual(jobIds.map((id) => finish(store, id).outcome), ['Delivered', 'Verified', 'MainOutvoted']);
  assert.equal(store.getState().blocks.find((block) => block.number === blockNumber + 1).parentHash, store.getState().blocks.find((block) => block.number === blockNumber).hash);
  store.reset();
  assert.deepEqual(store.getState(), initial);
});

test('data client exposes same-block creation only when its adapter supplies the capability', () => {
  const store = createDemoStore();
  const client = createDataClient(store);
  assert.equal(typeof client.createJobsInBlock, 'function');
  assert.equal(client.createJobsInBlock([{}, {}]).jobIds.length, 2);
  const { createJobsInBlock, ...legacyAdapter } = createDemoStore();
  assert.equal('createJobsInBlock' in createDataClient(legacyAdapter), false);
});

test('snapshots and subscriber values cannot mutate state; reset is deterministic', () => {
  const store = createDemoStore();
  const initial = store.getState();
  const snapshot = store.getState();
  snapshot.jobs[0].events.length = 0;
  snapshot.providers[0].stake = '999.000';
  assert.deepEqual(store.getState(), initial);
  let notifications = 0;
  const unsubscribe = store.subscribe((value) => { notifications += 1; value.jobs.length = 0; });
  const id = store.createJob({ scenario: 'unverified' });
  assert.equal(notifications, 1);
  assert.equal(store.getState().jobs.length, 4);
  unsubscribe();
  store.advanceJob(id);
  assert.equal(notifications, 1);
  store.reset();
  assert.deepEqual(store.getState(), initial);
});

test('invalid form data is rejected before any deposit or transaction', () => {
  const store = createDemoStore();
  const before = store.getState();
  for (const itemCount of [0, 1001, 1.5, '200', NaN]) assert.throws(() => store.createJob({ itemCount }), /1–1000/);
  assert.throws(() => store.createJob({ taskType: 'nonce-search-v1' }), /仅已注册/);
  assert.throws(() => store.createJob({ provider: 'Z' }), /未注册/);
  assert.throws(() => store.createJob({ scenario: 'unknown' }), /未知/);
  assert.deepEqual(store.getState(), before);
});

test('no eligible tiebreaker closes NoMajority; verifier unavailability rejects atomically', () => {
  const store = createDemoStore();
  for (const provider of ['F', 'E', 'D']) {
    finish(store, store.createJob({ provider, scenario: 'main-cheat' }));
  }
  const tieJob = store.createJob({ provider: 'A', scenario: 'main-cheat' });
  until(store, tieJob, 'Publishing');
  store.advanceJob(tieJob);
  assert.equal(job(store, tieJob).outcome, 'NoMajority');
  assert.equal(job(store, tieJob).settlement.main, '0.000');
  assert.equal(job(store, tieJob).settlement.verifierB, '0.000');
  assert.equal(job(store, tieJob).settlement.verifierC, '0.010', 'an undisputed range still earns its verification fee');
  for (let index = 0; index < 3; index += 1) {
    const id = store.createJob({ provider: 'A', scenario: 'main-offline' });
    store.advanceJob(id);
    store.passDeadline(id);
    store.expireJob(id);
  }
  const checkJob = store.createJob({ provider: 'B', scenario: 'verified' });
  until(store, checkJob, 'Deciding');
  const noVerifier = store.getState();
  assert.throws(() => store.advanceJob(checkJob), /活跃复核节点不足/);
  assert.deepEqual(store.getState(), noVerifier);
});

test('global time travel expires other open tasks without fabricating their events or settlement', () => {
  const store = createDemoStore();
  const pending = job(store, 'replicated:3');
  const offlineId = store.createJob({ provider: 'F', scenario: 'main-offline' });
  store.advanceJob(offlineId);
  const before = store.getState();
  store.passDeadline(offlineId);
  const elapsed = store.getState();
  assert.ok(elapsed.network.timestamp > pending.deadline);
  assert.equal(elapsed.blocks.length, before.blocks.length);
  assert.equal(elapsed.transactions.length, before.transactions.length);
  const expired = job(store, 'replicated:3');
  assert.equal(expired.deadlinePassed, true);
  assert.equal(expired.phase, 'CheckReveal');
  assert.equal(expired.status, '超时待推进');
  assert.equal(expired.nextAction, 'unsupported-timeout');
  assert.equal(expired.closed, false);
  assert.equal(expired.outcome, null);
  assert.equal(expired.progress.revealB, 'done');
  assert.equal(expired.progress.revealC, 'pending');
  assert.equal(expired.progress.settle, 'pending');
  assert.deepEqual(expired.events, pending.events);
  assert.throws(() => store.advanceJob('replicated:3'), /截止时间/);
  assert.deepEqual(store.getState(), elapsed, 'a rejected reveal changes no local or chain state');
  store.expireJob(offlineId);
  assert.equal(job(store, offlineId).outcome, 'MainMissed');
  assert.equal(job(store, 'replicated:3').closed, false);
  assert.deepEqual(job(store, 'replicated:3').events, pending.events);
  const after = store.getState();
  assert.throws(() => store.expireJob('replicated:3'), /截止时间/);
  assert.deepEqual(store.getState(), after, 'unsupported expire cannot accidentally close the pending job');
});

test('mining any transaction refreshes other deadlines and the next-block guard is atomic', () => {
  const store = createDemoStore();
  const pending = job(store, 'replicated:3');
  for (let index = 0; index < 4; index += 1) finish(store, store.createJob({ scenario: 'unverified' }));
  const final = store.createJob({ scenario: 'unverified' });
  until(store, final, 'Publishing');
  const boundary = store.getState();
  assert.equal(boundary.network.timestamp, pending.deadline);
  assert.equal(job(store, 'replicated:3').deadlinePassed, false);
  assert.throws(() => store.advanceJob('replicated:3'), /下一块时间/);
  assert.deepEqual(store.getState(), boundary);
  store.advanceJob(final);
  const refreshed = job(store, 'replicated:3');
  assert.equal(refreshed.deadlinePassed, true);
  assert.equal(refreshed.nextAction, 'unsupported-timeout');
  assert.equal(refreshed.progress.revealB, 'done');
  assert.equal(refreshed.progress.revealC, 'pending');
  assert.deepEqual(refreshed.events, pending.events);
});
