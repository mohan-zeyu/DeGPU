import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePublish, renderPublishPage } from '../src/publish-view.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const makeState = ({ balance = '2', quote = '0.0001', codeMatches = true, active = true } = {}) => ({
  account: { id: ADDRESS, address: ADDRESS, balance },
  taskTypes: [{ id: 'image-classify-v1', code_matches: codeMatches }, { id: 'key-search-v1' }],
  providers: [{ id: OTHER, address: OTHER, ownerId: OTHER, registered: true, active, listed: true, lockedJobs: 0,
    offers: { 'image-classify-v1': quote, 'blender-render-v1': quote, 'key-search-v1': quote } }],
});
const render = (state, type = 'image-classify-v1') => renderPublishPage(state, new URLSearchParams({ type }), {
  live: true, account: state.account, mine: provider => provider.ownerId === state.account.id,
});
const hasDisabledSubmit = html => /<button\b(?=[^>]*type="submit")(?=[^>]*\bdisabled)[^>]*>/.test(html);

test('checked deposit includes solvable keys plus every extra impossible challenge', () => {
  const estimate = estimatePublish('key-search-v1', { count: 3, impossible: 5, quote: '0.0001', balance: '0.0008' });
  assert.deepEqual(estimate, { valid: true, total: 8, deposit: '0.0008', sufficient: true });
  assert.equal(estimatePublish('key-search-v1', { count: 0, impossible: 5, quote: '0.0001', balance: '1' }).total, 5);
  assert.equal(estimatePublish('key-search-v1', { count: '3', impossible: '5', quote: '0.0001', balance: '1' }).deposit, '0.0008');
});

test('replicated tasks prepay both computing and checking regardless of impossible input', () => {
  for (const taskType of ['image-classify-v1', 'blender-render-v1']) {
    const estimate = estimatePublish(taskType, { count: 3, impossible: 5, quote: '0.0001', balance: '1' });
    assert.equal(estimate.total, 3);
    assert.equal(estimate.deposit, '0.0006');
    assert.equal(estimate.sufficient, true);
  }
});

test('estimate keeps every wei and uses exact balance comparisons', () => {
  const exact = estimatePublish('key-search-v1', { count: 3, impossible: 5, quote: '0.000000000000000001', balance: '0.000000000000000008' });
  assert.equal(exact.deposit, '0.000000000000000008');
  assert.equal(exact.sufficient, true);
  const oneWeiShort = estimatePublish('key-search-v1', { count: 3, impossible: 5, quote: '0.000000000000000001', balance: '0.000000000000000007' });
  assert.equal(oneWeiShort.sufficient, false);
  const large = estimatePublish('key-search-v1', { count: 1, quote: '1000000000000000000.000000000000000001', balance: '1000000000000000000' });
  assert.equal(large.deposit, '1000000000000000000.000000000000000001');
  assert.equal(large.sufficient, false);
});

test('bad totals and invalid component counts are refused before a deposit is displayed', () => {
  for (const options of [
    { count: 0, impossible: 0 }, { count: 1000, impossible: 1 }, { count: NaN, impossible: 1 },
    { count: 0.5, impossible: 0 }, { count: -1, impossible: 2 }, { count: 2, impossible: -1 },
    { count: 0.5, impossible: 0.5 }, { count: Number.MAX_SAFE_INTEGER + 1, impossible: 0 },
  ]) {
    const estimate = estimatePublish('key-search-v1', { ...options, quote: '0.0001', balance: '1' });
    assert.equal(estimate.valid, false, JSON.stringify(options));
    assert.equal(estimate.deposit, null);
    assert.equal(estimate.sufficient, false);
  }
  assert.equal(estimatePublish('key-search-v1', { count: 999, impossible: 1, quote: '0.0001', balance: '1' }).valid, true);
});

test('malformed prices and balances never produce an affordable-looking estimate', () => {
  for (const bad of ['-1', '1e-4', '0.0000000000000000001', 'NaN', '']) {
    assert.equal(estimatePublish('key-search-v1', { count: 1, quote: bad, balance: '1' }).valid, false);
    assert.equal(estimatePublish('key-search-v1', { count: 1, quote: '0.0001', balance: bad }).sufficient, false);
  }
});

test('publish view disables code mismatch and low balance while preserving exact amounts', () => {
  const mismatched = render(makeState({ codeMatches: false }));
  assert.equal(hasDisabledSubmit(mismatched), true);
  assert.match(mismatched, /任务代码与网络版本不一致/);
  const lowBalance = render(makeState({ balance: '0.000199999999999999' }));
  assert.equal(hasDisabledSubmit(lowBalance), true);
  assert.match(lowBalance, /余额不足以支付预存/);
  assert.match(lowBalance, /title="余额 0\.000199999999999999 ETH"/);
  assert.match(lowBalance, />余额 0\.00019999 ETH<\/span>/);
  assert.match(lowBalance, /id="image-files"[^>]*accept="\.jpg"/);
  assert.match(lowBalance, /预存 0\.0002 ETH/);
  const enough = render(makeState({ balance: '0.0002' }));
  assert.equal(hasDisabledSubmit(enough), false);
});

test('publish view excludes own or inactive machines and clearly disables an empty market', () => {
  const inactive = render(makeState({ active: false }));
  assert.equal(hasDisabledSubmit(inactive), true);
  assert.match(inactive, /当前没有提供此任务的可用机器/);
  const own = makeState();
  own.providers[0].ownerId = ADDRESS;
  assert.equal(hasDisabledSubmit(render(own)), true);
});

test('provider quote sorting and output preserve differences of one wei', () => {
  const state = makeState({ quote: '1.000000000000000002', balance: '3' });
  state.providers.push({ ...state.providers[0], id: 'cheaper', address: 'cheaper', offers: { ...state.providers[0].offers, 'image-classify-v1': '1.000000000000000001' } });
  const html = render(state);
  assert.ok(html.indexOf('value="cheaper" selected') < html.indexOf(`value="${OTHER}"`));
  assert.match(html, /预存 2\.000000000000000002 ETH/);
  assert.match(html, /1\.000000000000000001 ETH/);
});
