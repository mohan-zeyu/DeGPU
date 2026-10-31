import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { createDataClient } from '../src/data-client.js';

const IMAGE = 'image-classify-v1';
const RENDER = 'blender-render-v1';
const KEY = 'key-search-v1';
const WEI = 10n ** 18n;
const STAKE = WEI * 8n / 10n;
const UINT256_MAX = (1n << 256n) - 1n;
const amountWei = value => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'));
};
const amountEth = value => `${value / WEI}.${(value % WEI).toString().padStart(18, '0')}`;
const addAccount = (store, id = 'new-owner', address = `0x${'e'.repeat(40)}`) => store.registerAccount({ id, name: id, address });
const owned = (state, id = 'new-owner') => state.providers.find(provider => provider.ownerId === id);
const enroll = (store, offers = { [IMAGE]: '0.0001' }, extra = {}) => store.registerMachine({ accountId: 'new-owner', offers, ...extra });

test('enrollment conserves available funds plus stake, initializes real machine fields and emits no chain receipt', () => {
  const store = createDemoStore();
  const previousProviders = store.getState().providers;
  addAccount(store);
  const before = store.getState();
  assert.equal(owned(before), undefined, 'account registration alone never grants a machine');
  assert.deepEqual(before.providers.map(({ listingBusy, ...provider }) => provider),
    previousProviders.map(({ listingBusy, ...provider }) => provider));
  let notifications = 0;
  let notified;
  store.subscribe(state => { notifications += 1; notified = state; });
  const after = enroll(store, { [IMAGE]: '0.000123456789012345', [KEY]: '0.000000000000000001' });
  const machine = owned(after);
  assert.equal(machine.id, 'R1');
  assert.equal(machine.address, before.account.address);
  assert.equal(machine.registrationSource, 'local-enrollment');
  assert.equal(machine.registered, true);
  assert.equal(machine.active, true);
  assert.equal(amountWei(machine.stake), STAKE);
  assert.equal(amountWei(after.account.balance) + amountWei(machine.stake), amountWei(before.account.balance));
  assert.equal(amountWei(after.account.balance), amountWei(before.account.balance) - STAKE);
  assert.equal(after.account.initialBalance, before.account.initialBalance);
  assert.equal(after.account.deposited, before.account.deposited);
  assert.equal(after.account.returned, before.account.returned);
  assert.equal(after.account.locked, before.account.locked);
  assert.deepEqual(machine.offers, { [IMAGE]: '0.000123456789012345', [RENDER]: '0.000', [KEY]: '0.000000000000000001' });
  assert.equal(machine.lockedJobs, 0);
  assert.equal(machine.earned, '0.000');
  assert.ok(Object.values(machine.statsByMode.replicated).every(value => value === 0));
  assert.deepEqual(Object.keys(machine.statsByMode.replicated).sort(), ['checksCompleted', 'checksMissed', 'checksOutvoted', 'missed', 'outvoted', 'unverified', 'verified']);
  assert.deepEqual(machine.statsByMode.checked, { completed: 0, missed: 0, itemsSolved: 0, itemsNotFound: 0 });
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.blocks, before.blocks);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.network, before.network);
  assert.deepEqual(after.providers.slice(0, -1), before.providers);
  assert.equal(notifications, 1);
  assert.deepEqual(notified.account, after.account, 'subscription sees the refreshed wallet balance');
  assert.deepEqual(notified.providers, after.providers);
});

test('enrollment rejects malformed offers atomically and keeps the first machine identifier available', () => {
  const store = createDemoStore();
  addAccount(store);
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  for (const offers of [
    {}, null, [], { [IMAGE]: '0' }, { [RENDER]: '0.000', [KEY]: '0' },
    { [IMAGE]: '-1' }, { [IMAGE]: '1e-4' }, { [IMAGE]: '.5' },
    { [IMAGE]: '0.0000000000000000001' }, { [IMAGE]: 'NaN' }, { [IMAGE]: 0.0001 },
    { [IMAGE]: '0.0002', [RENDER]: 'bad' }, { 'nonce-search-v1': '0.0001' },
    { unsupported: '0.0001' }, { [IMAGE]: amountEth(UINT256_MAX + 1n) },
  ]) {
    assert.throws(() => enroll(store, offers));
    assert.deepEqual(store.getState(), before);
  }
  for (const input of [null, [], 'machine']) {
    assert.throws(() => store.registerMachine(input));
    assert.deepEqual(store.getState(), before);
  }
  assert.equal(notifications, 0);
  const after = enroll(store, { [IMAGE]: amountEth(UINT256_MAX) });
  assert.equal(owned(after).id, 'R1');
  assert.equal(amountWei(owned(after).offers[IMAGE]), UINT256_MAX);
  assert.equal(notifications, 1);
});

