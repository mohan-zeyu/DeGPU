import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoMonitor } from '../src/monitor.js';
import { createDemoStore } from '../src/demo-store.js';
import { renderComputeProgress, renderResources } from '../src/monitor-view.js';

const task = (snapshot, id) => snapshot.jobs.find((job) => job.jobId === id);
const node = (snapshot, id) => snapshot.providers.find((provider) => provider.providerId === id);
const storedJob = (store, id) => store.getState().jobs.find((job) => job.id === id);

function until(store, id, predicate) {
  let limit = 20;
  while (!predicate(storedJob(store, id)) && limit-- > 0) store.advanceJob(id);
  assert.ok(predicate(storedJob(store, id)), 'expected task phase is reachable');
}

test('local compute ticks do not create blocks, events, receipts, verification or settlement', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ provider: 'E' });
  store.advanceJob(id);
  const state = store.getState();
  const original = structuredClone(state);
  const first = monitor.sync(state);
  assert.equal(task(first, id).main.status, 'computing');
  assert.ok(task(first, id).main.percent > 0);
  for (let count = 0; count < 20; count += 1) monitor.tick();
  const ready = task(monitor.getSnapshot(), id).main;
  assert.equal(ready.percent, 100);
  assert.equal(ready.status, 'ready', 'local readiness is not a submitted or verified result');
  assert.equal(storedJob(store, id).phase, 'Committing');
  assert.equal(storedJob(store, id).coverage, 0);
  assert.deepEqual(state, original, 'supplied view is never changed');
  assert.deepEqual(store.getState(), original, 'store and chain remain unchanged');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.jobs[0].main));
  assert.equal(task(first, id).main.percent, 12, 'prior snapshots do not change on later ticks');
});

test('a submitted commitment accepts manual advancement and does not imply verification coverage', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob();
  store.advanceJob(id);
  monitor.sync(store.getState());
  store.advanceJob(id);
  const after = task(monitor.sync(store.getState()), id);
  assert.equal(after.main.status, 'submitted');
  assert.equal(after.main.completed, 200);
  assert.equal(storedJob(store, id).coverage, 0);
  assert.equal(storedJob(store, id).closed, false);
  until(store, id, (job) => job.phase === 'Checking');
  let view = task(monitor.sync(store.getState()), id);
  assert.deepEqual(view.verifiers.map((entry) => entry.status), ['waiting', 'waiting']);
  monitor.tick();
  assert.deepEqual(task(monitor.getSnapshot(), id).verifiers.map((entry) => entry.completed), [0, 0]);
  store.advanceJob(id);
  view = task(monitor.sync(store.getState()), id);
  assert.equal(view.verifiers[0].status, 'computing');
  assert.equal(view.verifiers[1].status, 'waiting');
  until(store, id, (job) => job.phase === 'CheckReveal');
  view = task(monitor.sync(store.getState()), id);
  assert.ok(view.verifiers.every((entry) => entry.percent === 100 && entry.status === 'submitted'));
  assert.equal(storedJob(store, id).coverage, 0, 'commitments alone do not reveal a verified range');
});

test('offline machine reports missing telemetry and retains partial progress through expiration', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ scenario: 'main-offline', provider: 'A' });
  monitor.sync(store.getState());
  store.advanceJob(id);
  const first = monitor.sync(store.getState());
  const percent = task(first, id).main.percent;
  assert.equal(percent, 35);
  assert.equal(task(first, id).main.status, 'offline');
  assert.equal(node(first, 'A').connectivity, 'offline');
  for (const metric of ['gpuUtil', 'memoryUsedGiB', 'cpuUtil', 'tempC', 'powerW']) assert.equal(node(first, 'A')[metric], null);
  for (let count = 0; count < 6; count += 1) monitor.tick();
  assert.equal(task(monitor.getSnapshot(), id).main.percent, percent);
  store.passDeadline(id);
  monitor.sync(store.getState());
  store.expireJob(id);
  const closed = monitor.sync(store.getState());
  assert.equal(task(closed, id).main.status, 'stopped');
  assert.equal(task(closed, id).main.percent, percent);
  monitor.tick();
  assert.equal(task(monitor.getSnapshot(), id).main.percent, percent);
  assert.equal(node(closed, 'A').connectivity, 'offline');
});

