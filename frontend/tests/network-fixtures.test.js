import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { NETWORK_PROVIDERS } from '../src/network-fixtures.js';
import { getMarketStats } from '../src/market.js';

const WEI = 10n ** 18n;
function wei(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'));
}
function finish(store, id) {
  let attempts = 24;
  while (!store.getState().jobs.find((job) => job.id === id).closed && attempts-- > 0) store.advanceJob(id);
  return store.getState().jobs.find((job) => job.id === id);
}

test('network history spans accounts, prices, outcomes and a contiguous chain from genesis', () => {
  const state = createDemoStore({ profile: 'network' }).getState();
  assert.equal(state.users.length, 12);
  assert.equal(state.providers.length, 16);
  assert.ok(state.jobs.filter((job) => job.closed).length >= 80);
  assert.equal(new Set(state.jobs.map((job) => job.clientId)).size, 12);
  assert.ok(new Set(state.providers.map((provider) => provider.pricePerItem)).size >= 12);
  assert.ok(new Set(state.providers.map((provider) => provider.verified + provider.unverified)).size >= 10);
  assert.deepEqual(state.blocks[0], {
    number: 0, hash: `0xd3b1${'0'.repeat(60)}`, parentHash: `0x${'0'.repeat(64)}`,
    timestamp: 1792807200, transactions: [], gasUsed: 0,
  });
  for (let index = 1; index < state.blocks.length; index += 1) {
    assert.equal(state.blocks[index].number, index);
    assert.equal(state.blocks[index].parentHash, state.blocks[index - 1].hash);
  }
  assert.equal(state.network.latestBlock, state.blocks.at(-1).number);
  for (const outcome of ['Delivered', 'Verified', 'MainMissed', 'MainOutvoted', 'VerifierOutvoted']) {
    assert.ok(state.jobs.some((job) => job.outcome === outcome), outcome);
  }
  const live = state.jobs.filter((job) => !job.closed);
  assert.equal(live.length, 8);
  assert.equal(new Set(live.map((job) => job.phase)).size, 6);
  assert.ok(live.every((job) => !job.deadlinePassed));
  const grouped = state.blocks.find((block) => block.transactions.length === 3);
  assert.ok(grouped);
  const receipts = state.transactions.filter((transaction) => transaction.blockNumber === grouped.number);
  assert.equal(new Set(receipts.map((receipt) => receipt.from)).size, 3);
  assert.deepEqual(receipts.map((receipt) => receipt.transactionIndex), [0, 1, 2]);
  assert.deepEqual(receipts.map((receipt) => receipt.events[0].logIndex), [0, 1, 2]);
});

test('every seeded reputation counter is explained by public participation and settlement', () => {
  const state = createDemoStore({ profile: 'network' }).getState();
  for (const provider of state.providers) {
    const main = state.jobs.filter((job) => job.mode === 'replicated' && job.provider === provider.id && job.closed);
    assert.equal(provider.verified, main.filter((job) => (['Verified', 'VerifierOutvoted'].includes(job.outcome) || job.outcome === 'DisputeRejected' && job.verifierStates.includes('Revealed'))).length);
    assert.equal(provider.unverified, main.filter((job) => job.outcome === 'Delivered').length);
    assert.equal(provider.missed, main.filter((job) => job.outcome === 'MainMissed').length);
    assert.equal(provider.outvoted, main.filter((job) => job.outcome === 'MainOutvoted').length);
    const checks = state.jobs.flatMap((job) => job.verifiers.flatMap((id, slot) => id === provider.id ? [{ job, slot }] : []));
    assert.equal(provider.checksCompleted, checks.filter(({ job, slot }) => job.closed && job.verifierStates[slot] === 'Revealed').length
      + state.jobs.filter((job) => job.closed && job.tieProvider === provider.id).length);
    assert.equal(provider.checksMissed, checks.filter(({ job, slot }) => job.verifierStates[slot] === 'Missed').length);
    assert.equal(provider.checksOutvoted, checks.filter(({ job, slot }) => job.verifierStates[slot] === 'Outvoted').length);
    const slashLogs = state.jobs.flatMap((job) => job.events.filter((entry) => entry.name === 'ProviderSlashed'
      && entry.args.provider === provider.address));
    const checked = state.jobs.filter((job) => job.mode === 'checked' && job.provider === provider.id && job.closed);
    const delivered = checked.filter((job) => job.outcome === 'Delivered');
    assert.deepEqual(provider.statsByMode.checked, {
      completed: delivered.length,
      missed: checked.filter((job) => job.outcome === 'MainMissed').length,
      itemsSolved: delivered.reduce((sum, job) => sum + job.solved, 0),
      itemsNotFound: delivered.reduce((sum, job) => sum + job.itemCount - job.solved, 0),
    });
    assert.equal(slashLogs.length, provider.missed + provider.outvoted + provider.checksMissed + provider.checksOutvoted + provider.statsByMode.checked.missed);
    assert.equal(wei(provider.stake), wei(NETWORK_PROVIDERS.find((entry) => entry.id === provider.id).stake)
      - slashLogs.reduce((sum, entry) => sum + BigInt(entry.args.amount), 0n));
    const earned = state.jobs.flatMap((job) => job.events.filter((entry) => entry.name === 'Payout'
      && entry.args.to === provider.address)).reduce((sum, entry) => sum + BigInt(entry.args.amount), 0n);
    assert.equal(wei(provider.earned), earned);
    const locked = state.jobs.filter((job) => !job.closed && ((job.provider === provider.id && job.phase !== 'Open')
      || (job.verifiers.includes(provider.id) && job.verifierStates[job.verifiers.indexOf(provider.id)] !== 'Missed')
      || job.tieProvider === provider.id)).length;
    assert.equal(provider.lockedJobs, locked);
  }
  assert.ok(state.providers.some((provider) => provider.checksMissed > 0));
  assert.ok(state.providers.some((provider) => !provider.active && provider.outvoted + provider.checksOutvoted > 0));
});

