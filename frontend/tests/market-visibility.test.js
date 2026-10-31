import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { renderMarketPage } from '../src/market-view.js';

const IMAGE = 'image-classify-v1';
const RENDER = 'blender-render-v1';
const KEY = 'key-search-v1';

function marketFixture() {
  const state = createDemoStore().getState();
  const quotes = ['0.00008', '0.0001', '0.00014', '0.0002'];
  state.providers = state.providers.slice(0, 4).map((provider, index) => ({
    ...provider, active: true, registered: true, lockedJobs: index === 1 ? 1 : 0,
    offers: { [IMAGE]: quotes[index], [RENDER]: '0.002', [KEY]: '0.00003' },
  }));
  state.jobs = state.providers.map((provider, index) => ({
    id: `replicated:${index + 1}`, taskType: IMAGE, mode: 'replicated', provider: provider.id,
    itemCount: 1, closed: true, phase: 'Closed', outcome: 'Verified',
    events: [{ name: 'JobCreated', args: { main: provider.address } },
      { name: 'JobClosed', args: { outcome: 'Verified' } }],
  }));
  state.jobs.push({
    id: 'replicated:5', taskType: IMAGE, mode: 'replicated', provider: 'B',
    clientId: state.account.id, closed: false, phase: 'Committing',
    events: [{ name: 'JobCreated', args: { client: state.account.address, main: state.providers[1].address } }],
  });
  return { state, options: { account: state.account, ownedProviderIds: ['A'],
    connectivityByProvider: { D: 'offline' } } };
}