test('one offline provider interrupts its other computing assignments without losing their progress', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const normal = store.createJob({ provider: 'E' });
  monitor.sync(store.getState());
  store.advanceJob(normal);
  let view = monitor.sync(store.getState());
  assert.equal(task(view, normal).main.percent, 12, 'starting after an observed waiting stage initializes work');
  monitor.tick();
  const beforeOffline = task(monitor.getSnapshot(), normal).main.completed;
  const offline = store.createJob({ provider: 'E', scenario: 'main-offline' });
  monitor.sync(store.getState());
  store.advanceJob(offline);
  view = monitor.sync(store.getState());
  assert.equal(task(view, normal).main.status, 'offline');
  assert.equal(task(view, normal).main.completed, beforeOffline);
  for (let count = 0; count < 4; count += 1) monitor.tick();
  assert.equal(task(monitor.getSnapshot(), normal).main.completed, beforeOffline);
  assert.equal(node(monitor.getSnapshot(), 'E').gpuUtil, null);
  assert.equal(node(monitor.getSnapshot(), 'D').connectivity, 'online');
});

test('historical main timeouts recover on provider activity, while fresh client submissions and current outages do not', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const failed = store.createJob({ provider: 'E', scenario: 'main-offline' });
  store.advanceJob(failed);
  monitor.sync(store.getState());
  const partial = task(monitor.getSnapshot(), failed).main.completed;
  store.passDeadline(failed);
  store.expireJob(failed);
  assert.equal(node(monitor.sync(store.getState()), 'E').connectivity, 'offline');

  const replacement = store.createJob({ provider: 'E', scenario: 'unverified' });
  assert.equal(node(monitor.sync(store.getState()), 'E').connectivity, 'offline', 'a client transaction alone cannot make a provider online');
  store.advanceJob(replacement);
  let recovered = monitor.sync(store.getState());
  assert.equal(node(recovered, 'E').connectivity, 'online');
  assert.equal(task(recovered, replacement).main.status, 'computing');
  until(store, replacement, (job) => job.closed);
  recovered = monitor.sync(store.getState());
  assert.equal(node(recovered, 'E').connectivity, 'online', 'later completed work supersedes the historical outage');
  assert.equal(task(recovered, failed).main.status, 'stopped');
  assert.equal(task(recovered, failed).main.completed, partial, 'recovery never rewrites the failed task’s partial progress');

  const currentOutage = store.createJob({ provider: 'E', scenario: 'main-offline' });
  store.advanceJob(currentOutage);
  const offline = monitor.sync(store.getState());
  assert.equal(node(offline, 'E').connectivity, 'offline', 'a current outage wins over earlier successful activity');
  assert.equal(task(offline, currentOutage).main.status, 'offline');
  for (const metric of ['gpuUtil', 'memoryUsedGiB', 'cpuUtil', 'tempC', 'powerW']) assert.equal(node(offline, 'E')[metric], null);
});

test('seeded providers with old timeouts and subsequent work remain online', () => {
  const store = createDemoStore({ profile: 'network' });
  const state = store.getState();
  const view = createDemoMonitor().sync(state);
  const withFailures = state.providers.filter((provider) => provider.missed > 0);
  assert.ok(withFailures.length > 0);
  for (const provider of withFailures) {
    const lastFailure = Math.max(...state.jobs.filter((job) => job.provider === provider.id && job.outcome === 'MainMissed').map((job) => job.updatedBlock));
    assert.ok(state.transactions.some((transaction) => transaction.from === provider.address && transaction.blockNumber > lastFailure));
    assert.equal(node(view, provider.id).connectivity, 'online');
  }
});

test('resource samples are bounded and inactivity from low stake is not an offline signal', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const inputs = Array.from({ length: 6 }, () => ({ provider: 'D' }));
  const { jobIds } = store.createJobsInBlock(inputs);
  jobIds.forEach((id) => store.advanceJob(id));
  const state = store.getState();
  state.providers.find((provider) => provider.id === 'F').active = false;
  monitor.sync(state);
  for (let count = 0; count < 60; count += 1) {
    const view = monitor.tick();
    for (const provider of view.providers) {
      assert.ok(provider.gpuUtil >= 0 && provider.gpuUtil <= 100);
      assert.ok(provider.cpuUtil >= 0 && provider.cpuUtil <= 100);
      assert.ok(provider.memoryUsedGiB >= 0 && provider.memoryUsedGiB <= provider.memoryTotalGiB);
      assert.ok(provider.tempC >= 20 && provider.tempC <= 90);
      assert.ok(provider.powerW >= 0 && provider.powerW <= 450);
      assert.ok(provider.history.length <= 24);
    }
  }
  assert.equal(node(monitor.getSnapshot(), 'F').connectivity, 'online');
  assert.equal(node(monitor.getSnapshot(), 'D').history.length, 24);
});

