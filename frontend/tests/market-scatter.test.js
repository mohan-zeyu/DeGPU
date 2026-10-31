import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarketScatter, getMarketPointGroup, getMarketMetrics, normalizeMarketMetric, formatPrice } from '../src/market-scatter.js';

const point = (id, quote, completed) => ({ id, quote, completed });
const plottedGroups = (html) => [...html.matchAll(/<a class="market-scatter-point[^"]*"[^>]*data-quote="([^"]+)" data-completed="(\d+)" data-node-count="(\d+)" data-relative-price="([^"]*)" data-relative-completed="([^"]*)"[^>]*>[\s\S]*?<circle class="market-scatter-dot" cx="([^"]+)" cy="([^"]+)"/g)]
  .map((match) => ({ quote: match[1], completed: Number(match[2]), count: Number(match[3]), relativePrice: match[4] === '' ? null : Number(match[4]), relativeCompleted: Number(match[5]), x: Number(match[6]), y: Number(match[7]) }));
const byGeometry = groups => [...groups].sort((left, right) => left.x - right.x || left.y - right.y
  || left.quote.localeCompare(right.quote) || left.completed - right.completed || left.count - right.count);

test('equal registry coordinates remain grouped, with every machine reachable through side-card peers', () => {
  const points = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => point(id, '0.0001', id === 'A' ? 2 : 0));
  const html = renderMarketScatter(points);
  const groups = plottedGroups(html);
  assert.deepEqual(groups.map(({ quote, completed, count }) => ({ quote, completed, count })), [
    { quote: '0.0001', completed: 2, count: 1 },
    { quote: '0.0001', completed: 0, count: 5 },
  ]);
  assert.equal(groups[0].y, groups[1].y, 'equal quotes must share y; never jitter to imply different prices');
  assert.ok(groups[0].x > groups[1].x);
  assert.deepEqual(groups.map(({ relativePrice, relativeCompleted }) => [relativePrice, relativeCompleted]), [[100, 100], [100, 0]]);
  assert.deepEqual(getMarketPointGroup(points, 'B').map(({ id }) => id), ['B', 'C', 'D', 'E', 'F']);
  assert.doesNotMatch(html, /<select|<option|market-node-select|market-scatter-selector/);
  assert.match(html, /5 台机器同坐标/);
  assert.match(html, /成功完成 \/ 最高次数/);
  assert.match(html, /报价 · ETH \/ 张/);
  assert.doesNotMatch(html, /market-scatter-reference|market-scatter-grid/);
  assert.match(html, /class="market-scatter-tick" data-axis="x" data-value="100%"/);
  assert.doesNotMatch(html, /market-scatter-group|figcaption/);
});

test('relative quote uses all eligible nodes including duplicates and completion uses maximum history', () => {
  const html = renderMarketScatter([
    point('A', '0.0001', 3), point('B', '0.000100', 3),
    point('C', '0.0001', 0), point('D', '0.0002', 6),
  ]);
  const groups = plottedGroups(html);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].y, groups[1].y);
  assert.ok(groups[2].x > groups[0].x);
  assert.ok(groups[2].y < groups[0].y);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), 4);
  assert.deepEqual(groups.map(({ relativePrice, relativeCompleted }) => [relativePrice, relativeCompleted]), [[80, 50], [80, 0], [160, 100]]);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('scaling every quote or completion preserves the relative chart geometry', () => {
  const a = plottedGroups(renderMarketScatter([point('A', '0.001', 10), point('B', '0.002', 40)]));
  const b = plottedGroups(renderMarketScatter([point('A', '0.01', 20), point('B', '0.02', 80)]));
  assert.deepEqual(a.map(({ x, y, relativePrice, relativeCompleted }) => [x, y, relativePrice, relativeCompleted]),
    b.map(({ x, y, relativePrice, relativeCompleted }) => [x, y, relativePrice, relativeCompleted]));
});

