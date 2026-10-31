import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { jobsForProvider, nextActor, providerLedger, providerRole } from '../src/roles.js';

test('provider roles come only from actual assignments', () => {
  const job = { provider: 'A', verifiers: ['B', 'C'], tieProvider: 'D', tiebreaker: 'E' };
  assert.equal(providerRole(job, 'A'), '提供方');
  assert.equal(providerRole(job, 'B'), '复核方');
  assert.equal(providerRole(job, 'C'), '复核方');
  assert.equal(providerRole(job, 'D'), '裁决方');
  assert.equal(providerRole(job, 'E'), null);
  assert.equal(providerRole(job, 'F'), null);
  assert.equal(providerRole(job, null), null);
  assert.deepEqual(jobsForProvider([job, { provider: 'F' }], 'B'), [job]);
});

test('actor projection matches the actual next sender throughout normal and disputed jobs', () => {
  for (const scenario of ['verified', 'unverified', 'main-cheat', 'verifier-cheat']) {
    const store = createDemoStore();
    const id = store.createJob({ scenario, provider: 'E' });
    let iterations = 0;
    while (iterations++ < 20) {
      const before = store.getState();
      const job = before.jobs.find((item) => item.id === id);
      if (job.closed) {
        assert.equal(nextActor(job), null);
        break;
      }
      const actor = nextActor(job);
      assert.ok(actor, `${scenario}: ${job.phase} has an actor`);
      const address = actor === 'client' ? before.account.address : before.providers.find((provider) => provider.id === actor).address;
      store.advanceJob(id);
      assert.equal(store.getState().transactions.at(-1).from, address, `${scenario}: ${job.phase} sender`);
    }
    assert.ok(iterations < 20, `${scenario} must settle`);
  }
});

test('sharing takes precedence over committing and each reveal selects the next committed verifier', () => {
  const base = { phase: 'Checking', verifiers: ['B', 'C'] };
  assert.equal(nextActor({ ...base, verifierStates: ['Shared', 'Assigned'] }), 'client');
  assert.equal(nextActor({ ...base, verifierStates: ['Shared', 'Shared'] }), 'B');
  assert.equal(nextActor({ ...base, verifierStates: ['Committed', 'Shared'] }), 'C');
  assert.equal(nextActor({ ...base, phase: 'CheckReveal', verifierStates: ['Committed', 'Committed'] }), 'B');
  assert.equal(nextActor({ ...base, phase: 'CheckReveal', verifierStates: ['Revealed', 'Committed'] }), 'C');
  assert.equal(nextActor({ ...base, verifierStates: [] }), null);
});

test('similarity review and disputes belong to the client before the assigned judge submits', () => {
  const job = { taskType: 'blender-render-v1', mode: 'replicated', phase: 'Disputing', provider: 'A' };
  assert.equal(nextActor(job), 'client');
  assert.equal(nextActor({ ...job, phase: 'TieBreak', tieProvider: 'D', tieShared: false }), 'client');
  assert.equal(nextActor({ ...job, phase: 'TieBreak', tieProvider: 'D', tieShared: true }), 'D');
  assert.equal(nextActor({ ...job, nextAction: 'wait' }), null);
  assert.equal(nextActor({ ...job, closed: true }), null);
});

test('offline waiting and unsupported timeouts have no actor; expire is a client action in the demo', () => {
  const store = createDemoStore();
  const id = store.createJob({ scenario: 'main-offline' });
  store.advanceJob(id);
  assert.equal(nextActor(store.getState().jobs.find((job) => job.id === id)), null);
  store.passDeadline(id);
  assert.equal(nextActor(store.getState().jobs.find((job) => job.id === id)), 'client');
  assert.equal(nextActor({ phase: 'Publishing', provider: 'A', nextAction: 'unsupported-timeout', deadlinePassed: true }), null);
  assert.equal(nextActor({ phase: 'Unknown', provider: 'A' }), null);
});