test('arbitration starts after sharing and progress follows only its own assignment', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ scenario: 'main-cheat' });
  until(store, id, (job) => job.phase === 'TieBreak');
  let view = task(monitor.sync(store.getState()), id);
  assert.equal(view.main.percent, 100);
  assert.equal(view.tiebreak.total, 40);
  assert.equal(view.tiebreak.status, 'waiting');
  store.advanceJob(id);
  view = task(monitor.sync(store.getState()), id);
  assert.equal(view.tiebreak.status, 'computing');
  monitor.tick();
  assert.ok(task(monitor.getSnapshot(), id).tiebreak.completed > view.tiebreak.completed);
  store.advanceJob(id);
  view = task(monitor.sync(store.getState()), id);
  assert.equal(view.tiebreak.status, 'submitted');
  assert.equal(view.tiebreak.percent, 100);
  assert.equal(storedJob(store, id).outcome, 'MainOutvoted');
});

test('sync retains work across view updates, drops removed jobs and reset clears samples', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob();
  store.advanceJob(id);
  monitor.sync(store.getState());
  monitor.tick();
  const progress = task(monitor.getSnapshot(), id).main.completed;
  assert.equal(task(monitor.sync(store.getState()), id).main.completed, progress);
  monitor.sync(store.reset());
  assert.equal(task(monitor.getSnapshot(), id), undefined);
  const empty = monitor.reset();
  assert.equal(empty.tick, 0);
  assert.deepEqual(empty.jobs, []);
  assert.deepEqual(empty.providers, []);
  assert.equal(monitor.sync(store.getState()).providers[0].history.length, 1);
});

const checkedState = (overrides = {}) => ({
  providers: [{ id: 'A', address: '0xa' }, { id: 'B', address: '0xb' }], transactions: [],
  jobs: [{ id: 'checked:1', mode: 'checked', provider: 'A', itemCount: 8, phase: 'Working', status: '搜索中', closed: false, events: [{ name: 'JobCreated', transactionHash: '0xcreate' }, { name: 'JobAccepted', transactionHash: '0xaccept' }], ...overrides }],
});

test('checked Working progress remains a local estimate and never submits, verifies or settles on ticks', () => {
  const state = checkedState({ verifiers: ['B'], tieProvider: 'B', coverage: 0 });
  const before = structuredClone(state);
  const monitor = createDemoMonitor();
  const first = monitor.sync(state);
  assert.equal(task(first, 'checked:1').main.status, 'computing');
  assert.deepEqual(task(first, 'checked:1').verifiers, []);
  assert.equal(task(first, 'checked:1').tiebreak, null);
  for (let count = 0; count < 25; count += 1) monitor.tick();
  const ready = monitor.getSnapshot();
  assert.equal(task(ready, 'checked:1').main.status, 'ready');
  assert.equal(task(ready, 'checked:1').main.percent, 100);
  assert.deepEqual(state, before);
  const html = renderComputeProgress(state.jobs[0], ready);
  assert.match(html, /待提交/);
  assert.match(html, /提交后由合约检验答案/);
  assert.doesNotMatch(html, /复核公开|不要求复核|已验证/);
});

test('checked successful submission counts only valid found answers and no verifier assignment', () => {
  const state = checkedState();
  state.jobs[0].events.push({ name: 'ResultsSubmitted', args: { found: [true, false, true, false, true, false, true, false] } }, { name: 'JobClosed', args: { outcome: 'Delivered' } });
  Object.assign(state.jobs[0], { phase: 'Closed', closed: true, outcome: 'Delivered' });
  const view = createDemoMonitor().sync(state);
  assert.equal(task(view, 'checked:1').main.status, 'submitted');
  assert.equal(task(view, 'checked:1').main.percent, 100);
  assert.match(renderComputeProgress(state.jobs[0], view), /有效答案 4 \/ 8 项 · 未找到 4 项/);
  assert.doesNotMatch(renderComputeProgress(state.jobs[0], view), /已证明无解|复核公开/);
});

