import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { createDataClient } from '../src/data-client.js';
import { NETWORK_PROVIDERS } from '../src/network-fixtures.js';

const IMAGE = 'image-classify-v1';
const RENDER = 'blender-render-v1';
const KEY = 'key-search-v1';
const update = (store, offers, extra = {}) => store.updateProviderOffers({ providerId: 'A', accountId: 'user-01', offers, ...extra });

test('provider ownership maps A–L to accounts 01–12 and M–P back to 01–04', () => {
  for (const [index, provider] of NETWORK_PROVIDERS.entries()) {
    assert.equal(provider.ownerId, `user-${String(index % 12 + 1).padStart(2, '0')}`);
  }
  const compact = createDemoStore().getState();
  assert.deepEqual(compact.providers.map(provider => provider.ownerId), ['user-01', 'user-02', 'user-03', 'user-04', 'user-05', 'user-06']);
});

test('offer updates require both the current account and its own registered machine and reject atomically', () => {
  const store = createDemoStore();
  const other = store.registerAccount({ id: 'user-02', name: '另一账号', address: `0x${'f'.repeat(40)}` });
  store.selectAccount('user-01');
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const original = store.getState();
  for (const input of [
    { accountId: other, providerId: 'B' },
    { accountId: 'user-01', providerId: 'B' },
    { accountId: undefined, providerId: 'A' },
    { accountId: 'user-01', providerId: 'missing' },
  ]) {
    assert.throws(() => update(store, { [IMAGE]: '0.0002' }, input));
    assert.deepEqual(store.getState(), original);
  }
  assert.equal(notifications, 0);
  store.selectAccount(other);
  assert.equal(store.updateProviderOffers({ providerId: 'B', accountId: other, offers: { [RENDER]: '0.0002' } }).providers.find(provider => provider.id === 'B').offers[RENDER], '0.0002');
});

test('all supplied prices are validated before mutation, with exact decimal and uint256 limits', () => {
  const store = createDemoStore();
  const original = store.getState();
  const invalid = [
    {}, null, [], { [IMAGE]: '-1' }, { [IMAGE]: '1e-4' }, { [IMAGE]: '.5' },
    { [IMAGE]: '0.0000000000000000001' }, { [IMAGE]: 'NaN' }, { [IMAGE]: 0.0001 },
    { [IMAGE]: '0.0002', [RENDER]: 'bad' }, { 'nonce-search-v1': '0.0001' },
    { [IMAGE]: ((1n << 256n) / (10n ** 18n) + 1n).toString() },
  ];
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  for (const offers of invalid) {
    assert.throws(() => update(store, offers));
    assert.deepEqual(store.getState(), original);
  }
  assert.equal(notifications, 0);
  const exact = '0.000123456789012345';
  const state = update(store, { [IMAGE]: exact, [RENDER]: '0.000000000000000001', [KEY]: ' 0.002300000000000000 ' });
  assert.deepEqual(state.providers.find(provider => provider.id === 'A').offers, { [IMAGE]: exact, [RENDER]: '0.000000000000000001', [KEY]: '0.0023' });
  assert.equal(notifications, 1);
});

test('zero stops future offers without altering active jobs, account funds, stakes or chain receipts', () => {
  const store = createDemoStore();
  const id = store.createJob({ provider: 'A', taskType: RENDER, itemCount: 3 });
  const before = store.getState();
  const job = before.jobs.find(job => job.id === id);
  const after = update(store, { [RENDER]: '0' });
  assert.equal(after.providers.find(provider => provider.id === 'A').offers[RENDER], '0.000');
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.users, before.users);
  assert.deepEqual(after.blocks, before.blocks);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.network, before.network);
  assert.deepEqual(after.providers.map(provider => [provider.id, provider.stake, provider.lockedJobs]), before.providers.map(provider => [provider.id, provider.stake, provider.lockedJobs]));
  assert.throws(() => store.createJob({ provider: 'A', taskType: RENDER, itemCount: 3 }), /不提供/);
  assert.deepEqual(store.getState(), after, 'disabled creation is atomic');
  while (!store.getState().jobs.find(entry => entry.id === id).closed) store.advanceJob(id);
  const closed = store.getState().jobs.find(entry => entry.id === id);
  assert.equal(closed.unitPrice, job.unitPrice);
  assert.equal(closed.deposit, job.deposit);
  assert.equal(closed.settlement.main, job.price, 'existing accepted work settles at its original quote');
});

test('changing one service affects only new jobs of that type and leaves existing result and price evidence intact', () => {
  const store = createDemoStore();
  const before = store.getState();
  const image = before.jobs[0];
  const oldKeyOffer = before.providers[0].offers[KEY];
  const newPrice = '0.000123456789012345';
  update(store, { [IMAGE]: newPrice });
  const id = store.createJob({ provider: 'A', taskType: IMAGE, itemCount: 2 });
  const after = store.getState();
  assert.equal(after.jobs.find(job => job.id === id).unitPrice, newPrice);
  assert.equal(after.jobs.find(job => job.id === id).deposit, '0.00049382715604938');
  assert.deepEqual(after.jobs.find(job => job.id === image.id), image);
  assert.equal(after.providers[0].offers[KEY], oldKeyOffer);
});

test('new local accounts do not gain a fabricated machine, stake or provider registration', () => {
  const store = createDemoStore();
  const before = store.getState();
  const id = store.registerAccount({ id: 'new-user', name: '新账号', address: `0x${'e'.repeat(40)}` });
  const after = store.getState();
  assert.equal(after.providers.some(provider => provider.ownerId === id), false);
  assert.deepEqual(after.providers.map(({ listingBusy, ...provider }) => provider),
    before.providers.map(({ listingBusy, ...provider }) => provider));
  assert.deepEqual(after.blocks, before.blocks);
  assert.throws(() => store.updateProviderOffers({ providerId: 'A', accountId: id, offers: { [IMAGE]: '0.0002' } }), /本账号/);
});

test('data client exposes the optional offer updater while retaining adapters without it', () => {
  const store = createDemoStore();
  const client = createDataClient(store);
  assert.equal(typeof client.updateProviderOffers, 'function');
  assert.equal(client.updateProviderOffers({ providerId: 'A', accountId: 'user-01', offers: { [IMAGE]: '0.0002' } }).providers[0].offers[IMAGE], '0.0002');
  const { updateProviderOffers, ...legacy } = store;
  assert.equal(createDataClient(legacy).updateProviderOffers, undefined);
});