test('a single node and genuine zero values get finite relative axes without fabricated completed work', () => {
  const zero = renderMarketScatter([point('free', '0', 0)]);
  assert.deepEqual(plottedGroups(zero), [{ quote: '0', completed: 0, count: 1, relativePrice: null, relativeCompleted: 0, x: 126, y: 246 }]);
  assert.doesNotMatch(zero, /market-scatter-reference/);
  assert.match(zero, /href="#\/providers\?node=free&amp;metric=completed"/);
  const one = plottedGroups(renderMarketScatter([point('A', '0.0001', 7)]));
  assert.equal(one.length, 1);
  assert.equal(one[0].completed, 7);
  assert.equal(one[0].relativePrice, 100);
  assert.equal(one[0].relativeCompleted, 100);
  assert.ok(Number.isFinite(one[0].x) && Number.isFinite(one[0].y));
  assert.doesNotMatch(zero, /NaN|Infinity/);
});

test('empty or invalid samples are unavailable rather than plotted as free zero-history nodes', () => {
  assert.equal(renderMarketScatter([]), '<div class="market-scatter-empty">暂无可比较机器</div>');
  assert.equal(renderMarketScatter(undefined), renderMarketScatter([]));
  const invalid = renderMarketScatter([
    null, point('A', 'unknown', 2), point('B', '-0.1', 2),
    point('C', '0.1', -1), point('D', '0.1', 0.5),
    point('E', '0.1', NaN), point('F', '0.1', Number.MAX_SAFE_INTEGER + 1),
  ]);
  assert.match(invalid, /暂无成功完成样本/);
  assert.doesNotMatch(invalid, /market-scatter-dot/);
});

test('machine labels and query paths escape hostile input', () => {
  const hostileId = 'A"/><script>alert(1)</script>&\' /?#中';
  const html = renderMarketScatter([
    point(hostileId, '0.0001', 0), point('bad', '"><img src=x onerror=alert(2)>', 3),
  ], { selectedId: hostileId, ownId: hostileId });
  assert.doesNotMatch(html, /<script|<img|onerror=|alert\(2\)/);
  assert.match(html, /A&quot;\/&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&#39;/);
  assert.ok(html.includes(`href="#/providers?node=${encodeURIComponent(hostileId).replaceAll("'", '&#39;')}&amp;metric=completed"`));
  assert.match(html, /class="market-scatter-point is-selected is-own"/);
  assert.match(html, /（我的机器）/);
  assert.doesNotThrow(() => renderMarketScatter([point('\uD800', '0', 0)]));
});

test('one-wei prices keep exact relative values and coordinates without floating-price rounding', () => {
  const groups = plottedGroups(renderMarketScatter([
    point('A', '0.000000000000000001', 0), point('B', '0.000000000000000002', 0),
  ]));
  assert.equal(groups.length, 2);
  assert.ok(groups[1].y < groups[0].y);
  assert.equal(groups[0].x, groups[1].x);
  assert.deepEqual(groups.map(({ quote, relativePrice }) => [quote, relativePrice]), [
    ['0.000000000000000001', 66.66], ['0.000000000000000002', 133.33],
  ]);
});

test('samples stay immutable, duplicate IDs do not inflate population, selected overlap links to the selected node', () => {
  const points = [point('A', '0.0001', 2), point('B', '0.0001', 2), point('A', '0.0002', 9)];
  const before = structuredClone(points);
  const html = renderMarketScatter(points, { selectedId: 'B' });
  assert.deepEqual(points, before);
  assert.deepEqual(plottedGroups(html).map(({ quote, completed, count }) => ({ quote, completed, count })), [
    { quote: '0.0001', completed: 2, count: 2 },
  ]);
  assert.deepEqual(getMarketPointGroup(points, 'B').map(({ id }) => id), ['A', 'B']);
  assert.match(html, /class="market-scatter-point is-selected"/);
  assert.match(html, /href="#\/providers\?node=B&amp;metric=completed"/);
  assert.doesNotMatch(html, /<select|<option/);
});

test('rates use a fixed absolute 0–100 percent horizontal axis and keep vertical prices stable across metrics', () => {
  const points = [
    { ...point('A', '0.0001', 4), mainResolved: 10, timeoutRate: 10, outvotedRate: 50, failureRate: 60 },
    { ...point('B', '0.0002', 10), mainResolved: 10, timeoutRate: 0, outvotedRate: 0, failureRate: 0 },
  ];
  const completions = plottedGroups(renderMarketScatter(points));
  const timeouts = plottedGroups(renderMarketScatter(points, { metric: 'timeoutRate' }));
  assert.deepEqual(timeouts.map(({ y }) => y), completions.map(({ y }) => y));
  assert.equal(timeouts[0].x, 179.8, '10% is one tenth across the fixed domain, not normalized to the maximum visible rate');
  assert.equal(timeouts[1].x, 126);
  const html = renderMarketScatter(points, { metric: 'failureRate' });
  assert.match(html, /失败比例/);
  assert.match(html, />100%<\/text>/);
  assert.match(html, />50%<\/text>/);
  assert.match(html, />0%<\/text>/);
  assert.match(html, /固定0至100%/);
  assert.match(html, /data-metric="failureRate" data-metric-value="60"/);
  assert.match(html, /href="#\/providers\?node=A&amp;metric=failureRate"/);
  assert.match(renderMarketScatter(points, { metric: 'unknown' }), /data-market-metric="completed"/);
});

test('rate plots exclude missing or zero-denominator samples without changing the eligible market mean', () => {
  const points = [
    { ...point('known', '0.0001', 5), mainResolved: 5, timeoutRate: 0 },
    { ...point('new', '0.0003', 0), mainResolved: 0, timeoutRate: 0 },
    { ...point('missing', '0.0002', 2), timeoutRate: null },
    { ...point('bad', '0.0002', 2), timeoutRate: Infinity },
  ];
  const html = renderMarketScatter(points, { metric: 'timeoutRate' });
  const groups = plottedGroups(html);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quote, '0.0001');
  assert.equal(groups[0].relativePrice, 50, 'mean includes all four eligible quotes, including nodes missing the selected outcome sample');
  assert.equal(groups[0].x, 126, 'a genuine zero rate from known samples remains valid');
  assert.doesNotMatch(html, /data-node-id="new"|data-node-id="missing"/);
  assert.deepEqual(getMarketPointGroup(points, 'new', { metric: 'timeoutRate' }), []);
  const empty = renderMarketScatter([{ ...point('new', '0.1', 0), mainResolved: 0 }], { metric: 'failureRate' });
  assert.match(empty, /暂无失败比例样本/);
  assert.doesNotMatch(empty, /market-scatter-dot|NaN|Infinity/);
});