test('seeded escrows, settlements, stakes and per-user wallets conserve all wei', () => {
  const state = createDemoStore({ profile: 'network' }).getState();
  for (const job of state.jobs) {
    const account = state.users.find((user) => user.id === job.clientId);
    assert.equal(job.clientAddress, account.address);
    const creation = state.transactions.find((transaction) => transaction.jobId === job.id && transaction.method === 'createJob');
    assert.equal(creation.from, account.address);
    assert.equal(creation.events[0].args.client, account.address);
    assert.equal(wei(job.price), BigInt(job.itemCount) * wei(job.unitPrice));
    if (!job.closed) continue;
    const settlement = job.settlement;
    assert.equal(wei(settlement.deposit) + wei(settlement.disputeBond ?? '0') + wei(settlement.slashed),
      ['main', 'verifierB', 'verifierC', 'tiebreak', 'refund'].reduce((sum, key) => sum + wei(settlement[key]), 0n));
  }
  for (const account of state.users) {
    const ownJobs = state.jobs.filter((job) => job.clientId === account.id);
    const deposits = ownJobs.reduce((sum, job) => sum + wei(job.deposit) + wei(job.disputeBond ?? '0'), 0n);
    const refunds = ownJobs.filter((job) => job.closed).reduce((sum, job) => sum + wei(job.settlement.refund), 0n);
    const locked = ownJobs.filter((job) => !job.closed).reduce((sum, job) => sum + wei(job.deposit) + wei(job.disputeBond ?? '0'), 0n);
    assert.equal(wei(account.deposited), deposits);
    assert.equal(wei(account.returned), refunds);
    assert.equal(wei(account.locked), locked);
    assert.equal(wei(account.balance), wei(account.initialBalance) - deposits + refunds);
  }
  const initial = state.users.reduce((sum, account) => sum + wei(account.initialBalance), 0n)
    + NETWORK_PROVIDERS.reduce((sum, provider) => sum + wei(provider.stake), 0n);
  const actual = state.users.reduce((sum, account) => sum + wei(account.balance) + wei(account.locked), 0n)
    + state.providers.reduce((sum, provider) => sum + wei(provider.stake) + wei(provider.earned), 0n);
  assert.equal(actual, initial);
});

