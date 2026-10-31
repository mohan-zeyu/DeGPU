import test from 'node:test';
import assert from 'node:assert/strict';
import { getRunningRentalAccess, getRunningRentalProviderIds, resolveRunningRentalSelection } from '../src/access.js';
import { createDemoStore } from '../src/demo-store.js';
import { createDemoMonitor } from '../src/monitor.js';

const account = { id: 'user-1', address: '0xClient' };
const providers = [
  { id: 'A', address: '0xAA', ownerId: 'user-1' },
  { id: 'B', address: '0xBB', ownerId: 'user-2' },
  { id: 'C', address: '0xCC', ownerId: 'user-3' },
];
const runningJob = (overrides = {}) => ({
  id: 'replicated:1', mode: 'replicated', phase: 'Committing', closed: false,
  clientId: account.id, clientAddress: account.address, provider: 'A',
  deadline: 200, deadlinePassed: false, verifiers: ['B'], tieProvider: 'C',
  events: [
    { name: 'JobCreated', args: { client: '0xCLIENT', main: '0xAA' } },
    { name: 'JobAccepted', args: {} },
  ], ...overrides,
});
const stateFor = (jobs = [runningJob()], overrides = {}) => ({ providers, jobs, blocks: [{ timestamp: 100 }], ...overrides });
const snapshotFor = (jobs, { status = 'computing', connectivity = 'online', mainId = 'A' } = {}) => ({
  jobs: jobs.map(job => ({ jobId: job.id,
    main: { providerId: mainId, role: 'main', status, completed: 12, total: 100 },
    verifiers: [{ providerId: 'B', role: 'verifier', status: 'computing' }],
    tiebreak: { providerId: 'C', role: 'tiebreak', status: 'computing' },
  })),
  providers: providers.map(provider => ({ providerId: provider.id, connectivity,
    gpuUtil: 85, history: [{ timestamp: 10, gpuUtil: 50 }], privateTask: 'other customer' })),
});
const accessFor = (jobs, snapshotOptions, options) => getRunningRentalAccess(
  stateFor(jobs), account, snapshotFor(jobs, snapshotOptions), options,
);

test('live rental access exposes only the accepted main machine and immutable authorized task IDs', () => {
  const own = runningJob();
  const other = runningJob({ id: 'replicated:other', clientId: 'other',
    events: [{ name: 'JobCreated', args: { client: '0xOther', main: '0xAA' } }, { name: 'JobAccepted' }] });
  const state = stateFor([own, other]);
  const snapshot = snapshotFor(state.jobs);
  const before = structuredClone({ state, snapshot });
  const access = getRunningRentalAccess(state, account, snapshot);
  assert.deepEqual(access, { providerIds: ['A'], jobIds: ['replicated:1'] });
  assert.ok(Object.isFrozen(access) && Object.isFrozen(access.providerIds) && Object.isFrozen(access.jobIds));
  assert.deepEqual(getRunningRentalProviderIds(state, account, snapshot), ['A']);
  assert.deepEqual({ state, snapshot }, before);
  assert.equal('jobs' in access, false);
  assert.equal('providers' in access, false);
});

test('historical aliases, own supplied hardware, verifiers and arbitrators never expand rental resource access', () => {
  const job = runningJob({ provider: 'C', main: 'C',
    events: [{ name: 'JobCreated', args: { client: account.address, main: '0xBB' } }, { name: 'JobAccepted' }] });
  assert.deepEqual(accessFor([job], { mainId: 'B' }).providerIds, ['B']);
  assert.deepEqual(accessFor([job], { mainId: 'C' }).providerIds, [], 'stale main alias cannot stand in for the formal main');
  const otherClient = runningJob({ clientId: account.id,
    events: [{ name: 'JobCreated', args: { client: '0xOther', main: '0xAA' } }, { name: 'JobAccepted' }] });
  assert.deepEqual(accessFor([otherClient]).providerIds, [], 'stale customer id and ownership of A do not override the customer event');
  const absent = runningJob({ events: [{ name: 'JobAccepted' }] });
  assert.deepEqual(accessFor([absent]).providerIds, [], 'a historical display alias cannot replace a creation assignment');
});

test('only computing is observable: ready, submitted, offline, stopped, waiting and unknown states are excluded', () => {
  const jobs = [runningJob()];
  for (const status of ['ready', 'submitted', 'offline', 'stopped', 'waiting', 'unknown', null, undefined]) {
    const snapshot = snapshotFor(jobs);
    snapshot.jobs[0].main.status = status;
    assert.deepEqual(getRunningRentalAccess(stateFor(jobs), account, snapshot).providerIds, [], status);
  }
  assert.deepEqual(accessFor(jobs).providerIds, ['A']);
  assert.deepEqual(accessFor(jobs, { connectivity: 'offline' }).providerIds, [], 'offline telemetry overrides stale computing');
  assert.deepEqual(accessFor(jobs, { connectivity: null }).providerIds, []);
});