test('overlapping rates retain every independent node and own/selected state with the chosen metric', () => {
  const points = [
    { ...point('A', '0.0001', 9), mainResolved: 10, timeoutRate: 10 },
    { ...point('B', '0.0001', 18), mainResolved: 20, timeoutRate: 10 },
    { ...point('C', '0.0003', 2), mainResolved: 2, timeoutRate: 0 },
  ];
  const html = renderMarketScatter(points, { metric: 'timeoutRate', selectedId: 'B', ownId: 'A' });
  assert.equal(plottedGroups(html).length, 2);
  assert.match(html, /class="market-scatter-point is-selected is-own"/);
  assert.match(html, /href="#\/providers\?node=B&amp;metric=timeoutRate"/);
  assert.match(html, /机器 A（我的机器）（可接单）、B（可接单）/);
  assert.deepEqual(getMarketPointGroup(points, 'B', { metric: 'timeoutRate' }).map(({ id }) => id), ['A', 'B']);
});

test('nearby interaction groups preserve true coordinates and do not collect distant points', () => {
  const points = [point('A', '0.0001', 20), point('B', '0.000101', 19), point('far', '0.0003', 0)];
  const html = renderMarketScatter(points, { selectedId: 'B' });
  const groups = plottedGroups(html);
  assert.equal(groups.length, 3, 'nearby points must not merge into an invented average coordinate');
  assert.notEqual(groups[0].x, groups[1].x);
  assert.notEqual(groups[0].y, groups[1].y);
  const peers = getMarketPointGroup(points, 'B');
  assert.deepEqual(peers.map(({ id }) => id), ['A', 'B']);
  for (const peer of peers) {
    const rendered = groups.find(group => group.quote === peer.quote && group.completed === peer.completed);
    assert.ok(Math.abs(rendered.x - peer.x) <= 0.005 && Math.abs(rendered.y - peer.y) <= 0.005,
      'selection peers must use the same swapped coordinates shown by the chart');
  }
  assert.ok(Object.isFrozen(peers) && Object.isFrozen(peers[0]));
  assert.match(html, /is-nearby/);
  assert.match(html, /附近共 2 台机器/);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), 3);
});