test('account switching, registration and mixed-user escrow stay independent and atomic', () => {
  const store = createDemoStore();
  const first = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const accountId = store.registerAccount({ name: '新用户', address: '0xc000000000000000000000000000000000000001' });
  assert.equal(store.getState().account.id, accountId);
  assert.equal(store.getState().account.balance, '10.000');
  const id = store.createJob({ scenario: 'unverified' });
  const finished = finish(store, id);
  assert.equal(finished.clientId, accountId);
  assert.equal(store.getState().account.balance, '9.980');
  store.selectAccount(first.account.id);
  assert.deepEqual(store.getState().account, first.account);
  const before = store.getState();
  for (const input of [{ name: '', address: 'bad' }, { name: '重复', address: first.account.address }, { id: first.account.id, name: '重复', address: '0xc000000000000000000000000000000000000002' }]) {
    assert.throws(() => store.registerAccount(input));
    assert.deepEqual(store.getState(), before);
  }
  assert.throws(() => store.selectAccount('missing'));
  assert.deepEqual(store.getState(), before);
  const batch = store.createJobsInBlock([{ clientId: first.account.id }, { clientId: accountId }]);
  const after = store.getState();
  assert.equal(after.account.balance, '9.860');
  assert.equal(after.users.find((user) => user.id === accountId).balance, '9.940');
  assert.equal(new Set(after.transactions.filter((transaction) => batch.jobIds.includes(transaction.jobId)).map((transaction) => transaction.from)).size, 2);
  store.selectAccount(accountId);
  const selectedBefore = store.getState().account.balance;
  finish(store, batch.jobIds[0]);
  assert.equal(store.getState().account.balance, selectedBefore, 'another account cannot receive the task owner’s refund');
  assert.equal(store.getState().users.find((user) => user.id === first.account.id).locked, '0.040');
  assert.ok(notifications > 3);
});

test('network tasks honor different main quotes and partial verifier timeout fees', () => {
  const state = createDemoStore({ profile: 'network' }).getState();
  const timeout = state.jobs.find((job) => job.scenario === 'verifier-offline');
  assert.equal(timeout.closed, true);
  assert.equal(timeout.outcome, 'Verified');
  assert.equal(timeout.coverage, Math.floor(timeout.itemCount / 2));
  assert.deepEqual(timeout.verifierStates, ['Revealed', 'Missed']);
  assert.equal(wei(timeout.settlement.verifierB), BigInt(Math.floor(timeout.itemCount / 2)) * wei(timeout.unitPrice));
  assert.equal(wei(timeout.settlement.verifierC), 0n);
  assert.ok(timeout.events.some((entry) => entry.name === 'VerifierDropped' && entry.args.state === 'Missed'));
  assert.ok(timeout.events.find((entry) => entry.name === 'VerifierDropped').blockNumber
    < timeout.events.find((entry) => entry.name === 'JobClosed').blockNumber);
  const reset = createDemoStore({ profile: 'network' });
  assert.deepEqual(reset.getState(), state, 'network seed is reproducible');
});

test('normal network offers reflect a competitive price band while existing agreements retain their original prices', () => {
  const store = createDemoStore({ profile: 'network' });
  const state = store.getState();
  const types = ['image-classify-v1', 'blender-render-v1', 'key-search-v1'];
  const means = [];
  for (const type of types) {
    const market = getMarketStats(state, type);
    const spread = Number(wei(market.maxQuote) - wei(market.minQuote)) / Number(wei(market.averageQuote)) * 100;
    assert.ok(spread > 0 && spread < 8, `${type} has distinct offers within a small price band`);
    means.push(market.averageQuote);
  }
  assert.equal(new Set(means).size, 3, 'service units never share one blended price');
  for (const job of state.jobs) {
    const index = NETWORK_PROVIDERS.findIndex(provider => provider.id === job.provider);
    const openingPrice = wei(NETWORK_PROVIDERS[index].pricePerItem);
    const agreed = job.taskType === types[0] ? openingPrice
      : job.taskType === types[1] ? openingPrice * BigInt(1000 + index % 5 * 130) / 100n
        : openingPrice * BigInt(120 + index % 4 * 17) / 100n;
    assert.equal(wei(job.unitPrice), agreed, 'completed and unfinished agreements retain their historical quotation');
    assert.equal(wei(job.price), BigInt(job.itemCount) * agreed);
  }
  assert.ok(state.providers.every(provider => provider.pricePerItem === provider.offers[types[0]]));
  assert.equal(wei(state.providers.find(provider => provider.id === 'F').offers[types[1]]), 0n);
  assert.equal(wei(state.providers.find(provider => provider.id === 'E').offers[types[2]]), 0n);
  for (const type of types) {
    const id = store.createJob({ provider: 'G', taskType: type, itemCount: 4 });
    assert.equal(store.getState().jobs.find(job => job.id === id).unitPrice, state.providers.find(provider => provider.id === 'G').offers[type]);
  }
  assert.deepEqual(store.getState().jobs.filter(job => state.jobs.some(existing => existing.id === job.id)), state.jobs,
    'using current market offers does not rewrite existing contracts, receipts or settlements');
});