const listedIds = html => [...html.matchAll(/<tr\b[^>]*data-node-id="([^"]+)"/g)].map(match => match[1]);
const machineRow = (html, id) => [...html.matchAll(/<tr\b[^>]*data-node-id="[^"]+"[^>]*>[\s\S]*?<\/tr>/g)]
  .map(match => match[0]).find(row => row.includes(`data-node-id="${id}"`)) ?? '';
const overallCards = html => html.slice(0, html.indexOf('<section class="panel market-panel'));

test('the default market lists every registered machine and keeps own and rental identities visible', () => {
  const { state, options } = marketFixture();
  const html = renderMarketPage(state, options);
  assert.deepEqual(listedIds(html), ['A', 'B', 'C', 'D']);
  assert.match(machineRow(html, 'A'), /class="own-node-label">我的机器/);
  assert.match(machineRow(html, 'A'), /href="#\/supply\?machine=A">管理/);
  assert.match(machineRow(html, 'B'), /class="rented-node-label">我租用中/);
  assert.match(machineRow(html, 'C'), /href="#\/new\?provider=C&amp;type=image-classify-v1"/);
  assert.match(machineRow(html, 'D'), /disabled[^>]*>离线<\/button>/);
  assert.doesNotMatch(machineRow(html, 'D'), /href="#\/new/);
  assert.match(html, /<table[^>]*aria-label="机器列表"/);
  assert.doesNotMatch(html, /<aside|market-scatter|market-service-rates|失败率|超时率|否决率|未找到占比|market-sort-select|market-ownership-select|market-availability-select/);
});

test('each machine shows all three quotes, active eligibility, stake and public counts together', () => {
  const { state, options } = marketFixture();
  state.providers[1].active = false;
  state.providers[1].record = { replicated: { verified_completed: 9, unverified_completed: 2 },
    checked: { completed: 5 } };
  const row = machineRow(renderMarketPage(state, options), 'B');
  assert.match(row, /data-metric="active"[^>]*>[\s\S]*?>未达标<\/span>/);
  assert.match(row, /title="Active 仅表示已注册且质押达标；在线状态未提供"/);
  for (const [key, quote] of [['imageQuote', '0.00010000'], ['renderQuote', '0.00200000'], ['keyQuote', '0.00003000']]) {
    assert.match(row, new RegExp(`data-metric="${key}"[^>]*>${quote.replace('.', '\\.')}<\\/td>`));
  }
  assert.match(row, /data-metric="stake"/);
  assert.match(row, /data-metric="lockedJobs">1<\/td>/);
  assert.match(row, /data-metric="totalCompleted"[^>]*>16<\/td>/);
  const html = renderMarketPage(state, { ...options, taskType: RENDER });
  assert.match(html, />总完成</);
  assert.match(machineRow(html, 'C'), /href="#\/new\?provider=C&amp;type=blender-render-v1"/);
  assert.match(machineRow(html, 'C'), /data-metric="imageQuote"/);
});

test('address-based machine names stay compact and own identity appears once', () => {
  const { state, options } = marketFixture();
  state.providers[0].name = '我的机器';
  state.providers[0].address = '0x1234567890123456789012345678901234567890';
  state.providers[2].name = '0xabcdef123456789012345678901234567890abcd';
  const html = renderMarketPage(state, options);
  const own = machineRow(html, 'A');
  assert.match(own, /class="market-machine-name">0x1234…7890<\/span>/);
  assert.equal((own.match(/>我的机器</g) ?? []).length, 1);
  assert.match(own, /title="0x1234567890123456789012345678901234567890"/);
  assert.match(machineRow(html, 'C'), /class="market-machine-name">0xabcd…abcd<\/span>/);
});

test('three service descriptions and market mean prices remain independent of table filters and selection', () => {
  const { state, options } = marketFixture();
  const header = overallCards(renderMarketPage(state, options));
  for (const id of [IMAGE, RENDER, KEY]) assert.match(header, new RegExp(`data-service="${id}"`));
  assert.equal((header.match(/class="market-service-description"/g) ?? []).length, 3);
  assert.equal((header.match(/>市场均价</g) ?? []).length, 3);
  assert.match(header, />0\.00013000<span/);
  assert.match(header, />0\.00200000<span/);
  assert.match(header, />0\.00003000<span/);
  assert.equal(overallCards(renderMarketPage(state, { ...options, taskType: KEY, query: 'C', sort: 'stake-desc' })), header);
});

test('every data column offers keyboard accessible sorting and exposes its current direction', () => {
  const { state, options } = marketFixture();
  const html = renderMarketPage(state, { ...options, sort: 'imageQuote-desc', taskType: KEY, query: ' A ' });
  assert.equal((html.match(/class="market-column-sort"/g) ?? []).length, 8);
  assert.equal((html.match(/aria-sort="descending"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /market-sort-indicator|[↑↓↕]/);
  assert.match(html, /aria-sort="descending"><a[^>]*sort=imageQuote-asc[^>]*q=A/);
  for (const key of ['id', 'active', 'stake', 'renderQuote', 'keyQuote', 'lockedJobs', 'totalCompleted']) {
    assert.match(html, new RegExp(`href="#[^"]*type=key-search-v1[^\"]*sort=${key}-asc`));
  }
  assert.match(html, /aria-label="图像分类，按升序排序"/);
  assert.deepEqual(listedIds(renderMarketPage(state, { ...options, sort: 'imageQuote-desc' })), ['D', 'C', 'B', 'A']);
});

test('search retains all columns and empty state without changing offers or private access', () => {
  const { state, options } = marketFixture();
  const before = structuredClone(state);
  assert.deepEqual(listedIds(renderMarketPage(state, { ...options, query: state.providers[2].address })), ['C']);
  const html = renderMarketPage(state, { ...options, query: 'no matching machine' });
  assert.deepEqual(listedIds(html), []);
  assert.match(html, /没有符合条件的机器/);
  assert.match(html, /id="market-search-form"/);
  assert.match(html, /id="market-service-select"/);
  assert.doesNotMatch(html, /href="#\/(?:new|supply)\?/);
  const loggedOut = renderMarketPage(state, { ...options, account: null });
  assert.deepEqual(listedIds(loggedOut), ['A', 'B', 'C', 'D']);
  assert.doesNotMatch(loggedOut, /class="rented-node-label"/);
  assert.deepEqual(state, before);
});

test('all machines render in a single table even when stale pagination options are supplied', () => {
  const { state, options } = marketFixture();
  const template = state.providers[2];
  state.providers = Array.from({ length: 20 }, (_, index) => ({ ...template,
    id: `GPU-${index + 1}`, address: `0x${String(index + 1).padStart(40, '0')}` }));
  const html = renderMarketPage(state, { ...options, page: 7, pageSize: 4 });
  assert.equal(listedIds(html).length, 20);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.match(html, /tabindex="0" aria-label="滚动查看全部机器"/);
  assert.doesNotMatch(html, /table-pagination|上一页|下一页/);
});