test('checked not-found rates use reported items, fixed percentages, selected service units and links', () => {
  const points = [
    { ...point('A', '0.0001', 0), mainResolved: 0, itemsReported: 10, notFoundRate: 20 },
    { ...point('B', '0.0002', 0), mainResolved: 0, itemsReported: 0, notFoundRate: 0 },
    { ...point('C', '0.0003', 0), mainResolved: 0, notFoundRate: 40 },
  ];
  const html = renderMarketScatter(points, { taskType: 'key-search-v1', metric: 'notFoundRate' });
  const groups = plottedGroups(html);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].x, 233.6);
  assert.match(html, /ETH\/项/);
  assert.match(html, /未找到占比/);
  assert.match(html, /type=key-search-v1/);
  assert.doesNotMatch(html, /否决|复核|失败占比/);
  assert.doesNotMatch(html, /data-node-id="B"|data-node-id="C"/);
  assert.match(renderMarketScatter(points, { taskType: 'key-search-v1', metric: 'outvotedRate' }), /data-market-metric="completed"/);
});

test('axes show relative metric percentages horizontally and rotate the actual ETH price title along the vertical axis', () => {
  const html = renderMarketScatter([point('A', '0.0001', 10), point('B', '0.0002', 20)]);
  const prices = [...html.matchAll(/data-axis="y" data-value="([^"]+)"/g)].map(match => match[1]);
  assert.ok(prices.includes('0.0001'));
  assert.ok(prices.includes('0.0002'));
  assert.ok(prices.every(price => !price.includes('%')));
  const ticks = [...html.matchAll(/data-axis="x" data-value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ticks, ['0%', '25%', '50%', '75%', '100%']);
  assert.doesNotMatch(html, /market-scatter-reference|market-scatter-grid|stroke-dasharray|均价线/);
  assert.match(html, /transform="rotate\(-90 20 142\)"/);
  assert.match(html, /class="market-scatter-axis-title" x="395" y="302" text-anchor="middle">成功完成/);
  assert.match(html, /报价 · ETH \/ 张/);
  assert.match(html, /成功完成 \/ 最高次数/);
});

test('actual price ticks keep compact precision and their vertical positions remain monotone', () => {
  const html = renderMarketScatter([point('A', '0.000146758333333333', 5), point('B', '0.000175666666666667', 9)]);
  const ticks = [...html.matchAll(/data-axis="y" data-value="([^"]+)"><line[^>]+y1="([^"]+)"[^>]*\/><text[^>]*>([^<]+)<\/text>/g)]
    .map(([, value, y, label]) => ({ value: Number(value), y: Number(y), label }));
  assert.ok(ticks.length >= 3);
  assert.ok(ticks.every(tick => /^\d+(?:\.\d{1,8})?$/.test(tick.label)));
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index].value > ticks[index - 1].value);
    assert.ok(ticks[index].y < ticks[index - 1].y);
  }
  assert.doesNotMatch(html, /market-scatter-reference|market-scatter-grid/);
});

test('quote formatting limits visible precision without changing exact data or tiny-price geometry', () => {
  assert.equal(formatPrice('0.000146758333333333'), '0.00014676');
  assert.equal(formatPrice('0.123456785'), '0.12345679');
  assert.equal(formatPrice('0.999999999999999999'), '1');
  assert.equal(formatPrice('100000000000000000000.000000015'), '100000000000000000000.00000002');
  assert.equal(formatPrice('0.000000009999999999'), '<0.00000001');
  assert.equal(formatPrice('0.000000000000000001'), '<0.00000001');
  assert.equal(formatPrice('0'), '0');
  assert.equal(formatPrice('1.230000000'), '1.23');
  assert.equal(formatPrice(null), '—');
  const html = renderMarketScatter([
    { ...point('A', '0.000000000000000001', 3), mainResolved: 7, timeoutRate: 2 / 7 * 100 },
    { ...point('B', '0.000000000000000002', 4), mainResolved: 7, timeoutRate: 1 / 7 * 100 },
  ], { metric: 'timeoutRate' });
  assert.match(html, /data-quote="0.000000000000000001"/);
  assert.match(html, /aria-label="机器 A（可接单）；报价 &lt;0.00000001 ETH\/张；超时比例 28.6%/);
  assert.doesNotMatch(html, /aria-label="[^"]*28\.571/);
});