test('execution phase and confirmed public events override unclosed local aliases or stale telemetry', () => {
  for (const phase of ['Open', 'Deciding', 'Checking', 'CheckReveal', 'Publishing', 'TieBreak', 'Closed', null]) {
    assert.deepEqual(accessFor([runningJob({ phase })]).providerIds, [], phase);
  }
  const checked = runningJob({ id: 'checked:1', mode: 'checked', phase: 'Working' });
  assert.deepEqual(accessFor([checked]).providerIds, ['A']);
  assert.deepEqual(accessFor([runningJob({ mode: 'checked' })]).providerIds, []);
  for (const name of ['ResultsCommitted', 'ResultsSubmitted', 'ResultsPublished', 'JobClosed']) {
    const job = runningJob();
    job.events.push({ name });
    assert.deepEqual(accessFor([job]).providerIds, [], `${name} ends compute access even with closed:false`);
    job.events.at(-1).confirmed = false;
    assert.deepEqual(accessFor([job]).providerIds, ['A'], 'an unconfirmed event cannot end actual running access');
  }
  assert.deepEqual(accessFor([runningJob({ closed: true })]).providerIds, []);
  for (const invalid of [{ confirmed: false }, { status: false }, { status: 0 }]) {
    const job = runningJob();
    Object.assign(job.events[1], invalid);
    assert.deepEqual(accessFor([job]).providerIds, [], 'an unsuccessful acceptance cannot grant access');
    job.events = [{ ...job.events[0], ...invalid }, { name: 'JobAccepted' }];
    assert.deepEqual(accessFor([job]).providerIds, [], 'an unsuccessful creation cannot grant access');
  }
});

test('the execution deadline revokes access before settlement, using chain seconds rather than sample wall time', () => {
  const jobs = [runningJob()];
  assert.deepEqual(accessFor(jobs, {}, { now: 199 }).providerIds, ['A']);
  assert.deepEqual(accessFor(jobs, {}, { now: 200 }).providerIds, ['A'], 'the contract deadline itself is inclusive');
  assert.deepEqual(accessFor(jobs, {}, { now: 201 }).providerIds, []);
  assert.deepEqual(accessFor([runningJob({ deadlinePassed: true })]).providerIds, []);
  for (const deadline of [undefined, null, NaN, 'unknown']) {
    assert.deepEqual(accessFor([runningJob({ deadline })]).providerIds, []);
  }
  assert.deepEqual(getRunningRentalAccess(stateFor(jobs, { blocks: [] }), account, snapshotFor(jobs)).providerIds, []);
  for (const now of [null, NaN, 'unknown', -1]) {
    assert.deepEqual(accessFor(jobs, {}, { now }).providerIds, []);
  }
});

test('missing account or telemetry denies access and output deduplicates machines without reading task secrets', () => {
  const first = runningJob();
  const second = runningJob({ id: 'replicated:2' });
  for (const key of ['verify', 'inputs', 'results', 'modelName']) {
    Object.defineProperty(first, key, { get() { throw new Error('private task data was read'); } });
  }
  const jobs = [first, second];
  const state = stateFor(jobs);
  const snapshot = snapshotFor(jobs);
  assert.deepEqual(getRunningRentalAccess(state, account, snapshot), {
    providerIds: ['A'], jobIds: ['replicated:1', 'replicated:2'],
  });
  assert.deepEqual(getRunningRentalAccess(state, null, snapshot).providerIds, []);
  assert.deepEqual(getRunningRentalAccess(state, {}, snapshot).providerIds, []);
  assert.deepEqual(getRunningRentalAccess(state, account, null).providerIds, []);
  assert.deepEqual(getRunningRentalAccess(null, account, snapshot).providerIds, []);
  snapshot.jobs[0].main.role = 'verifier';
  assert.deepEqual(getRunningRentalAccess(stateFor([first]), account, snapshot).providerIds, []);
});

test('real store and monitor revoke rental visibility when computation becomes ready, commits, or expires unsettled', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const account = store.getState().account;
  const id = store.createJob({ provider: 'E' });
  let state = store.getState();
  let snapshot = monitor.sync(state);
  assert.deepEqual(getRunningRentalAccess(state, account, snapshot).jobIds, []);
  store.advanceJob(id);
  state = store.getState();
  snapshot = monitor.sync(state);
  assert.ok(getRunningRentalAccess(state, account, snapshot).jobIds.includes(id));
  for (let index = 0; index < 20; index += 1) snapshot = monitor.tick();
  assert.equal(snapshot.jobs.find(job => job.jobId === id).main.status, 'ready');
  assert.equal(state.jobs.find(job => job.id === id).closed, false);
  assert.ok(!getRunningRentalAccess(state, account, snapshot).jobIds.includes(id));
  store.advanceJob(id);
  state = store.getState();
  assert.ok(!getRunningRentalAccess(state, account, monitor.sync(state)).jobIds.includes(id));

  const checked = store.createJob({ provider: 'E', taskType: 'key-search-v1' });
  store.advanceJob(checked);
  state = store.getState();
  snapshot = monitor.sync(state);
  assert.ok(getRunningRentalAccess(state, account, snapshot).jobIds.includes(checked));
  store.passDeadline(checked);
  state = store.getState();
  assert.equal(state.jobs.find(job => job.id === checked).closed, false);
  assert.ok(!getRunningRentalAccess(state, account, monitor.sync(state)).jobIds.includes(checked));
});

