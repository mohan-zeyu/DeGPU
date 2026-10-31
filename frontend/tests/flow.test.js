import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { drawFlowWires, renderFlow } from '../src/flow.js';

function cancelledJob(scenario = 'verified') {
  const store = createDemoStore();
  const id = store.createJob({ scenario });
  store.cancelJob(id);
  return { store, job: store.getState().jobs.find(item => item.id === id) };
}

const nodesFrom = html => [...html.matchAll(/class="flow-node" data-step="([^"]+)" data-state="([^"]+)"/g)]
  .map(([, step, state]) => ({ step, state }));
const proofNames = html => [...html.matchAll(/class="link" href="[^\"]+">#[^<]+ · ([^<]+)<\/a>/g)]
  .map(([, name]) => name);

for (const scenario of ['verified', 'unverified']) {
  test(`cancelled ${scenario} task renders only confirmed creation, cancellation and refund`, () => {
    const { store, job } = cancelledJob(scenario);
    const before = store.getState();
    const html = renderFlow(job);
    assert.equal(job.outcome, 'Cancelled');
    assert.deepEqual(nodesFrom(html), [
      { step: 'create', state: 'done' }, { step: 'cancel', state: 'done' }, { step: 'settle', state: 'done' },
    ]);
    assert.match(html, /data-flow-mode="cancelled"/);
    for (const label of ['发布任务', '取消任务', '退还预存']) assert.ok(html.includes(label));
    assert.doesNotMatch(html, /提供方承诺|公开复核决定|复核覆盖|class="gate"/);
    assert.deepEqual(store.getState(), before, 'rendering cannot alter the task or its chain records');
  });
}

test('cancelled task steps link to actual creation, cancellation and client-refund events', () => {
  const { store, job } = cancelledJob();
  const create = job.events.find(entry => entry.name === 'JobCreated');
  const close = job.events.find(entry => entry.name === 'JobClosed');
  const refund = job.events.find(entry => entry.name === 'Payout');
  const receipt = store.getState().transactions.find(entry => entry.hash === close.transactionHash);
  assert.equal(receipt.method, 'cancel');
  assert.equal(receipt.status, 1);
  assert.equal(close.args.outcome, 'Cancelled');
  assert.equal(refund.args.to, job.clientAddress);
  assert.equal(refund.args.amountEth, job.deposit);
  assert.equal(refund.transactionHash, close.transactionHash, 'refund and cancellation share one transaction');

  for (const [step, evidence] of [['create', create], ['cancel', close], ['settle', refund]]) {
    const html = renderFlow(job, step);
    assert.deepEqual(proofNames(html), [evidence.name]);
    assert.ok(html.includes(`href="#/chain?tx=${evidence.transactionHash}"`));
    assert.ok(html.includes(`#${evidence.blockNumber} · ${evidence.name}`));
    assert.ok(html.includes(`logIndex ${evidence.logIndex}`));
    assert.doesNotMatch(html, /class="gate"/);
  }
});

test('cancelled task does not confirm a refund from another recipient or an unrelated closure', () => {
  const { job } = cancelledJob();
  const missingEvidence = structuredClone(job);
  missingEvidence.events.find(entry => entry.name === 'JobClosed').args.outcome = 'Delivered';
  missingEvidence.events.find(entry => entry.name === 'Payout').args.to = '0x0000000000000000000000000000000000000001';
  assert.deepEqual(nodesFrom(renderFlow(missingEvidence)), [
    { step: 'create', state: 'done' }, { step: 'cancel', state: 'pending' }, { step: 'settle', state: 'pending' },
  ]);
});

test('cancelled task wires connect its three confirmed nodes horizontally and when stacked', () => {
  const { job } = cancelledJob();
  const nodes = nodesFrom(renderFlow(job));
  const originalDocument = globalThis.document;
  const element = tagName => ({
    tagName, children: [], attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  });
  globalThis.document = { createElementNS: (_namespace, tagName) => element(tagName) };
  try {
    for (const stacked of [false, true]) {
      const svg = element('svg');
      const board = {
        dataset: { flowMode: 'cancelled', hasDispute: 'false' },
        matches: selector => selector === '.flow-board',
        getBoundingClientRect: () => ({ left: 0, top: 0, width: stacked ? 220 : 640, height: stacked ? 300 : 100 }),
        querySelector: selector => selector === '.wires' ? svg : null,
        querySelectorAll: () => nodes.map((node, index) => ({
          dataset: node,
          getBoundingClientRect: () => ({ left: stacked ? 10 : 10 + index * 210, top: stacked ? 10 + index * 100 : 10, width: 180, height: 70 }),
        })),
      };
      drawFlowWires(board);
      const paths = svg.children.filter(child => child.tagName === 'path');
      assert.deepEqual(paths.map(path => path.attributes.d), stacked
        ? ['M 100 80 L 100 110', 'M 100 180 L 100 210']
        : ['M 190 45 L 220 45', 'M 400 45 L 430 45']);
      assert.ok(paths.every(path => path.attributes.class === 'wire confirmed'));
      assert.ok(paths.every(path => path.attributes['marker-end']), 'each connection has a direction arrow');
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

const checkedEvent = (name, args = {}, transactionHash = '0xsubmit') => ({ name, args, transactionHash, blockNumber: 7, logIndex: 0 });
function checkedJob(overrides = {}) {
  return {
    id: 'checked:1', mode: 'checked', phase: 'Working', status: '搜索中', provider: 'A',
    clientAddress: '0xclient', itemCount: 2, closed: false, verify: false,
    events: [checkedEvent('JobCreated', {}, '0xcreate'), checkedEvent('JobAccepted', {}, '0xaccept')],
    ...overrides,
  };
}

test('checked flow follows accept and submit events without replicated commitments or verification roles', () => {
  const job = checkedJob({ progress: { create: 'done', accept: 'done', search: 'done', submit: 'done', check: 'done', settle: 'done' } });
  const before = structuredClone(job);
  const html = renderFlow(job, 'search');
  assert.deepEqual(nodesFrom(html), [
    { step: 'create', state: 'done' }, { step: 'accept', state: 'done' }, { step: 'search', state: 'current' },
    { step: 'submit', state: 'pending' }, { step: 'check', state: 'pending' }, { step: 'settle', state: 'pending' },
  ]);
  assert.deepEqual(proofNames(html), [], 'search has no chain event');
  assert.match(html, /搜索过程不上链/);
  assert.ok(html.indexOf('提交、检验、结算 · 同一笔交易') < html.indexOf('<details'), 'transaction boundary stays visible when details are collapsed');
  assert.doesNotMatch(html, /提供方承诺|公开复核决定|复核覆盖|data-step="tie|data-step="share|data-step="decision/);
  assert.deepEqual(job, before);
  const open = checkedJob({ phase: 'Open', events: [checkedEvent('JobCreated')] });
  assert.equal(nodesFrom(renderFlow(open)).find(node => node.step === 'accept').state, 'current');
});

test('checked submit and checker steps use the same successful submission, only found answers count', () => {
  const job = checkedJob();
  job.events.push(checkedEvent('ResultsSubmitted', { answers: ['0x01', '0x00'], found: [true, false] }), checkedEvent('Payout', { to: '0xprovider' }), checkedEvent('Payout', { to: '0xclient' }), checkedEvent('JobClosed', { outcome: 'Delivered' }));
  Object.assign(job, { phase: 'Closed', status: '已交付', closed: true, outcome: 'Delivered', closeMethod: 'submitResults' });
  assert.ok(nodesFrom(renderFlow(job)).every(node => node.state === 'done'));
  for (const step of ['submit', 'check']) {
    const html = renderFlow(job, step);
    assert.deepEqual(proofNames(html), ['ResultsSubmitted']);
    assert.match(html, /href="#\/chain\?tx=0xsubmit"/);
    assert.match(html, /有效答案 1 \/ 2/);
    assert.match(html, /同一笔交易/);
  }
  assert.match(renderFlow(job, 'check'), /found=false 只表示未提交解/);
  assert.match(renderFlow(job, 'settle'), /未找到不是已证明无解/);
});

test('checked RPC numeric closure enums confirm settlement, cancellation and expiry', () => {
  for (const rawOutcome of [2, '2']) {
    const delivered = checkedJob({ closed: true, phase: 'Closed', outcome: 'Delivered', closeMethod: 'submitResults' });
    delivered.events.push(checkedEvent('ResultsSubmitted', { found: [true, false] }),
      checkedEvent('Payout', { to: '0xprovider' }), checkedEvent('JobClosed', { outcome: rawOutcome }));
    const before = structuredClone(delivered);
    assert.ok(nodesFrom(renderFlow(delivered)).every(node => node.state === 'done'));
    assert.deepEqual(proofNames(renderFlow(delivered, 'settle')), ['Payout', 'JobClosed']);
    assert.deepEqual(delivered, before, 'decoding must preserve the original numeric receipt');
  }
  const cancelled = checkedJob({ closed: true, phase: 'Closed', outcome: 'Cancelled', closeMethod: 'cancel',
    events: [checkedEvent('JobCreated'), checkedEvent('Payout', { to: '0xclient' }), checkedEvent('JobClosed', { outcome: 1 })] });
  assert.ok(nodesFrom(renderFlow(cancelled)).every(node => node.state === 'done'));
  assert.deepEqual(proofNames(renderFlow(cancelled, 'cancel')), ['JobClosed']);
  const missed = checkedJob({ closed: true, phase: 'Closed', outcome: 'MainMissed', closeMethod: 'expire' });
  missed.events.push(checkedEvent('ProviderSlashed'), checkedEvent('Payout', { to: '0xclient' }),
    checkedEvent('JobClosed', { outcome: 3 }));
  assert.equal(nodesFrom(renderFlow(missed)).find(node => node.step === 'settle').state, 'done');
  assert.deepEqual(proofNames(renderFlow(missed, 'expire')), ['JobClosed']);
});

test('checked invalid submissions cannot advance the checker or settle without success logs', () => {
  const job = checkedJob({ lastSubmissionError: 'invalid answer', solved: 2, progress: { submit: 'done', check: 'done' } });
  for (const step of ['submit', 'check', 'settle']) {
    const html = renderFlow(job, step);
    assert.equal(nodesFrom(html).find(node => node.step === step).state, 'pending');
    assert.deepEqual(proofNames(html), []);
  }
  assert.match(renderFlow(job, 'submit'), /整笔交易回退/);
  assert.match(renderFlow(job, 'submit'), /改正后重新提交/);
  const rejected = renderFlow(job, 'retry');
  assert.equal(nodesFrom(rejected).find(node => node.step === 'retry').state, 'current');
  assert.match(rejected, /答案无效 · 整笔回退/);
  assert.match(rejected, /本次尝试没有成功确认事件/);
  assert.deepEqual(proofNames(rejected), []);
  job.events.push(checkedEvent('ResultsSubmitted', { found: [true, true] }), checkedEvent('JobClosed', { outcome: 'Delivered' }));
  Object.assign(job, { closed: true, phase: 'Closed', outcome: 'Delivered' });
  assert.doesNotMatch(renderFlow(job), /data-step="retry"|答案无效 · 整笔回退/);
  assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'check').state, 'done');
});

test('checked deadline passing remains pending until expire, with separate Open and Working branches', () => {
  const working = checkedJob({ deadlinePassed: true });
  let nodes = nodesFrom(renderFlow(working));
  assert.deepEqual(nodes.map(node => node.step), ['create', 'accept', 'search', 'expire', 'settle']);
  assert.equal(nodes.find(node => node.step === 'search').state, 'skipped');
  assert.equal(nodes.find(node => node.step === 'expire').state, 'current');
  assert.equal(nodes.find(node => node.step === 'settle').state, 'pending');
  assert.deepEqual(proofNames(renderFlow(working, 'expire')), []);
  working.events.push(checkedEvent('ProviderSlashed'), checkedEvent('Payout', { to: '0xclient' }), checkedEvent('JobClosed', { outcome: 'MainMissed' }));
  Object.assign(working, { closed: true, phase: 'Closed', outcome: 'MainMissed', closeMethod: 'expire' });
  assert.equal(nodesFrom(renderFlow(working)).find(node => node.step === 'expire').state, 'done');
  assert.doesNotMatch(renderFlow(working), /data-step="submit"|data-step="check"/);

  const open = checkedJob({ phase: 'Open', deadlinePassed: true, events: [checkedEvent('JobCreated')] });
  assert.deepEqual(nodesFrom(renderFlow(open)).map(node => node.step), ['create', 'expire', 'settle']);
  open.events.push(checkedEvent('Payout', { to: '0xclient' }), checkedEvent('JobClosed', { outcome: 'Cancelled' }));
  Object.assign(open, { closed: true, phase: 'Closed', outcome: 'Cancelled', closeMethod: 'expire' });
  assert.match(renderFlow(open), /data-flow-mode="checked-open-timeout"/);
  assert.doesNotMatch(renderFlow(open), /data-step="cancel"/);
  assert.ok(nodesFrom(renderFlow(open)).every(node => node.state === 'done'));
  const cancelled = { ...open, closeMethod: 'cancel' };
  assert.deepEqual(nodesFrom(renderFlow(cancelled)).map(node => node.step), ['create', 'cancel', 'settle']);
  assert.match(renderFlow(cancelled), /data-flow-mode="checked-cancelled"/);
});

test('checked flow wires connect the chronological serpentine on desktop and vertical stack on narrow screens', () => {
  const job = checkedJob();
  job.events.push(checkedEvent('ResultsSubmitted', { found: [true, true] }), checkedEvent('JobClosed', { outcome: 'Delivered' }));
  Object.assign(job, { closed: true, phase: 'Closed', outcome: 'Delivered' });
  const nodes = nodesFrom(renderFlow(job));
  const originalDocument = globalThis.document;
  const element = tagName => ({ tagName, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  globalThis.document = { createElementNS: (_namespace, tagName) => element(tagName) };
  try {
    for (const stacked of [false, true]) {
      const svg = element('svg');
      const grid = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1]];
      const board = {
        dataset: { flowMode: 'checked', hasDispute: 'false' }, matches: () => true,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: stacked ? 220 : 640, height: stacked ? 600 : 210 }),
        querySelector: () => svg,
        querySelectorAll: () => nodes.map((node, index) => ({ dataset: node, getBoundingClientRect: () => ({ left: stacked ? 10 : 10 + grid[index][0] * 210, top: stacked ? 10 + index * 100 : 10 + grid[index][1] * 110, width: 180, height: 70 }) })),
      };
      drawFlowWires(board);
      const paths = svg.children.filter(child => child.tagName === 'path');
      assert.deepEqual(paths.map(path => path.attributes.d), stacked
        ? Array.from({ length: 5 }, (_, index) => `M 100 ${80 + index * 100} L 100 ${110 + index * 100}`)
        : ['M 190 45 L 220 45', 'M 400 45 L 430 45', 'M 520 80 L 520 120', 'M 430 155 L 400 155', 'M 220 155 L 190 155']);
      assert.ok(paths.every(path => path.attributes.class === 'wire confirmed'));
      assert.ok(paths.every(path => path.attributes['marker-end']));
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('checked store rejection remains unconfirmed and a corrected resubmission closes all three atomic steps', () => {
  const store = createDemoStore();
  const id = store.createJob({ taskType: 'key-search-v1', scenario: 'checked-invalid', provider: 'A', itemCount: 8 });
  store.advanceJob(id);
  const accepted = store.getState();
  assert.throws(() => store.advanceJob(id), /校验/);
  const rejected = store.getState();
  const job = rejected.jobs.find(entry => entry.id === id);
  assert.equal(job.phase, 'Working');
  assert.equal(job.lastRejected.confirmed, false);
  assert.equal(rejected.transactions.length, accepted.transactions.length);
  assert.ok(!job.events.some(entry => entry.name === 'ResultsSubmitted'));
  assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'retry').state, 'current');
  assert.deepEqual(proofNames(renderFlow(job, 'check')), []);
  store.advanceJob(id);
  const done = store.getState().jobs.find(entry => entry.id === id);
  assert.equal(done.outcome, 'Delivered');
  assert.ok(nodesFrom(renderFlow(done)).every(node => node.state === 'done'));
  assert.doesNotMatch(renderFlow(done), /data-step="retry"/);
  const submission = done.events.find(entry => entry.name === 'ResultsSubmitted');
  const settlement = done.events.filter(entry => entry.name === 'Payout' || entry.name === 'JobClosed');
  assert.ok(settlement.length > 0);
  assert.ok(settlement.every(entry => entry.transactionHash === submission.transactionHash));
});

test('provider flow cannot reveal the private review choice or preselected regulator identities', () => {
  const base = {
    mode: 'replicated', provider: 'A', status: '等待主节点提交承诺', phase: 'Committing',
    events: [checkedEvent('JobCreated'), checkedEvent('JobAccepted')],
    progress: { create: 'done', accept: 'done', commit: 'current' },
  };
  const view = { role: 'provider', providerId: 'A' };
  for (const phase of ['Open', 'Committing', 'Deciding', 'Publishing']) {
    const yes = { ...base, phase, verify: true, verifiers: ['SECRET_B', 'SECRET_C'], coverage: 999,
      progress: { ...base.progress, shareB: 'current', shareC: 'current' } };
    const no = { ...base, phase, verify: false, verifiers: [], coverage: 0,
      progress: { ...base.progress, shareB: 'skipped', shareC: 'skipped' } };
    assert.equal(renderFlow(yes, 'oversight', view), renderFlow(no, 'oversight', view));
    const html = renderFlow(yes, 'oversight', view);
    assert.match(html, /data-flow-mode="provider-regulated"/);
    assert.match(html, /data-step="oversight" data-state="pending"/);
    assert.doesNotMatch(html, /SECRET_|本任务不复核|跳过复核|复核覆盖|本次未触发复核/);
  }
  const secret = { ...base, get verify() { throw new Error('private choice accessed'); } };
  assert.doesNotThrow(() => renderFlow(secret, null, view));
  assert.match(renderFlow({ ...base, verify: false }), /data-flow-mode="unverified"/, 'client keeps the real branch');
});

test('provider regulator pass after unreviewed delivery uses real delivery records without inventing review events', () => {
  const job = {
    mode: 'replicated', provider: 'A', phase: 'Publishing', status: '等待主节点公开结果',
    events: [checkedEvent('JobCreated'), checkedEvent('JobAccepted'), checkedEvent('ResultsCommitted'), checkedEvent('DecisionRevealed', { verify: false })],
    progress: {},
  };
  const view = { role: 'provider', providerId: 'A' };
  const before = renderFlow(job, 'oversight', view);
  assert.equal(nodesFrom(before).find(node => node.step === 'oversight').state, 'pending');
  assert.doesNotMatch(before, /本次未触发复核，交付后自动放行/);
  job.events.push(checkedEvent('ResultsPublished'), checkedEvent('Payout'), checkedEvent('JobClosed', { outcome: 'Delivered' }));
  Object.assign(job, { phase: 'Closed', closed: true, outcome: 'Delivered', status: '交付完成' });
  const html = renderFlow(job, 'oversight', view);
  assert.equal(nodesFrom(html).find(node => node.step === 'oversight').state, 'done');
  assert.match(html, /监管检查，通过/);
  assert.match(html, /本次未触发复核，交付后自动放行/);
  assert.deepEqual(proofNames(html), ['ResultsPublished', 'JobClosed']);
  assert.doesNotMatch(html, / · CheckRevealed| · CheckCommitted|data-step="shareB"/);
});

test('provider review branches expose regulator identities only after the public draw and retain direct checker semantics', () => {
  const store = createDemoStore();
  const id = store.createJob({ scenario: 'verified', provider: 'A' });
  for (let step = 0; step < 3; step += 1) store.advanceJob(id);
  const job = store.getState().jobs.find(item => item.id === id);
  assert.ok(job.events.some(entry => entry.name === 'VerifiersDrawn'));
  const html = renderFlow(job, 'oversight', { role: 'provider', providerId: 'A' });
  for (const id of job.verifiers) assert.ok(html.includes(`复核方 ${id}`));
  for (const key of ['shareB', 'shareC', 'commitB', 'commitC', 'revealB', 'revealC', 'oversight']) {
    assert.ok(nodesFrom(html).some(node => node.step === key));
  }
  assert.match(html, /复核方已按公开分配记录显示/);
  assert.match(html, /data-step="tieShare"[^>]*style="grid-row:5;grid-column:2"/);
  assert.match(html, /data-step="tie"[^>]*style="grid-row:5;grid-column:3"/);
  assert.doesNotMatch(html, /grid-row:6/);
  const direct = renderFlow(checkedJob(), null, { role: 'provider', providerId: 'A' });
  assert.match(direct, /data-flow-mode="checked"/);
  assert.doesNotMatch(direct, /data-step="oversight"|data-step="decision"|data-step="share/);
});

test('provider regulator gate stays connected after delivery on desktop and stacked layouts', () => {
  const events = ['JobCreated', 'JobAccepted', 'ResultsCommitted', 'DecisionRevealed', 'ResultsPublished']
    .map(name => checkedEvent(name));
  events.push(checkedEvent('JobClosed', { outcome: 'Delivered' }));
  const unreviewed = renderFlow({ mode: 'replicated', phase: 'Closed', provider: 'A', closed: true, events }, null, { role: 'provider' });
  const store = createDemoStore();
  const jobId = store.createJob({ scenario: 'main-cheat', provider: 'A' });
  for (let step = 0; step < 20 && !store.getState().jobs.find(job => job.id === jobId).closed; step += 1) store.advanceJob(jobId);
  const reviewedJob = store.getState().jobs.find(job => job.id === jobId);
  assert.ok(reviewedJob.closed);
  const reviewed = renderFlow(reviewedJob, null, { role: 'provider' });
  const originalDocument = globalThis.document;
  const element = tagName => ({ tagName, children: [], attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  globalThis.document = { createElementNS: (_namespace, tagName) => element(tagName) };
  try {
    for (const html of [unreviewed, reviewed]) for (const stacked of [false, true]) {
      const nodes = [...html.matchAll(/class="flow-node" data-step="([^"]+)" data-state="([^"]+)" style="grid-row:(\d+);grid-column:(\d+)"/g)]
        .map(([, step, state, row, column]) => ({ step, state, row: Number(row), column: Number(column) }));
      const disputed = html === reviewed;
      const svg = element('svg');
      const board = {
        dataset: { flowMode: 'provider-regulated', hasDispute: String(disputed) }, matches: () => true,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: stacked ? 220 : 640, height: stacked ? nodes.length * 100 : disputed ? 440 : 210 }),
        querySelector: () => svg,
        querySelectorAll: () => nodes.map((node, index) => ({ dataset: node, getBoundingClientRect: () => ({
          left: stacked ? 10 : 10 + (node.column - 1) * 210,
          top: stacked ? 10 + index * 100 : 10 + (node.row - 1) * 86, width: 180, height: 64,
        }) })),
      };
      drawFlowWires(board);
      const paths = svg.children.filter(child => child.tagName === 'path');
      assert.equal(paths.length, disputed ? 18 : 5);
      assert.equal(paths.filter(path => path.attributes.class === 'wire confirmed').length, disputed ? 17 : 5);
      assert.ok(paths.every(path => !/NaN|undefined/.test(path.attributes.d)));
      assert.equal(paths.filter(path => path.attributes['marker-end']).length, disputed ? 14 : 5, 'barrier/join source segments share their destination arrow');
      if (disputed && !stacked) {
        assert.equal(paths.at(-2).attributes.d, 'M 400 386 L 430 386', 'the two dispute stages share one row');
        assert.equal(paths.at(-1).attributes.d, 'M 520 354 L 520 332', 'the same-column return reaches settlement without crossing either node');
      }
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

function similarJob(overrides = {}) {
  return {
    id: 'replicated:8', mode: 'replicated', compare: 'similar', taskType: 'blender-render-v1',
    provider: 'A', clientAddress: '0xclient', phase: 'Disputing', status: '等待客户比较',
    itemCount: 4, verify: true, coverage: 4, verifiers: ['B', 'C'], closed: false,
    events: [
      checkedEvent('JobCreated', {}, '0xcreate'), checkedEvent('JobAccepted', {}, '0xaccept'),
      checkedEvent('ResultsCommitted', {}, '0xcommit'), checkedEvent('DecisionRevealed', { verify: true }, '0xdecision'),
      checkedEvent('VerifiersDrawn', { verifiers: ['B', 'C'] }, '0xdecision'),
      ...[0, 1].flatMap(slot => [
        checkedEvent('RangeShared', { slot }, `0xshare${slot}`),
        checkedEvent('CheckCommitted', { slot }, `0xcommit${slot}`),
        checkedEvent('CheckRevealed', { slot, leaves: ['0xleaf'], resultsURI: `store:verifier${slot}` }, `0xreveal${slot}`),
      ]),
      checkedEvent('ResultsPublished', { leaves: ['0xmain'], resultsURI: 'store:main' }, '0xpublish'),
    ],
    ...overrides,
  };
}

test('replicated RPC enums confirm exact settlement, render acceptance and provider oversight', () => {
  const store = createDemoStore();
  const id = store.createJob({ scenario: 'verified', provider: 'A', itemCount: 2 });
  while (!store.getState().jobs.find(job => job.id === id).closed) store.advanceJob(id);
  const exact = store.getState().jobs.find(job => job.id === id);
  exact.events.find(event => event.name === 'JobClosed').args.outcome = 3;
  assert.equal(nodesFrom(renderFlow(exact)).find(node => node.step === 'settle').state, 'done');
  assert.equal(nodesFrom(renderFlow(exact, 'settle', { role: 'provider' })).find(node => node.step === 'settle').state, 'done');
  assert.match(renderFlow(exact, 'oversight', { role: 'provider' }), /监管检查，通过/);

  const accepted = similarJob({ closed: true, phase: 'Closed', outcome: 'Verified', closeMethod: 'acceptResults' });
  accepted.events.push(checkedEvent('Payout', { to: '0xprovider' }), checkedEvent('JobClosed', { outcome: 3 }));
  for (const step of ['review', 'acceptResults', 'settle']) {
    assert.equal(nodesFrom(renderFlow(accepted)).find(node => node.step === step).state, 'done');
  }
  assert.deepEqual(proofNames(renderFlow(accepted, 'acceptResults')), ['Payout', 'JobClosed']);
  assert.match(renderFlow(accepted, 'oversight', { role: 'provider' }), /监管检查，通过/);

  const rejected = similarJob({ closed: true, phase: 'Closed', outcome: 'DisputeRejected', disputedItems: [0] });
  rejected.events.push(checkedEvent('ResultsDisputed', { items: [0] }), checkedEvent('JudgementSubmitted', { verdicts: [3] }),
    checkedEvent('JobClosed', { outcome: 11 }));
  assert.match(renderFlow(rejected, 'oversight', { role: 'provider' }), /监管检查，通过/);
  assert.equal(nodesFrom(renderFlow(rejected)).find(node => node.step === 'acceptResults').state, 'skipped');

  const { job: cancelled } = cancelledJob();
  cancelled.events.find(event => event.name === 'JobClosed').args.outcome = 1;
  assert.ok(nodesFrom(renderFlow(cancelled)).every(node => node.state === 'done'));
});

test('similar file publication waits for client review and does not use hash equality or direct checking', () => {
  const job = similarJob({ progress: { publish: 'done', settle: 'done', review: 'done' } });
  const original = structuredClone(job);
  const html = renderFlow(job, 'review');
  assert.match(html, /data-flow-mode="similar"/);
  const nodes = nodesFrom(html);
  assert.equal(nodes.find(node => node.step === 'publish').state, 'done');
  assert.equal(nodes.find(node => node.step === 'review').state, 'current');
  assert.equal(nodes.find(node => node.step === 'acceptResults').state, 'pending');
  assert.equal(nodes.find(node => node.step === 'settle').state, 'pending');
  assert.deepEqual(proofNames(html), [], 'local comparisons cannot invent a chain event');
  assert.match(html, /比较过程不上链/);
  assert.match(html, /任务固定的相似度指标/);
  assert.doesNotMatch(html, /合约逐项检验|data-step="check"|公开结果与比对/);
  assert.match(renderFlow(job, 'publish'), /进入 Disputing/);
  assert.deepEqual(proofNames(renderFlow(job, 'publish')), ['ResultsPublished']);
  assert.deepEqual(proofNames(renderFlow(job, 'revealB')), ['CheckRevealed']);
  assert.deepEqual(job, original);
});

test('similar acceptance and settlement share actual close records with no invented acceptance event', () => {
  const job = similarJob();
  job.events.push(checkedEvent('Payout', { to: '0xprovider' }, '0xaccepted'), checkedEvent('JobClosed', { outcome: 'Verified' }, '0xaccepted'));
  Object.assign(job, { phase: 'Closed', status: '已验收', closed: true, outcome: 'Verified', closeMethod: 'acceptResults' });
  const nodes = nodesFrom(renderFlow(job));
  for (const step of ['publish', 'review', 'acceptResults', 'settle']) assert.equal(nodes.find(node => node.step === step).state, 'done');
  for (const step of ['dispute', 'tieShare', 'tie']) assert.equal(nodes.find(node => node.step === step).state, 'skipped');
  assert.deepEqual(proofNames(renderFlow(job, 'acceptResults')), ['Payout', 'JobClosed']);
  assert.match(renderFlow(job, 'acceptResults'), /href="#\/chain\?tx=0xaccepted"/);
  assert.deepEqual(proofNames(renderFlow(job, 'review')), []);
  assert.match(renderFlow(job, 'acceptResults'), /没有独立的接收事件/);
  const provider = renderFlow(job, 'oversight', { role: 'provider' });
  assert.match(provider, /监管检查，通过/);
  assert.doesNotMatch(provider, /本次未触发复核，交付后自动放行/);
});

test('similar disputes expose a bond, encrypted result sharing and submitted judgement rather than exact tiebreak leaves', () => {
  const job = similarJob({ phase: 'TieBreak', status: '等待裁决', tieProvider: 'D', disputeBond: '0.002', disputedItems: [1, 3] });
  job.events.push(checkedEvent('ResultsDisputed', { items: [1, 3] }, '0xdispute'), checkedEvent('TiebreakStarted', { tiebreaker: 'D', mismatched: [1, 3] }, '0xdispute'));
  let nodes = nodesFrom(renderFlow(job));
  assert.equal(nodes.find(node => node.step === 'review').state, 'done');
  assert.equal(nodes.find(node => node.step === 'dispute').state, 'done');
  assert.equal(nodes.find(node => node.step === 'acceptResults').state, 'skipped');
  assert.equal(nodes.find(node => node.step === 'tieShare').state, 'current');
  assert.deepEqual(proofNames(renderFlow(job, 'dispute')), ['ResultsDisputed', 'TiebreakStarted']);
  assert.match(renderFlow(job, 'dispute'), /等于 tiebreakFee 的保证金/);
  assert.match(renderFlow(job, 'tieShare'), /结果文件密钥/);
  job.events.push(checkedEvent('TiebreakShared', {}, '0xtieshare'));
  assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'tie').state, 'current');
  job.events.push(checkedEvent('JudgementSubmitted', { verdicts: [2, 2] }, '0xjudge'), checkedEvent('ProviderSlashed', {}, '0xjudge'), checkedEvent('Payout', {}, '0xjudge'), checkedEvent('JobClosed', { outcome: 'MainOutvoted' }, '0xjudge'));
  Object.assign(job, { closed: true, phase: 'Closed', outcome: 'MainOutvoted', closeMethod: 'submitJudgement' });
  assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'tie').state, 'done');
  assert.deepEqual(proofNames(renderFlow(job, 'tie')), ['JudgementSubmitted']);
  assert.match(renderFlow(job, 'tie'), /位 0 表示提供方结果可接受，位 1 表示对应复核方结果可接受/);
  assert.doesNotMatch(renderFlow(job, 'tie'), / · TiebreakSubmitted/);
  assert.match(renderFlow(job, 'oversight', { role: 'provider' }), /监管检查，未通过/);
});

test('similar provider view keeps private verification hidden and never auto-passes upon file publication', () => {
  const initial = similarJob({ phase: 'Committing', status: '计算中', events: [checkedEvent('JobCreated'), checkedEvent('JobAccepted')] });
  const view = { role: 'provider' };
  const yes = { ...initial, verify: true, verifiers: ['SECRET_B', 'SECRET_C'], coverage: 4 };
  const no = { ...initial, verify: false, verifiers: [], coverage: 0 };
  assert.equal(renderFlow(yes, 'oversight', view), renderFlow(no, 'oversight', view));
  assert.doesNotMatch(renderFlow(yes, 'oversight', view), /SECRET_|复核覆盖|本任务不复核/);
  const secret = { ...initial, get verify() { throw new Error('private decision accessed'); } };
  assert.doesNotThrow(() => renderFlow(secret, 'oversight', view));
  const published = similarJob({ verify: false, verifiers: [], events: initial.events.concat([
    checkedEvent('ResultsCommitted'), checkedEvent('DecisionRevealed', { verify: false }), checkedEvent('ResultsPublished'),
  ]) });
  const html = renderFlow(published, 'oversight', view);
  assert.match(html, /data-flow-mode="provider-similar"/);
  assert.match(html, /监管检查，等待客户比较/);
  assert.equal(nodesFrom(html).find(node => node.step === 'oversight').state, 'current');
  assert.doesNotMatch(html, /data-step="shareB"|自动放行/);
  assert.ok(nodesFrom(html).some(node => node.step === 'dispute'), 'unverified files can still be disputed');
});

test('similar review deadlines require an actual expire transaction and rejected disputes do not punish the provider', () => {
  const job = similarJob({ deadlinePassed: true });
  assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'settle').state, 'pending');
  assert.match(renderFlow(job, 'acceptResults'), /仍须有人调用 expire/);
  job.events.push(checkedEvent('Payout', {}, '0xexpire'), checkedEvent('JobClosed', { outcome: 'Verified' }, '0xexpire'));
  Object.assign(job, { phase: 'Closed', closed: true, outcome: 'Verified', closeMethod: 'expire' });
  assert.match(renderFlow(job, 'acceptResults'), /到期接收/);
  assert.deepEqual(proofNames(renderFlow(job, 'acceptResults')), ['Payout', 'JobClosed']);

  const unfounded = similarJob({ phase: 'Closed', closed: true, outcome: 'DisputeRejected', disputedItems: [0] });
  unfounded.events.push(checkedEvent('ResultsDisputed', { items: [0] }), checkedEvent('TiebreakStarted'), checkedEvent('TiebreakShared'), checkedEvent('JudgementSubmitted', { verdicts: [3] }), checkedEvent('JobClosed', { outcome: 'DisputeRejected' }));
  assert.match(renderFlow(unfounded, 'oversight', { role: 'provider' }), /监管检查，通过/);
  assert.match(renderFlow(unfounded, 'tie'), /DisputeRejected/);
  assert.match(renderFlow(unfounded, 'settle'), /客户保证金支付裁决费用/);
});

test('similar flow wires connect review, acceptance, dispute and judgement on desktop and stacked layouts', () => {
  const job = similarJob({ phase: 'Closed', closed: true, outcome: 'MainOutvoted', disputedItems: [0] });
  job.events.push(checkedEvent('ResultsDisputed', { items: [0] }), checkedEvent('TiebreakStarted'), checkedEvent('TiebreakShared'), checkedEvent('JudgementSubmitted', { verdicts: [2] }), checkedEvent('JobClosed', { outcome: 'MainOutvoted' }));
  const originalDocument = globalThis.document;
  const element = tagName => ({ tagName, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  globalThis.document = { createElementNS: (_namespace, tagName) => element(tagName) };
  try {
    for (const provider of [false, true]) for (const stacked of [false, true]) {
      const html = renderFlow(job, null, provider ? { role: 'provider' } : {});
      const nodes = [...html.matchAll(/class="flow-node" data-step="([^"]+)" data-state="([^"]+)" style="grid-row:(\d+);grid-column:(\d+)"/g)]
        .map(([, step, state, row, column]) => ({ step, state, row: Number(row), column: Number(column) }));
      const svg = element('svg');
      const board = {
        dataset: { flowMode: provider ? 'provider-similar' : 'similar', hasDispute: 'true' }, matches: () => true,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: stacked ? 220 : 640, height: stacked ? nodes.length * 100 : 600 }),
        querySelector: () => svg,
        querySelectorAll: () => nodes.map((node, index) => ({ dataset: node, getBoundingClientRect: () => ({
          left: stacked ? 10 : 10 + (node.column - 1) * 210,
          top: stacked ? 10 + index * 100 : 10 + (node.row - 1) * 86, width: 180, height: 64,
        }) })),
      };
      drawFlowWires(board);
      const paths = svg.children.filter(child => child.tagName === 'path');
      assert.equal(paths.length, provider ? 21 : 20);
      assert.equal(paths.filter(path => path.attributes.class === 'wire confirmed').length, provider ? 19 : 18, 'only the unused accept branch stays inactive');
      assert.ok(paths.every(path => !/NaN|undefined/.test(path.attributes.d)));
      assert.ok(paths.at(-1).attributes['marker-end']);
      assert.equal(paths.at(-1).attributes.class, 'wire confirmed', 'judgement reaches final settlement even in provider view');
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('real render adapter tasks project client review and each settlement outcome without changing exact or checked routes', () => {
  for (const [scenario, verify, outcome] of [
    ['verified', true, 'Verified'], ['unverified', false, 'Delivered'],
    ['main-cheat', true, 'MainOutvoted'], ['verifier-cheat', true, 'VerifierOutvoted'],
    ['dispute-rejected', true, 'DisputeRejected'], ['similar-missing', false, 'MainOutvoted'],
  ]) {
    const store = createDemoStore();
    const id = store.createJob({ taskType: 'blender-render-v1', scenario, verify, itemCount: 4 });
    let job = store.getState().jobs.find(entry => entry.id === id);
    let steps = 24;
    while (job.phase !== 'Disputing' && steps-- > 0) {
      store.advanceJob(id);
      job = store.getState().jobs.find(entry => entry.id === id);
    }
    assert.equal(job.phase, 'Disputing');
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'review').state, 'current');
    assert.equal(job.review.compared, false);
    assert.match(renderFlow(job, 'review'), /当前尚未执行真实的文件相似度比较/);
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'settle').state, 'pending');
    assert.equal(nodesFrom(renderFlow(job, null, { role: 'provider' })).find(node => node.step === 'oversight').state, 'current');
    while (!job.closed && steps-- > 0) {
      store.advanceJob(id);
      job = store.getState().jobs.find(entry => entry.id === id);
    }
    assert.equal(job.outcome, outcome);
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'settle').state, 'done');
    assert.match(renderFlow(job, 'review'), /完成状态确认验收决定，不单独证明执行过相似度计算/);
    const disputed = job.events.some(entry => entry.name === 'ResultsDisputed');
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'acceptResults').state, disputed ? 'skipped' : 'done');
    assert.deepEqual(proofNames(renderFlow(job, disputed ? 'tie' : 'acceptResults')), disputed
      ? ['JudgementSubmitted'] : job.events.filter(entry => entry.name === 'Payout' || entry.name === 'JobClosed').map(entry => entry.name));
  }
  const store = createDemoStore();
  const imageId = store.createJob({ taskType: 'image-classify-v1' });
  const checkedId = store.createJob({ taskType: 'key-search-v1' });
  assert.match(renderFlow(store.getState().jobs.find(entry => entry.id === imageId)), /data-flow-mode="verified"/);
  assert.match(renderFlow(store.getState().jobs.find(entry => entry.id === checkedId)), /data-flow-mode="checked"/);
});