test('only the selected account can enroll and existing ownership or wallet identity cannot be claimed twice', () => {
  const store = createDemoStore();
  addAccount(store);
  const before = store.getState();
  for (const accountId of [undefined, null, 'missing', 'user-01']) {
    assert.throws(() => enroll(store, undefined, { accountId }), /当前登录/);
    assert.deepEqual(store.getState(), before);
  }
  enroll(store);
  const registered = store.getState();
  assert.throws(() => enroll(store), /已绑定/);
  assert.deepEqual(store.getState(), registered);
  store.selectAccount('user-01');
  const existing = store.getState();
  assert.throws(() => enroll(store, undefined, { accountId: 'user-01' }), /已绑定/);
  assert.deepEqual(store.getState(), existing);
  addAccount(store, 'address-alias', registered.providers[0].address.toUpperCase().replace('0X', '0x'));
  const alias = store.getState();
  assert.throws(() => enroll(store, undefined, { accountId: 'address-alias' }), /地址已绑定/);
  assert.deepEqual(store.getState(), alias);
  addAccount(store, 'second-owner', `0x${'d'.repeat(40)}`);
  const second = enroll(store, { [RENDER]: '0.0001' }, { accountId: 'second-owner' });
  assert.equal(owned(second, 'second-owner').id, 'R2');
  assert.notEqual(owned(second).address, owned(second, 'second-owner').address);
});

test('only available wallet funds may fund the stake, with an exact minimum balance accepted', () => {
  for (const [price, sufficient] of [['4.75', false], ['4.6', true]]) {
    const store = createDemoStore();
    store.updateProviderOffers({ providerId: 'A', accountId: 'user-01', offers: { [IMAGE]: price } });
    addAccount(store);
    store.createJob({ provider: 'A', taskType: IMAGE, itemCount: 1 });
    const before = store.getState();
    if (sufficient) {
      assert.equal(amountWei(before.account.balance), STAKE);
      const after = enroll(store);
      assert.equal(amountWei(after.account.balance), 0n);
      assert.equal(amountWei(owned(after).stake), STAKE);
      assert.deepEqual(after.jobs, before.jobs, 'task escrow is untouched');
    } else {
      assert.ok(amountWei(before.account.locked) > STAKE);
      assert.ok(amountWei(before.account.balance) < STAKE);
      let notifications = 0;
      store.subscribe(() => { notifications += 1; });
      assert.throws(() => enroll(store), /余额不足/);
      assert.deepEqual(store.getState(), before);
      assert.equal(notifications, 0);
    }
  }
});

test('an enrolled provider can accept another client task but cannot rent its own wallet address', () => {
  const store = createDemoStore();
  addAccount(store);
  const after = enroll(store, { [KEY]: '0.0001' });
  const machine = owned(after);
  const before = store.getState();
  assert.throws(() => store.createJob({ provider: machine.id, taskType: KEY, itemCount: 2 }), /不能是任务客户/);
  assert.deepEqual(store.getState(), before);
  const id = store.createJob({ clientId: 'user-01', provider: machine.id, taskType: KEY, itemCount: 2 });
  store.advanceJob(id);
  const accepted = store.getState();
  assert.equal(accepted.jobs.find(job => job.id === id).phase, 'Working');
  assert.equal(accepted.transactions.at(-1).from, machine.address);
  assert.equal(accepted.providers.find(provider => provider.id === machine.id).lockedJobs, 1);
  store.advanceJob(id);
  const closed = store.getState();
  assert.equal(closed.jobs.find(job => job.id === id).closed, true);
  assert.equal(owned(closed).statsByMode.checked.completed, 1);
  assert.equal(amountWei(owned(closed).earned), 2n * amountWei('0.0001'));
  assert.equal(owned(closed).lockedJobs, 0);
  assert.equal(amountWei(owned(closed).stake), STAKE);
});

test('machine enrollment remains optional for adapter compatibility and raw task creation keeps contract semantics', () => {
  const store = createDemoStore();
  const client = createDataClient(store);
  assert.equal(typeof client.registerMachine, 'function');
  addAccount(store);
  assert.equal(owned(store.getState()), undefined);
  const task = client.createJob({ provider: 'A', taskType: RENDER, itemCount: 1 });
  assert.equal(store.getState().jobs.find(job => job.id === task).clientId, 'new-owner', 'raw ABI action does not require machine enrollment');
  assert.equal(owned(client.registerMachine({ accountId: 'new-owner', offers: { [IMAGE]: '0.0001' } })).id, 'R1');
  const { registerMachine, ...legacy } = store;
  assert.equal(createDataClient(legacy).registerMachine, undefined);
  assert.equal(typeof createDataClient(legacy).createJob, 'function');
});