test('task links select their confirmed main machine and reject conflicting or unauthorized machine selections', () => {
  const a = runningJob({ id: 'replicated:A' });
  const b = runningJob({ id: 'checked:B', mode: 'checked', phase: 'Working', provider: 'A',
    events: [{ name: 'JobCreated', args: { client: account.address, main: '0xbB' } }, { name: 'JobAccepted' }] });
  const state = stateFor([a, b]);
  const access = { providerIds: ['A', 'B'], jobIds: [a.id, b.id] };
  const selection = resolveRunningRentalSelection(state, access, { jobId: b.id });
  assert.deepEqual(selection, { providerId: 'B', jobId: b.id });
  assert.ok(Object.isFrozen(selection));
  assert.deepEqual(resolveRunningRentalSelection(state, access, { jobId: a.id }), { providerId: 'A', jobId: a.id });
  assert.deepEqual(resolveRunningRentalSelection(state, access, { jobId: a.id, providerId: 'A' }), { providerId: 'A', jobId: a.id });
  assert.equal(resolveRunningRentalSelection(state, access, { jobId: a.id, providerId: 'B' }), null);
  assert.equal(resolveRunningRentalSelection(state, access, { jobId: a.id, providerId: 'C' }), null);
  assert.equal(resolveRunningRentalSelection(state, access, { jobId: b.id, providerId: 'A' }), null, 'stale display alias cannot make B run on A');
});

test('without a task link selection follows an authorized machine or the first authorized machine', () => {
  const a = runningJob({ id: 'replicated:A' });
  const secondA = runningJob({ id: 'replicated:A2' });
  const b = runningJob({ id: 'replicated:B',
    events: [{ name: 'JobCreated', args: { client: account.address, main: '0xBB' } }, { name: 'JobAccepted' }] });
  const state = stateFor([a, secondA, b]);
  const access = { providerIds: ['B', 'A'], jobIds: [secondA.id, a.id, b.id] };
  assert.deepEqual(resolveRunningRentalSelection(state, access), { providerId: 'B', jobId: b.id });
  assert.deepEqual(resolveRunningRentalSelection(state, access, { jobId: null, providerId: null }), { providerId: 'B', jobId: b.id });
  assert.deepEqual(resolveRunningRentalSelection(state, access, { providerId: 'A' }), { providerId: 'A', jobId: secondA.id });
  assert.equal(resolveRunningRentalSelection(state, access, { providerId: 'C' }), null);
  assert.equal(resolveRunningRentalSelection(state, access, { providerId: '' }), null);
});

test('ended, other-customer or nonexistent task links never fall back to a current authorized rental', () => {
  const active = runningJob({ id: 'replicated:active' });
  const ended = runningJob({ id: 'replicated:ended', phase: 'Deciding', closed: false });
  const other = runningJob({ id: 'replicated:other', clientAddress: '0xOther',
    events: [{ name: 'JobCreated', args: { client: '0xOther', main: '0xAA' } }, { name: 'JobAccepted' }] });
  const state = stateFor([active, ended, other]);
  const access = { providerIds: ['A'], jobIds: [active.id] };
  for (const jobId of [ended.id, other.id, 'replicated:missing', '']) {
    assert.equal(resolveRunningRentalSelection(state, access, { jobId }), null);
    assert.equal(resolveRunningRentalSelection(state, access, { jobId, providerId: 'A' }), null);
  }
  assert.equal(resolveRunningRentalSelection(state, { providerIds: [], jobIds: [] }), null);
  assert.equal(resolveRunningRentalSelection(state, null), null);
  assert.equal(resolveRunningRentalSelection(null, access), null);
});

test('inconsistent selection inputs deny instead of falling back to display aliases or unconfirmed main events', () => {
  const job = runningJob();
  const access = { providerIds: ['A'], jobIds: [job.id] };
  for (const events of [[], [{ name: 'JobCreated', confirmed: false, args: { main: '0xAA' } }],
    [{ name: 'JobCreated', args: { main: '0xBB' } }]]) {
    const state = stateFor([{ ...job, events }]);
    assert.equal(resolveRunningRentalSelection(state, access, { jobId: job.id }), null);
    assert.equal(resolveRunningRentalSelection(state, access, { providerId: 'A' }), null);
  }
});