test('checked closed tasks without submitted results stop promising future verification and preserve local completion', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ taskType: 'key-search-v1', provider: 'A', itemCount: 8 });
  store.advanceJob(id);
  monitor.sync(store.getState());
  for (let count = 0; count < 25; count += 1) monitor.tick();
  assert.equal(task(monitor.getSnapshot(), id).main.percent, 100);
  store.passDeadline(id);
  store.expireJob(id);
  let view = monitor.sync(store.getState());
  let html = renderComputeProgress(storedJob(store, id), view);
  assert.match(html, /没有已验证结果/);
  assert.doesNotMatch(html, /提交后由合约检验答案|有效答案|未找到 \d+ 项/);
  assert.equal(task(view, id).main.percent, 100, 'local completion does not establish a submitted or verified result');
  assert.equal(task(view, id).main.status, 'stopped');

  const cancelled = store.createJob({ taskType: 'key-search-v1', provider: 'B', itemCount: 8 });
  store.cancelJob(cancelled);
  view = monitor.sync(store.getState());
  html = renderComputeProgress(storedJob(store, cancelled), view);
  assert.match(html, /没有已验证结果/);
  assert.doesNotMatch(html, /提交后由合约检验答案|有效答案|未找到 \d+ 项/);
});

test('checked wrong-answer reverts have no submission effect and deadline passage keeps partial work', () => {
  const state = checkedState({ progress: { submit: 'done', check: 'done' }, lastSubmissionError: 'invalid answer' });
  const monitor = createDemoMonitor();
  const computing = monitor.sync(state);
  const partial = task(computing, 'checked:1').main.completed;
  assert.equal(task(computing, 'checked:1').main.status, 'computing');
  state.jobs[0].deadlinePassed = true;
  let view = monitor.sync(state);
  assert.equal(task(view, 'checked:1').main.status, 'stopped');
  assert.equal(task(view, 'checked:1').main.completed, partial);
  assert.equal(state.jobs[0].closed, false, 'clock alone does not close the job');
  monitor.tick();
  assert.equal(task(monitor.getSnapshot(), 'checked:1').main.completed, partial);
  Object.assign(state.jobs[0], { closed: true, phase: 'Closed', outcome: 'MainMissed' });
  state.jobs[0].events.push({ name: 'JobClosed', args: { outcome: 'MainMissed' } });
  view = monitor.sync(state);
  assert.equal(task(view, 'checked:1').main.status, 'stopped');
  assert.equal(task(view, 'checked:1').main.completed, partial);
});

test('checked offline providers stop other work and namespace separates both markets local job one', () => {
  const state = checkedState({ scenario: 'main-offline' });
  state.jobs.push({ id: 'replicated:1', mode: 'replicated', provider: 'B', itemCount: 200, phase: 'Committing', events: [{ name: 'JobCreated', transactionHash: '0xreplicated' }] });
  const monitor = createDemoMonitor();
  const view = monitor.sync(state);
  assert.equal(task(view, 'checked:1').main.status, 'offline');
  assert.equal(task(view, 'checked:1').main.percent, 38, 'small discrete workload is rounded to whole items');
  assert.equal(task(view, 'replicated:1').main.status, 'computing');
  assert.equal(task(view, 'replicated:1').main.percent, 12);
  assert.equal(node(view, 'A').connectivity, 'offline');
  assert.equal(node(view, 'B').connectivity, 'online');
});

test('actual checked-offline store scenario stops telemetry until a later provider action', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ taskType: 'key-search-v1', scenario: 'checked-offline', provider: 'A', itemCount: 8 });
  store.advanceJob(id);
  const view = monitor.sync(store.getState());
  const partial = task(view, id).main.completed;
  assert.equal(task(view, id).main.status, 'offline');
  assert.equal(node(view, 'A').connectivity, 'offline');
  monitor.tick();
  assert.equal(task(monitor.getSnapshot(), id).main.completed, partial);
  store.passDeadline(id);
  store.expireJob(id);
  const closed = monitor.sync(store.getState());
  assert.equal(task(closed, id).main.status, 'stopped');
  assert.equal(task(closed, id).main.completed, partial);
  assert.equal(node(closed, 'A').connectivity, 'offline');
});

