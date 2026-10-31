import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { createDataClient } from '../src/data-client.js';
import { createRemoteClient } from '../src/remote-client.js';
import { renderSupplyOffers } from '../src/supply-view.js';
import { getProviderAvailability } from '../src/provider-availability.js';

const IMAGE = 'image-classify-v1';
const KEY = 'key-search-v1';
const provider = store => store.getState().providers.find(entry => entry.id === 'A');
const listing = (store, enabled, extra = {}) => store.setProviderListing({ providerId: 'A', accountId: 'user-01', enabled, ...extra });
const idleStore = () => {
  const store = createDemoStore();
  for (const job of store.getState().jobs.filter(entry => !entry.closed)) {
    while (!store.getState().jobs.find(entry => entry.id === job.id).closed) store.advanceJob(job.id);
  }
  return store;
};

test('only idle machines may unlist, including jobs not accepted yet, and quotes restore after editing offline', () => {
  const store = idleStore();
  const jobId = store.createJob({ provider: 'A', taskType: KEY, itemCount: 1 });
  const before = store.getState();
  assert.equal(provider(store).lockedJobs, 0);
  assert.equal(provider(store).listingBusy, true);
  assert.throws(() => listing(store, false), /任务结束后/);
  assert.throws(() => store.updateProviderOffers({ providerId: 'A', accountId: 'user-01',
    offers: Object.fromEntries(Object.keys(provider(store).offers).map(name => [name, '0'])) }), /任务结束后/);
  assert.deepEqual(store.getState(), before);
  store.advanceJob(jobId);
  const accepted = store.getState();
  assert.ok(provider(store).lockedJobs > 0);
  assert.throws(() => listing(store, false), /任务结束后/);
  assert.deepEqual(store.getState(), accepted);
  while (!store.getState().jobs.find(job => job.id === jobId).closed) store.advanceJob(jobId);
  const finished = store.getState();
  const original = provider(store).offers;
  listing(store, false);
  assert.equal(provider(store).listed, false);
  assert.deepEqual(provider(store).savedOffers, original);
  assert.ok(Object.values(provider(store).offers).every(value => Number(value) === 0));
  assert.deepEqual(store.getState().jobs, finished.jobs);
  assert.deepEqual(store.getState().users, finished.users);
  assert.deepEqual(store.getState().blocks, finished.blocks);
  assert.equal(getProviderAvailability(provider(store), KEY).label, '已下架');
  assert.throws(() => store.createJob({ provider: 'A', taskType: KEY, itemCount: 1 }), /不提供/);
  store.updateProviderOffers({ providerId: 'A', accountId: 'user-01', offers: { [KEY]: '0.00025' } });
  assert.equal(provider(store).savedOffers[KEY], '0.00025');
  assert.equal(Number(provider(store).offers[KEY]), 0);
  listing(store, true);
  assert.equal(provider(store).offers[KEY], '0.00025');
  assert.equal(provider(store).offers[IMAGE], original[IMAGE]);
});

test('listing validates ownership and type without changing state on failure', () => {
  const store = idleStore();
  const before = store.getState();
  for (const input of [{ enabled: 'false' }, { accountId: 'user-02' }, { providerId: 'B' }, { providerId: 'unknown' }]) {
    assert.throws(() => listing(store, false, input));
    assert.deepEqual(store.getState(), before);
  }
  listing(store, false);
  store.updateProviderOffers({ providerId: 'A', accountId: 'user-01', offers: Object.fromEntries(Object.keys(provider(store).savedOffers).map(name => [name, '0'])) });
  const disabled = store.getState();
  assert.throws(() => listing(store, true), /正报价/);
  assert.deepEqual(store.getState(), disabled);
  assert.equal(typeof createDataClient(store).setProviderListing, 'function');
  const { setProviderListing, ...legacy } = store;
  assert.equal(createDataClient(legacy).setProviderListing, undefined);
});

test('supply shows saved prices while unlisted and hides unsupported listing controls', () => {
  const providers = [{ id: 'A', listed: false, offers: { [IMAGE]: '0' }, savedOffers: { [IMAGE]: '0.00021' } }];
  const html = renderSupplyOffers({ providers, listingAvailable: true });
  assert.match(html, /role="switch" aria-label="上架接单" aria-checked="false"/);
  assert.match(html, /data-action="toggle-provider-listing" data-provider-id="A"/);
  assert.match(html, /name="offers.image-classify-v1" value="0.00021"/);
  assert.doesNotMatch(renderSupplyOffers({ providers }), /toggle-provider-listing/);
  assert.match(renderSupplyOffers({ providers: [{ ...providers[0], listingPending: true }], listingAvailable: true }), /retry-provider-unlisting/);
  const busy = renderSupplyOffers({ providers: [{ ...providers[0], listed: true, listingBusy: true, lockedJobs: 0 }], listingAvailable: true });
  assert.match(busy, /data-action="toggle-provider-listing" data-provider-id="A" disabled/);
  assert.match(busy, /任务结束后可下架/);
});

test('live listing calls only the supported owned provider endpoint and retains failed server state', async () => {
  const requests = [];
  let capable = false;
  let listed = true;
  let fail = false;
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const client = createRemoteClient({ storage: null, pollMs: 0, fetcher: async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('/api/state')) return reply({ network: { providerListing: capable }, users: [{ id: 'user-01' }], account: { id: 'user-01' }, jobs: [],
      providers: [{ id: 'A', ownerId: 'user-01', listed }, { id: 'B', ownerId: 'user-02' }] });
    if (fail) return reply({ error: 'RPC rejected' }, 409);
    listed = JSON.parse(options.body).enabled;
    return reply({ providerId: 'A', listed });
  } });
  await client.connect();
  await assert.rejects(client.setProviderListing({ providerId: 'A', enabled: false }), /尚未支持/);
  assert.equal(requests.length, 1);
  capable = true;
  await client.refresh();
  await client.setProviderListing({ providerId: 'A', enabled: false });
  assert.equal(client.getState().providers[0].listed, false);
  const posted = requests.find(entry => entry.url.startsWith('/api/providers/A/listing'));
  assert.deepEqual(JSON.parse(posted.options.body), { enabled: false, accountId: 'user-01' });
  const count = requests.length;
  await assert.rejects(client.setProviderListing({ providerId: 'B', enabled: true }), /自己的机器/);
  await assert.rejects(client.setProviderListing({ providerId: 'A', enabled: 1 }), /布尔值/);
  assert.equal(requests.length, count);
  fail = true;
  await assert.rejects(client.setProviderListing({ providerId: 'A', enabled: true }), /RPC rejected/);
  assert.equal(client.getState().providers[0].listed, false);
});