test('real similar tie deadlines show expire and never manufacture judgement or tiebreak payment', () => {
  for (const shared of [false, true]) {
    const store = createDemoStore();
    const id = store.createJob({ taskType: 'blender-render-v1', scenario: 'main-cheat', itemCount: 4 });
    let job = store.getState().jobs.find(entry => entry.id === id);
    let attempts = 24;
    while (job.phase !== 'TieBreak' && attempts-- > 0) {
      store.advanceJob(id);
      job = store.getState().jobs.find(entry => entry.id === id);
    }
    assert.equal(job.phase, 'TieBreak');
    if (shared) store.advanceJob(id);
    store.passDeadline(id);
    job = store.getState().jobs.find(entry => entry.id === id);
    const expired = nodesFrom(renderFlow(job));
    assert.equal(expired.find(node => node.step === 'expire').state, 'current');
    assert.equal(expired.find(node => node.step === 'settle').state, 'pending');
    assert.equal(expired.find(node => node.step === 'tieShare').state, shared ? 'done' : 'pending');
    assert.equal(expired.find(node => node.step === 'tie').state, 'pending');
    assert.deepEqual(proofNames(renderFlow(job, 'expire')), []);
    store.expireJob(id);
    job = store.getState().jobs.find(entry => entry.id === id);
    assert.equal(job.outcome, shared ? 'TiebreakerMissed' : 'TieClientNoShare');
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'expire').state, 'done');
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'settle').state, 'done');
    assert.equal(nodesFrom(renderFlow(job)).find(node => node.step === 'tie').state, 'skipped');
    assert.deepEqual(proofNames(renderFlow(job, 'tie')), []);
    assert.ok(proofNames(renderFlow(job, 'expire')).includes('JobClosed'));
    assert.equal(job.settlement.tiebreak, '0.000');
    assert.match(renderFlow(job, 'oversight', { role: 'provider' }), /监管检查，未能确认/);
  }
});