test('resource timestamps record actual sample time while sync keeps the existing timed sample', t => {
  let now = 1780000000000;
  t.mock.method(Date, 'now', () => now);
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const state = store.getState();
  const first = node(monitor.sync(state), 'A');
  assert.equal(first.history.length, 1);
  assert.equal(first.history[0].timestamp, now);
  now += 800;
  const synced = node(monitor.sync(state), 'A');
  assert.equal(synced.history.length, 1, 'view reconciliation does not append a sample');
  assert.equal(synced.history[0].timestamp, first.history[0].timestamp);
  now += 6700;
  const sampled = node(monitor.tick(), 'A');
  assert.equal(sampled.history.length, 2);
  assert.equal(sampled.history[1].timestamp - sampled.history[0].timestamp, 7500, 'pauses appear as elapsed time, not a fabricated 1.5-second interval');
  assert.deepEqual(store.getState(), state, 'timestamps never advance the chain or settlement');
});

const resourceHtml = history => renderResources({ jobs: [] }, {
  jobs: [], providers: [{
    providerId: 'A', connectivity: 'online', activeAssignments: 0,
    hardware: { gpu: 'RTX 4090' }, gpuUtil: 60, memoryUsedGiB: 2.3,
    memoryTotalGiB: 24, cpuUtil: 20, tempC: 42, history,
  }],
}, 'A', false);