test('all owned machines stay highlighted including a mixed ownership overlap group', () => {
  const html = renderMarketScatter([
    point('A', '0.0001', 4), point('B', '0.0001', 4),
    point('C', '0.0002', 7), point('D', '0.0003', 2),
  ], { selectedId: 'B', ownedProviderIds: ['A', 'C'] });
  const links = [...html.matchAll(/<a class="([^"]+)"[^>]*data-node-count="(\d+)"[^>]*aria-label="([^"]+)"/g)];
  assert.equal(links.length, 3);
  assert.equal(links.filter(([, classes]) => classes.includes('is-own')).length, 2);
  assert.ok(links.some(([, classes, count]) => classes.includes('is-selected is-own') && count === '2'));
  assert.match(html, /机器 A（我的机器）（可接单）、B（可接单）/);
  assert.match(html, /机器 C（我的机器）（可接单）/);
  assert.match(html, /href="#\/providers\?node=B&amp;metric=completed"/);
});

test('owned, rented and other machines have distinct identities without moving mixed overlap coordinates', () => {
  const points = [point('OWN', '0.0001', 4), point('RENTED', '0.0002', 7), point('OTHER', '0.0003', 2),
    point('OVERLAP_RENTED', '0.0001', 4)];
  const options = { selectedId: 'OVERLAP_RENTED', ownedProviderIds: ['OWN'], rentedProviderIds: ['RENTED', 'OVERLAP_RENTED', 'OWN'] };
  const before = structuredClone(points);
  const html = renderMarketScatter(points, options);
  const groups = plottedGroups(html);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(group => group.quote === '0.0001').count, 2);
  assert.match(html, /class="market-scatter-point is-selected is-own is-rented"/);
  assert.match(html, /data-node-id="OVERLAP_RENTED" data-owned-count="1" data-rented-count="1"/);
  assert.doesNotMatch(html, /market-scatter-rented-ring/);
  assert.match(html, /data-point-identity="rented"[^>]*data-node-id="OVERLAP_RENTED"/);
  assert.match(html, /机器 OWN（我的机器）（可接单）、OVERLAP_RENTED（我租用中）/);
  assert.match(html, /机器 RENTED（我租用中）/);
  assert.match(html, /href="#\/providers\?node=OVERLAP_RENTED&amp;metric=completed"/);
  assert.match(html, /aria-label="机器颜色"/);
  assert.match(html, /其他机器/);
  assert.match(html, /<i class="is-unavailable" aria-hidden="true"><\/i>浅色 · 暂不可用/);
  const plain = plottedGroups(renderMarketScatter(points));
  assert.deepEqual(byGeometry(groups), byGeometry(plain), 'identity markers must not jitter or alter plotted values');
  assert.deepEqual(points, before);
});

test('checked services cannot plot rejection rates even if a stale caller supplies rejection data', () => {
  const points = [{ ...point('A', '0.0001', 4), mainResolved: 5, outvotedRate: 20 }];
  for (const taskType of ['key-search-v1']) {
    assert.equal(getMarketMetrics('checked').some(entry => entry.id === 'outvotedRate'), false);
    assert.equal(normalizeMarketMetric('outvotedRate', 'checked'), 'completed');
    const html = renderMarketScatter(points, { taskType, metric: 'outvotedRate' });
    assert.match(html, /data-market-metric="completed"/);
    assert.doesNotMatch(html, /否决比例|data-metric="outvotedRate"/);
    assert.match(html, new RegExp(`type=${taskType}`));
  }
});

