import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewJob, publicJobReference, rentalJobsForAccount } from '../src/access.js';

const account = { id: 'user-1', address: '0xClient' };
const providers = [{ id: 'A', address: '0xAA' }, { id: 'B', address: '0xBB' }, { id: 'C', address: '0xCC' }];
const context = (role, providerId = 'A', overrides = {}) => ({ account, role, providerId, providers, ...overrides });
const job = { id: 'replicated:1', mode: 'replicated', clientId: 'user-1', clientAddress: '0xClient', provider: 'A', verifiers: ['B'], tieProvider: 'C' };

test('job details require a logged-in identity and a supported current role', () => {
  assert.equal(canViewJob(job), false);
  assert.equal(canViewJob(job, context('client', 'A', { account: null })), false);
  assert.equal(canViewJob(job, context('client', 'A', { account: {} })), false);
  assert.equal(canViewJob(job, context('admin')), false);
  assert.equal(canViewJob(null, context('client')), false);
});

test('client view matches the current account id or address and cannot borrow a provider selection', () => {
  assert.equal(canViewJob(job, context('client')), true);
  assert.equal(canViewJob({ ...job, clientId: 'renamed', clientAddress: '0xCLIENT' }, context('client')), true);
  assert.equal(canViewJob({ ...job, clientId: 'other', clientAddress: '0xOther' }, context('client')), false);
  assert.equal(canViewJob({ ...job, clientId: undefined, clientAddress: undefined }, context('client', 'A', { account: { id: 'other' } })), false);
});

test('provider view matches only the selected formal participant, independent of the account client role', () => {
  for (const id of ['A', 'B', 'C']) assert.equal(canViewJob(job, context('provider', id)), true);
  assert.equal(canViewJob(job, context('provider', 'D')), false, 'owning the client account does not grant a different provider view');
  assert.equal(canViewJob(job, context('provider', null)), false);
  assert.equal(canViewJob({ ...job, provider: '0xaa', verifiers: ['0xbB'], tieProvider: '0xcc' }, context('provider', 'B')), true);
  assert.equal(canViewJob({ ...job, provider: undefined, main: '0xAa' }, context('provider', 'A')), true);
});

test('successful assignment event addresses override stale aliases for main, verifier, tie, and client', () => {
  const events = [
    { name: 'JobCreated', args: { main: '0xBB', client: '0xOther' } },
    { name: 'VerifiersDrawn', args: { verifiers: ['0xCC'] } },
    { name: 'TiebreakStarted', args: { tiebreaker: '0xBB' } },
  ];
  const changed = { ...job, clientId: 'other', events };
  assert.equal(canViewJob(changed, context('provider', 'A')), false);
  assert.equal(canViewJob(changed, context('provider', 'B')), true);
  assert.equal(canViewJob(changed, context('provider', 'C')), true);
  assert.equal(canViewJob(changed, context('client')), false);
  assert.equal(canViewJob({ ...changed, events: [{ name: 'JobCreated', args: { main: '0xAA' } }, { name: 'VerifiersDrawn', args: { verifiers: [] } }, { name: 'TiebreakStarted', args: { tiebreaker: '0xCC' } }] }, context('provider', 'B')), false, 'empty public assignments do not fall back to stale alias lists');
  const renamed = [{ id: 'renamed-B', address: '0xBB' }];
  assert.equal(canViewJob(changed, context('provider', 'renamed-B', { providers: renamed })), true);
});

test('checked tasks never grant access through stale verifier or arbitrator fields', () => {
  const checked = { ...job, mode: 'checked', events: [{ name: 'VerifiersDrawn', args: { verifiers: ['0xBB'] } }] };
  assert.equal(canViewJob(checked, context('provider', 'A')), true);
  assert.equal(canViewJob(checked, context('provider', 'B')), false);
  assert.equal(canViewJob(checked, context('provider', 'C')), false);
});

test('private verification choices and unassigned candidates cannot grant access', () => {
  const source = { ...job, provider: 'B', verifiers: [], tieProvider: null, candidate: 'A', candidates: ['A'] };
  Object.defineProperty(source, 'verify', { get() { throw new Error('private choice was read'); } });
  assert.equal(canViewJob(source, context('provider', 'A')), false);
  assert.equal(canViewJob(source, context('provider', 'B')), true);
  assert.equal(canViewJob({ ...job, events: [{ name: 'JobCreated', confirmed: false, args: { main: '0xCC' } }] }, context('provider', 'A')), true);
});

test('public job references contain only the immutable namespaced id', () => {
  const source = { ...job, inputs: ['private'], verify: true, status: 'private state', results: ['secret'], taskType: 'private-type' };
  const reference = publicJobReference(source);
  assert.deepEqual(reference, { id: 'replicated:1' });
  assert.ok(Object.isFrozen(reference));
  assert.deepEqual(publicJobReference({ ...source, id: 'checked:1' }), { id: 'checked:1' });
  assert.deepEqual(publicJobReference(undefined), { id: null });
  assert.equal(source.verify, true);
});

test('rental task selection follows the posting account and cannot include a machine customer by provider assignment', () => {
  const own = { ...job, id: 'replicated:own', closed: false };
  const settled = { ...job, id: 'replicated:settled', closed: true };
  const addressOnly = { ...job, id: 'checked:own', clientId: 'renamed', clientAddress: '0xCLIENT', closed: false };
  const otherCustomer = { ...job, id: 'replicated:customer', clientId: 'other', clientAddress: '0xOther', provider: 'A' };
  const source = [own, settled, addressOnly, otherCustomer];
  assert.deepEqual(rentalJobsForAccount(source, account).map(entry => entry.id), ['replicated:own', 'replicated:settled', 'checked:own']);
  assert.deepEqual(rentalJobsForAccount(source, account, { activeOnly: true }).map(entry => entry.id), ['replicated:own', 'checked:own']);
  assert.deepEqual(rentalJobsForAccount(source, null), []);
  assert.deepEqual(rentalJobsForAccount(null, account), []);
  assert.equal(source.length, 4);
});