test('provider ledger uses matching payout and slash logs rather than settlement totals', () => {
  const provider = { id: 'B', address: '0xBb' };
  const closed = {
    id: '001', closed: true, provider: 'A', verifiers: ['B', 'C'],
    settlement: { slashed: '999', main: '999', verifierB: '999' },
    events: [
      { name: 'Payout', args: { to: '0xbB', amount: '10000000000000000', amountEth: '999' } },
      { name: 'Payout', args: { to: '0xBb', amount: '2000000000000000' } },
      { name: 'Payout', args: { to: '0xCc', amount: '900000000000000000' } },
      { name: 'ProviderSlashed', args: { provider: '0xBB', amount: '300000000000000000' } },
      { name: 'ProviderSlashed', args: { provider: '0xCc', amount: '600000000000000000' } },
    ],
  };
  const active = { ...closed, id: '002', closed: false };
  const unrelated = { ...closed, id: '003', verifiers: ['C', 'D'] };
  const ledger = providerLedger([closed, active, unrelated], provider);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].job, closed);
  assert.equal(ledger[0].role, '复核方');
  assert.equal(ledger[0].income, 0.012);
  assert.equal(ledger[0].slashed, 0.3);
  assert.ok(Math.abs(ledger[0].net + 0.288) < 1e-12);
});

test('real demo provider ledger sums agree with credited earnings after arbitration', () => {
  const store = createDemoStore();
  const id = store.createJob({ scenario: 'main-cheat' });
  while (!store.getState().jobs.find((job) => job.id === id).closed) store.advanceJob(id);
  const state = store.getState();
  for (const provider of state.providers) {
    const ledger = providerLedger(state.jobs, provider);
    const income = ledger.reduce((total, row) => total + row.income, 0);
    assert.ok(Math.abs(income - Number(provider.earned)) < 1e-12, `${provider.id} income`);
    const newRow = ledger.find((row) => row.job.id === id);
    if (provider.id === 'A') assert.equal(newRow.slashed, 0.3);
    else if (newRow) assert.equal(newRow.slashed, 0);
  }
});

test('checked jobs have one provider role and one answer sender, with client-triggered expiration', () => {
  const job = { id: 'checked:1', mode: 'checked', phase: 'Open', provider: 'A', verifiers: ['B'], tieProvider: 'C' };
  assert.equal(providerRole(job, 'A'), '提供方');
  assert.equal(providerRole(job, 'B'), null, 'legacy verifier fields cannot create checked assignments');
  assert.equal(providerRole(job, 'C'), null);
  assert.equal(nextActor(job), 'A');
  assert.equal(nextActor({ ...job, phase: 'Working' }), 'A');
  assert.equal(nextActor({ ...job, phase: 'Working', nextAction: 'wait' }), null);
  assert.equal(nextActor({ ...job, phase: 'Working', nextAction: 'expire' }), 'client');
  assert.equal(nextActor({ ...job, phase: 'Working', deadlinePassed: true }), 'client');
  assert.equal(nextActor({ ...job, phase: 'Open', deadlinePassed: true }), 'client');
  assert.equal(nextActor({ ...job, phase: 'Closed' }), null);
  assert.equal(nextActor({ ...job, phase: 'Working', closed: true }), null);
  assert.equal(nextActor({ ...job, phase: 'Deciding' }), null, 'checked mode cannot enter replicated decision states');
});

test('namespaced market job IDs remain distinct in assignments and payout ledgers', () => {
  const provider = { id: 'A', address: '0xaa' };
  const jobs = [
    { id: 'replicated:1', mode: 'replicated', provider: 'B', verifiers: ['A'], closed: true, events: [{ name: 'Payout', args: { to: provider.address, amount: '2000000000000000' } }] },
    { id: 'checked:1', mode: 'checked', provider: 'A', closed: true, events: [{ name: 'Payout', args: { to: provider.address, amount: '1000000000000000' } }] },
  ];
  const ledger = providerLedger(jobs, provider);
  assert.deepEqual(ledger.map(row => [row.job.id, row.role, row.income]), [['replicated:1', '复核方', 0.002], ['checked:1', '提供方', 0.001]]);
});

test('private preselection cannot give regulators a task before the public decision and draw', () => {
  for (const phase of ['Open', 'Committing', 'Deciding']) {
    const job = { mode: 'replicated', phase, provider: 'A', verifiers: ['B', 'C'], tieProvider: 'D' };
    assert.equal(providerRole(job, 'A'), '提供方');
    assert.equal(providerRole(job, 'B'), null);
    assert.equal(providerRole(job, 'D'), null);
    assert.deepEqual(jobsForProvider([job], 'B'), []);
  }
});