test('unavailable machines remain inspectable at their exact coordinates with a non-rentable chosen target', () => {
  const points = [point('A', '0.0001', 4), point('B', '0.0002', 7)];
  const before = structuredClone(points);
  const html = renderMarketScatter(points, { selectedId: 'A', unavailableProviderIds: ['A'] });
  assert.match(html, /class="market-scatter-point is-selected is-unavailable"/);
  assert.match(html, /data-node-id="A"[^>]*data-available="false"[^>]*aria-label="[^"]*当前不可接单/);
  assert.match(html, /data-node-id="B"[^>]*data-available="true"/);
  assert.doesNotMatch(html, /<select|<option|market-node-select|market-scatter-selector/);
  assert.match(html, /href="#\/providers\?node=A&amp;metric=completed"/);
  assert.deepEqual(byGeometry(plottedGroups(html)), byGeometry(plottedGroups(renderMarketScatter(points))));
  assert.deepEqual(points, before);
});

test('mixed overlap groups keep their color and selected machine availability, dimming only wholly unavailable groups', () => {
  const points = [point('A', '0.0001', 4), point('B', '0.0001', 4)];
  const selectedUnavailable = renderMarketScatter(points, { selectedId: 'A', unavailableProviderIds: ['A'], ownedProviderIds: ['B'] });
  assert.match(selectedUnavailable, /class="market-scatter-point is-selected is-own"/);
  assert.doesNotMatch(selectedUnavailable, /<a class="[^"]*is-unavailable/);
  assert.match(selectedUnavailable, /data-node-id="A"[^>]*data-available="false"/);
  assert.match(selectedUnavailable, /aria-label="机器 A（不可接单）、B（我的机器）（可接单）；[^"]*当前选中 A：当前不可接单/);
  const selectedAvailable = renderMarketScatter(points, { selectedId: 'B', unavailableProviderIds: ['A'] });
  assert.match(selectedAvailable, /data-node-id="B"[^>]*data-available="true"/);
  assert.doesNotMatch(selectedAvailable, /当前选中 [^：]*：当前不可接单|<a class="[^"]*is-unavailable/);
  assert.match(selectedAvailable, /aria-label="机器 A（不可接单）、B（可接单）；/);
  const allUnavailable = renderMarketScatter(points, { selectedId: 'B', unavailableProviderIds: ['A', 'B'] });
  assert.match(allUnavailable, /class="market-scatter-point is-selected is-unavailable"/);
  assert.match(allUnavailable, /data-node-id="B"[^>]*data-available="false"/);
  assert.deepEqual(plottedGroups(selectedUnavailable), plottedGroups(allUnavailable));
  const unknown = renderMarketScatter(points, { selectedId: 'A', unavailableProviderIds: ['missing'] });
  assert.doesNotMatch(unknown, /<a class="[^"]*is-unavailable|data-available="false"|当前不可接单/);
});