test('resource chart uses recorded elapsed time for numeric ticks and irregular sample positions', () => {
  const html = resourceHtml([
    { timestamp: 1780000000000, gpuUtil: 20 },
    { timestamp: 1780000001500, gpuUtil: 40 },
    { timestamp: 1780000006000, gpuUtil: 60 },
  ]);
  assert.match(html, /<span>−6s<\/span><span>−3s<\/span><span>0s<\/span>/);
  assert.match(html, /points="0,[^ ]+ 141\.5,[^ ]+ 566,/);
  assert.match(html, /最近 3 次 GPU 使用率，横轴为距最后采样的秒数/);
  assert.match(html, /<span>100%<\/span><span>50%<\/span><span>0%<\/span>/);
  assert.doesNotMatch(html, /较早|−34\.5s/);
});

test('resource chart does not invent an elapsed history for one sample and preserves offline gaps', () => {
  const initial = resourceHtml([{ timestamp: 1780000000000, gpuUtil: 20 }]);
  assert.match(initial, /<div class="chart-times"[^>]*><span><\/span><span>0s<\/span>/);
  assert.match(initial, /cx="566"/);
  assert.doesNotMatch(initial, /−[\d.]+s/);
  const gaps = resourceHtml([
    { timestamp: 1780000000000, gpuUtil: 20 },
    { timestamp: 1780000001500, gpuUtil: null },
    { timestamp: 1780000006000, gpuUtil: 60 },
  ]);
  assert.equal((gaps.match(/class="chart-line"/g) ?? []).length, 2);
  assert.doesNotMatch(gaps, /NaN|undefined/);
});

test('legacy telemetry without timestamps labels sample counts rather than claiming seconds', () => {
  const html = resourceHtml([{ tick: 0, gpuUtil: 20 }, { tick: 1, gpuUtil: 40 }, { tick: 2, gpuUtil: 60 }]);
  assert.match(html, /<span>−2次<\/span><span>−1次<\/span><span>0次<\/span>/);
  assert.match(html, /横轴为距最后采样的样本数/);
  assert.doesNotMatch(html, /−[\d.]+s/);
});

test('resource summary can render independently without duplicating task lists or sampling copy', () => {
  const state = checkedState();
  const snapshot = createDemoMonitor().sync(state);
  const complete = renderResources(state, snapshot, 'A', false);
  assert.match(complete, /class="panel resource-tasks"/);
  assert.match(complete, /任务 #checked:1/);
  const summary = renderResources(state, snapshot, 'A', false, { role: 'provider', showTasks: false });
  assert.match(summary, /^<section class="panel resource-panel">/);
  assert.doesNotMatch(summary, /resource-layout|resource-tasks|当前任务|monitor-task|checked:1/);
  assert.match(summary, /class="usage-chart"/);
  assert.match(summary, /<p>显存占用 · \d+ GiB<\/p>/);
  assert.doesNotMatch(summary, /共 \d+ GiB|采样暂停|每 1\.5 秒采样|最近 24 次采样/);
  assert.equal(renderResources(state, snapshot, 'A', true, { role: 'provider', showTasks: false }), summary,
    'the compatible paused argument does not add redundant panel text');
  const resourceOnlyState = {};
  Object.defineProperty(resourceOnlyState, 'jobs', { get() { throw new Error('task list was unnecessarily read'); } });
  assert.equal(renderResources(resourceOnlyState, snapshot, 'A', false, { role: 'provider', showTasks: false }), summary);
});

test('provider compute coverage conceals both verification choices until the task closes', () => {
  const monitor = createDemoMonitor();
  const state = { providers: [{ id: 'A' }], transactions: [], jobs: [{ id: 'replicated:private', provider: 'A', itemCount: 10, mode: 'replicated', phase: 'Committing', status: '计算中', closed: false, events: [] }] };
  const view = monitor.sync(state);
  const yes = renderComputeProgress({ ...state.jobs[0], verify: true, coverage: 0 }, view, { role: 'provider', providerId: 'A' });
  const no = renderComputeProgress({ ...state.jobs[0], verify: false, coverage: 0 }, view, { role: 'provider', providerId: 'A' });
  assert.equal(yes, no);
  assert.match(yes, /监管待确认/);
  assert.doesNotMatch(yes, /不要求复核|复核公开/);
  assert.match(renderComputeProgress({ ...state.jobs[0], verify: false }, view), /不要求复核/, 'client remains able to see its own choice');
});

test('closed provider coverage distinguishes successful unverified delivery, failure, and public verification', () => {
  const store = createDemoStore();
  const monitor = createDemoMonitor();
  const id = store.createJob({ verify: false, provider: 'A', itemCount: 10 });
  until(store, id, job => job.closed);
  const job = storedJob(store, id);
  const view = monitor.sync(store.getState());
  assert.match(renderComputeProgress(job, view, { role: 'provider', providerId: 'A' }), /监管通过/);
  assert.match(renderComputeProgress({ ...job, outcome: 'MainMissed' }, view, { role: 'provider' }), /监管未完成/);
  assert.match(renderComputeProgress({ ...job, outcome: 'Cancelled', events: [] }, view, { role: 'provider' }), /监管未完成/);
  assert.match(renderComputeProgress({ ...job, outcome: 'Verified', verifiers: ['B', 'C'], coverage: 10 }, view, { role: 'provider' }), /监管公开 10 \/ 10 张/);
});

test('render monitoring uses frame units and recognizes judgement receipts without inventing exact leaves', () => {
  const monitor = createDemoMonitor();
  const job = { id: 'replicated:render', taskType: 'blender-render-v1', mode: 'replicated',
    provider: 'A', itemCount: 10, phase: 'Disputing', status: '待验收', closed: false,
    verify: true, verifiers: ['B', 'C', 'D'], verifierStates: ['Revealed', 'Revealed', 'Revealed'],
    coverage: 10, events: [{ name: 'ResultsCommitted' }] };
  const state = { jobs: [job], providers: ['A', 'B', 'C', 'D', 'E'].map(id => ({ id })), transactions: [] };
  let snapshot = monitor.sync(state);
  assert.deepEqual(task(snapshot, job.id).verifiers.map(entry => entry.total), [3, 3, 4]);
  assert.match(renderComputeProgress(job, snapshot), /10 \/ 10 帧/);
  assert.match(renderComputeProgress(job, snapshot), /待验收 · 帧图相似度由链下比对/);
  const providerView = renderComputeProgress(job, snapshot, { role: 'provider', providerId: 'A' });
  assert.match(providerView, /监管待确认/);
  assert.doesNotMatch(providerView, /待验收 · 帧图相似度/);

  Object.assign(job, { phase: 'TieBreak', tieProvider: 'E', tieShared: true });
  job.events.push({ name: 'ResultsDisputed', args: { items: [1, 3, 8] } });
  snapshot = monitor.sync(state);
  assert.equal(task(snapshot, job.id).tiebreak.total, 3);
  assert.equal(task(snapshot, job.id).tiebreak.status, 'computing');
  Object.assign(job, { phase: 'Closed', closed: true, outcome: 'DisputeRejected' });
  job.events.push({ name: 'JudgementSubmitted', args: { verdicts: [3, 3, 3] } });
  snapshot = monitor.sync(state);
  assert.equal(task(snapshot, job.id).tiebreak.status, 'submitted');
  assert.equal(task(snapshot, job.id).tiebreak.percent, 100);
  assert.equal(job.events.some(event => event.name === 'TiebreakSubmitted'), false);
});
