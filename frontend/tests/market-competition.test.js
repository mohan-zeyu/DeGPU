import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { getProviderMarketPoints } from '../src/provider-stats.js';
import { getMarketCompetitionSnapshot, MARKET_COMPETITION_ROUNDS } from '../src/market.js';
import { renderMarketScatter, getMarketPointGroup } from '../src/market-scatter.js';
import { NETWORK_PROVIDERS } from '../src/network-fixtures.js';

const IMAGE = 'image-classify-v1';
const KEY = 'key-search-v1';
const RENDER = 'blender-render-v1';
const simpleProvider = (id, quote) => ({ id, registered: true, active: true, offers: { [IMAGE]: quote } });
const openingMarket = () => {
  const state = createDemoStore({ profile: 'network' }).getState();
  const eth = amount => `0.${amount.toString().padStart(18, '0').replace(/0+$/, '')}`;
  for (const [index, provider] of state.providers.entries()) {
    const price = NETWORK_PROVIDERS[index].pricePerItem;
    const amount = BigInt(price.split('.')[1].padEnd(18, '0'));
    provider.pricePerItem = price;
    provider.offers = { [IMAGE]: price,
      [KEY]: index % 7 === 5 ? '0' : eth(amount * BigInt(100 + index % 5 * 13) / 100n),
      [RENDER]: index % 6 === 4 ? '0' : eth(amount * BigInt(120 + index % 4 * 17) / 100n) };
  }
  return state;
};

test('service competition moves a wide network spread into a small nonzero price band over observable rounds', () => {
  const state = openingMarket();
  const before = structuredClone(state);
  for (const type of [IMAGE, KEY, RENDER]) {
    const rounds = Array.from({ length: MARKET_COMPETITION_ROUNDS + 1 }, (_, round) => getMarketCompetitionSnapshot(state, type, round));
    assert.equal(rounds[0].phase, 'initial');
    assert.equal(rounds[1].phase, 'competing');
    assert.equal(rounds.at(-1).phase, 'stable');
    assert.equal(rounds.at(-1).progress, 1);
    assert.deepEqual(rounds[0].points.map(({ originalQuote, ...point }) => point), getProviderMarketPoints(state, type, { includeUnavailable: true }));
    assert.ok(rounds[0].dispersionPercent > 100);
    assert.ok(rounds.at(-1).dispersionPercent > 0 && rounds.at(-1).dispersionPercent < 8);
    assert.ok(new Set(rounds.at(-1).points.map(point => point.quote)).size > 1, 'cost and reliability differences survive competition');
    for (let index = 1; index < rounds.length; index += 1) {
      assert.ok(rounds[index].dispersionPercent <= rounds[index - 1].dispersionPercent, `${type} round ${index} narrows the spread`);
      assert.deepEqual(rounds[index].priceDomain, rounds[0].priceDomain);
      assert.deepEqual(rounds[index].points.map(({ quote, originalQuote, ...point }) => point), rounds[0].points.map(({ quote, originalQuote, ...point }) => point), 'price changes do not invent completion or failure history');
    }
  }
  assert.deepEqual(state, before, 'the process never changes executable registry offers or saved task prices');
});

test('competition is service-specific and projected samples are detached immutable values', () => {
  const state = openingMarket();
  const nonce = getMarketCompetitionSnapshot(state, KEY, 6);
  const changed = structuredClone(state);
  changed.providers[0].offers[IMAGE] = '9';
  assert.deepEqual(getMarketCompetitionSnapshot(changed, KEY, 6), nonce);
  assert.notEqual(getMarketCompetitionSnapshot(state, IMAGE, 6).averageQuote, nonce.averageQuote);
  assert.ok(Object.isFrozen(nonce) && Object.isFrozen(nonce.points) && Object.isFrozen(nonce.points[0]) && Object.isFrozen(nonce.priceDomain));
  changed.providers[0].offers[KEY] = '1';
  assert.notEqual(getMarketCompetitionSnapshot(changed, KEY, 6).points[0].quote, nonce.points[0].quote);
  assert.equal(nonce.points[0].originalQuote, state.providers[0].offers[KEY]);
});

test('empty, uniform, tiny-price and invalid-round inputs remain finite without fabricating price movement', () => {
  const empty = getMarketCompetitionSnapshot({}, 'blender-render-v1', 99);
  assert.equal(empty.round, MARKET_COMPETITION_ROUNDS);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.averageQuote, null);
  assert.equal(empty.dispersionPercent, null);
  const uniform = { providers: [simpleProvider('A', '0.0001'), simpleProvider('B', '0.0001')], jobs: [] };
  const final = getMarketCompetitionSnapshot(uniform, IMAGE, 12);
  assert.deepEqual(final.points.map(point => point.quote), ['0.0001', '0.0001']);
  assert.equal(final.dispersionPercent, 0);
  const tiny = getMarketCompetitionSnapshot({ providers: [simpleProvider('A', '0.000000000000000001'), simpleProvider('B', '0.000000000000000002')] }, IMAGE, 6);
  assert.ok(tiny.points.every(point => /^0\.00000000000000000[12]$/.test(point.quote)));
  assert.ok(Number.isFinite(tiny.dispersionPercent));
  assert.equal(getMarketCompetitionSnapshot(uniform, IMAGE, NaN).round, 0);
  assert.equal(getMarketCompetitionSnapshot(uniform, IMAGE, -2).round, 0);
  assert.equal(getMarketCompetitionSnapshot(uniform, IMAGE, 2.9).round, 2);
});

test('frozen price axes visibly narrow the band while peer selection uses the same projection', () => {
  const points = [{ id: 'A', quote: '0.000099', completed: 10 }, { id: 'B', quote: '0.000101', completed: 10 }];
  const options = { priceDomain: { minQuote: '0.00005', maxQuote: '0.0002' } };
  const projected = getMarketPointGroup(points, 'A', options);
  assert.equal(projected.length, 2, 'narrowed prices become nearby without artificial jitter');
  assert.ok(Math.abs(projected[0].y - projected[1].y) < 4);
  assert.equal(getMarketPointGroup(points, 'A').length, 2, 'the normal zero baseline also keeps a close price band visually close');
  const html = renderMarketScatter(points, options);
  assert.match(html, /data-value="0\.00005"/);
  assert.match(html, /data-value="0\.0002"/);
  assert.match(html, /data-nearby-count="2"/);
  const crossed = renderMarketScatter([{ ...points[0], quote: points[1].quote }, { ...points[1], quote: points[0].quote }], options);
  assert.ok(crossed.indexOf('data-node-id="A"') < crossed.indexOf('data-node-id="B"'), 'animated groups retain stable machine order when prices cross');
  assert.doesNotMatch(renderMarketScatter(points, { priceDomain: { minQuote: 'bad', maxQuote: '-1' } }), /NaN|Infinity/);
});