test('unselected unavailable groups never claim to be the current selection', () => {
  const points = [point('A', '0.0001', 4), point('B', '0.0002', 7)];
  for (const selectedId of [null, 'B', 'missing']) {
    const html = renderMarketScatter(points, { selectedId, unavailableProviderIds: ['A'] });
    assert.match(html, /aria-label="机器 A（不可接单）；/);
    assert.doesNotMatch(html, /当前选中/);
    assert.match(html, /data-node-id="A"[^>]*data-available="false"/);
  }
});

test('rented machine labels avoid redundant unavailability while preserving inspection and rental guards', () => {
  const points = [point('RENTED', '0.0001', 4), point('OTHER', '0.0002', 7)];
  const html = renderMarketScatter(points, {
    selectedId: 'RENTED', rentedProviderIds: ['RENTED'], unavailableProviderIds: ['RENTED'],
  });
  assert.match(html, /class="market-scatter-point is-selected is-rented is-unavailable"/);
  assert.match(html, /data-node-id="RENTED"[^>]*data-available="false"[^>]*aria-label="机器 RENTED（我租用中）；/);
  assert.doesNotMatch(html, /不可接单|当前选中|<select|<option|market-node-select|market-scatter-selector/);
  assert.match(html, /href="#\/providers\?node=RENTED&amp;metric=completed"/);
  assert.deepEqual(byGeometry(plottedGroups(html)), byGeometry(plottedGroups(renderMarketScatter(points))));
  const empty = renderMarketScatter([{ ...point('new', '0.0001', 0), mainResolved: 0 }], { metric: 'timeoutRate' });
  assert.equal(empty, '<div class="market-scatter-empty">暂无超时比例样本</div>');
});

test('legend filtering hides only requested identities and keeps full-market coordinates and exact overlap selection', () => {
  const points = [point('OWN', '0.0001', 4), point('RENTED', '0.0001', 4), point('OTHER', '0.0003', 10)];
  const options = { ownedProviderIds: ['OWN'], rentedProviderIds: ['RENTED'], selectedId: 'RENTED' };
  const initial = plottedGroups(renderMarketScatter(points, options));
  const html = renderMarketScatter(points, { ...options, visibleProviderIds: ['RENTED'], visibility: { own: false, other: false } });
  const [visible] = plottedGroups(html);
  const overlap = initial.find(group => group.count === 2);
  assert.equal(visible.count, 1);
  assert.equal(visible.x, overlap.x);
  assert.equal(visible.y, overlap.y);
  assert.match(html, /class="market-scatter-point is-selected is-rented"/);
  assert.match(html, /data-node-id="RENTED"/);
  assert.doesNotMatch(html, /data-node-id="OWN"|data-node-id="OTHER"|is-own is-rented/);
  assert.deepEqual(getMarketPointGroup(points, 'RENTED', { visibleProviderIds: ['RENTED'] }).map(node => node.id), ['RENTED']);
  assert.deepEqual(getMarketPointGroup(points, 'OWN', { visibleProviderIds: ['RENTED'] }), []);
  assert.match(html, /data-market-filter="own" aria-pressed="false"/);
  assert.match(html, /data-market-filter="rented" aria-pressed="true"/);
});

test('hiding all plotted machines retains axes and four accessible legend buttons to restore them', () => {
  const html = renderMarketScatter([point('A', '0.0001', 4)], {
    visibleProviderIds: [], visibility: { own: false, rented: false, other: false, unavailable: false },
  });
  assert.doesNotMatch(html, /market-scatter-dot/);
  assert.match(html, /已隐藏全部机器/);
  assert.match(html, /market-scatter-axis/);
  assert.equal((html.match(/class="market-legend-toggle"/g) ?? []).length, 4);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 4);
});

test('nearby dots paint other, rented, owned and selected identities above one another without changing geometry or peers', () => {
  const points = [
    point('SELECTED', '0.0001', 100), point('OWN', '0.00010001', 100),
    point('RENTED', '0.00010002', 100), point('OTHER', '0.00010003', 100),
  ];
  const before = structuredClone(points);
  const peers = getMarketPointGroup(points, 'SELECTED');
  const positions = html => [...html.matchAll(/<a class="market-scatter-point[^"]*"[^>]*data-node-id="([^"]+)"[^>]*>[\s\S]*?<circle class="market-scatter-dot" cx="([^"]+)" cy="([^"]+)"/g)]
    .map(([, id, x, y]) => ({ id, x: Number(x), y: Number(y) }));
  const plain = positions(renderMarketScatter(points));
  const html = renderMarketScatter(points, {
    selectedId: 'SELECTED', ownedProviderIds: ['OWN'], rentedProviderIds: ['RENTED'],
  });
  const layered = positions(html);
  assert.deepEqual(plain.map(({ id }) => id), ['SELECTED', 'OWN', 'RENTED', 'OTHER']);
  assert.deepEqual(layered.map(({ id }) => id), ['OTHER', 'RENTED', 'OWN', 'SELECTED']);
  const byId = positions => [...positions].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(layered), byId(plain), 'paint priority changes stacking only, never the actual coordinates');
  assert.equal(peers.length, 4, 'all nearby machines remain in the same interaction group');
  assert.deepEqual(getMarketPointGroup(points, 'SELECTED'), peers);
  assert.deepEqual(points, before);
});
