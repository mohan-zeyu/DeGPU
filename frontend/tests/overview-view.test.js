import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOverview } from '../src/overview-view.js';

test('the compact home introduces the market and gives direct rent and supply actions', () => {
  const html = renderOverview({ network: { mode: 'live' }, jobs: [] });
  const hero = html.slice(0, html.indexOf('class="home-services"'));
  assert.match(hero, /aria-label="平台简介"/);
  assert.match(hero, /租用算力完成任务，或提供机器赚取 ETH/);
  assert.match(hero, /href="#\/providers">租用算力/);
  assert.match(hero, /href="#\/supply">提供我的机器/);
  assert.equal((hero.match(/<a\b/g) ?? []).length, 2);
  for (const task of ['图像分类', 'Blender 渲染', '密钥搜索']) assert.match(html, new RegExp(task));
  assert.doesNotMatch(html, /<svg|<canvas|<ol|流程图|观察市场|验证结算|链下比对|精确复核|资源监管/);
});

test('visitors see a connection entry without wallet statistics, including a locked live wallet', () => {
  for (const state of [{ network: { mode: 'live' }, jobs: [] }, {
    network: { mode: 'live' }, unlocked: false, account: { id: 'locked', balance: '123.45' }, jobs: [],
  }]) {
    const html = renderOverview(state);
    assert.match(html, /href="#\/account">连接钱包与网络/);
    assert.doesNotMatch(html, /class="panel home-current"|钱包余额|123\.45/);
  }
});

test('an unlocked wallet shows its balance, active task count and provider state with a task link', () => {
  const html = renderOverview({
    network: { mode: 'live' }, unlocked: true, account: { id: '0xClient', balance: '1.23456789' },
    selfProvider: { serving: true },
    jobs: [{ id: 'replicated:1', closed: false }, { id: 'checked:1', closed: false },
      { id: 'replicated:2', closed: true }],
  });
  assert.match(html, /class="panel home-current"/);
  assert.match(html, /href="#\/jobs">查看任务/);
  assert.match(html, /钱包余额<\/span><strong>1\.234568 ETH/);
  assert.match(html, /运行中的任务<\/span><strong>2<\/strong>/);
  assert.match(html, /机器接单<\/span><strong>已开启<\/strong>/);
  assert.match(html, /任务运行期间请保持本机 DeGPU 服务开启/);
  assert.doesNotMatch(html, /href="#\/account">连接钱包与网络/);
});

test('offline home counts only the selected account’s unfinished jobs and has no active-work reminder while idle', () => {
  const state = { network: { mode: 'demo' }, account: { id: 'alice', balance: '2' },
    selfProvider: { serving: false }, jobs: [
      { id: 'own-active', clientId: 'alice', closed: false },
      { id: 'own-closed', clientId: 'alice', closed: true },
      { id: 'other-active', clientId: 'bob', closed: false },
    ] };
  const active = renderOverview(state);
  assert.match(active, /运行中的任务<\/span><strong>1<\/strong>/);
  assert.match(active, /机器接单<\/span><strong>未开启<\/strong>/);
  const idle = renderOverview({ ...state, jobs: state.jobs.slice(1) });
  assert.match(idle, /运行中的任务<\/span><strong>0<\/strong>/);
  assert.doesNotMatch(idle, /任务运行期间请保持本机 DeGPU 服务开启/);
});

test('the home labels its test currency without claiming a mainnet connection or adding protocol sections', () => {
  const html = renderOverview({ network: { mode: 'live', name: 'Anvil', chainId: 31337 }, jobs: [] });
  assert.match(html, /测试 ETH/);
  assert.doesNotMatch(html, /真实 ETH|已接入主网|主网支付|overview-journey|overview-principles|overview-blocks/);
});
