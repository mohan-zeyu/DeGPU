import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarketPage } from '../src/market-view.js';
import { renderResultTable } from '../src/result-details.js';
import { providerIncome } from '../src/parity-view.js';

test('provider earnings exclude refunds received while acting as a client', () => {
  const events = [{ name: 'Payout', args: { to: '0xAA', amount: '100000000000000' } }];
  assert.equal(providerIncome([{ role: 'client', clientAddress: '0xAA', events },
    { role: 'verifier', clientAddress: '0xBB', events }], '0xaa'), '0.0001');
  assert.equal(providerIncome([{ role: 'client', events }], '0xaa'), '0.000');
});

test('live market uses API task catalog including additional plugins', () => {
  const task = { id: 'extension-v1', name: '扩展任务', mode: 'checked', available: true, defaultPrice: '0.1', runs_here: true };
  const state = { network: { mode: 'live' }, account: { address: 'client' }, jobs: [], taskTypes: [task],
    providers: [{ id: 'provider', address: 'provider', registered: true, active: true, concurrentJobs: true,
      lockedJobs: 3, stake: '1', offers: { 'extension-v1': '0.1' }, record: {} }] };
  const html = renderMarketPage(state, { taskType: task.id });
  assert.match(html, /扩展任务/);
  assert.match(html, /0\.10000000/);
  assert.match(html, /provider=provider&amp;type=extension-v1/);
  assert.doesNotMatch(html, /option value="image-classify-v1"/);
});

test('generic plugin values and files remain readable', () => {
  const html = renderResultTable({ taskType: 'extension-v1', mode: 'replicated', resultKind: 'value', closed: true }, [{ index: 0, value: '<answer>' }]);
  assert.match(html, /&lt;answer&gt;/);
  assert.doesNotMatch(html, /未知类别/);
  const file = renderResultTable({ taskType: 'extension-v1', resultKind: 'file', closed: true }, [{ index: 0, filename: 'out.bin', downloadUrl: '/api/jobs/replicated:1/results/0' }]);
  assert.match(file, /download="out.bin"/);
});
