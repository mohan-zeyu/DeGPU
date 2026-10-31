import { getMarketStats } from './market.js';
import { getMarketList } from './market-list.js';
import { formatPrice } from './market-scatter.js';
import { servicesForState } from './services.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = value => value == null ? '—' : esc(value);
// Keep numeric price columns visually stable while preserving the full value in titles.
const fixedPrice = value => {
  const formatted = formatPrice(value);
  if (formatted === '—' || formatted.startsWith('<')) return formatted;
  const [whole, fraction = ''] = formatted.split('.');
  return `${whole}.${fraction.padEnd(8, '0')}`;
};
const descriptions = Object.freeze({
  'image-classify-v1': '识别图片内容，批量返回分类结果。',
  'blender-render-v1': '将 Blender 场景渲染为图像帧。',
  'key-search-v1': '搜索满足挑战条件的数值密钥。',
});
const quoteSorts = Object.freeze({ 'image-classify-v1': 'imageQuote',
  'blender-render-v1': 'renderQuote', 'key-search-v1': 'keyQuote' });

import { taskRuntimeLabel } from './task-runtime.js';
function serviceSummary(state, service) {
  const market = getMarketStats(state ?? {}, service.id);
  const price = fixedPrice(market.averageQuote);
  const task = state.taskTypes?.find(t => t.id === service.id);
  const runtime = task ? `<small>${esc(taskRuntimeLabel(task))}${task.code_matches === false ? ' · 代码与网络不一致' : ''} · 默认 ${esc(task.defaultPrice)} ETH</small>` : '';
  return `<article class="stat market-service-stat" data-service="${service.id}"><h2>${esc(service.name)}</h2><p class="market-service-description">${esc(descriptions[service.id] || service.description)}</p>${runtime}<div class="market-service-price"><span>市场均价</span><strong title="质押达标机器正报价的算术平均">${esc(price)}<span class="market-price-unit">ETH / ${esc(service.unit)}</span></strong></div></article>`;
}

function machineRow({ id, address, stats, identity, availability }, service, account, state) {
  const own = identity === 'own';
  const rented = identity === 'rented';
  const provider = state.providers.find(p => p.id === id);
  const mayRentAgain = provider?.concurrentJobs === true;
  const identityLabel = own ? '<span class="own-node-label">我的机器</span>'
    : rented ? '<span class="rented-node-label">我租用中</span>' : '';
  const identityName = stats.name === '我的机器' ? address || id : stats.name || id;
  const name = /^0x[\da-f]{40}$/i.test(String(identityName))
    ? `${String(identityName).slice(0, 6)}…${String(identityName).slice(-4)}`
    : stats.name && stats.name !== '我的机器' ? stats.name : `机器 ${id}`;
  const active = stats.active === true ? '已达标' : stats.active === false ? '未达标' : '未知';
  const unavailableLabel = availability.label === '未满足接单条件' ? '未激活' : availability.label;
  const action = own ? `<a class="btn" href="#/supply?machine=${encodeURIComponent(id)}">管理</a>`
    : (!rented || mayRentAgain) && availability.available ? `<a class="btn primary" href="#/new?provider=${encodeURIComponent(id)}&amp;type=${encodeURIComponent(service.id)}">${account ? '选用' : '登录选用'}</a>`
      : `<button class="btn" type="button" disabled title="${esc(rented ? '当前租赁尚未结束' : availability.reason)}">${rented ? '租用中' : unavailableLabel}</button>`;
  const quoteMarkup = entry => `<td class="market-machine-price market-number" data-metric="${quoteSorts[entry.id]}" title="${esc(stats.quotes[entry.id] ?? '暂无报价')}">${esc(fixedPrice(stats.quotes[entry.id]))}</td>`;
  const quotes = servicesForState(state).map(quoteMarkup).join('');
  const stake = fixedPrice(stats.stake);
  return `<tr class="market-machine-row ${availability.available ? 'is-available' : 'is-unavailable'}${own ? ' is-own' : rented ? ' is-rented' : ''}" data-node-id="${esc(id)}"><th scope="row" title="${esc(address || id)}"><span class="market-machine-name">${esc(name)}</span>${identityLabel}${provider?.record ? `<details><summary>信誉</summary><span>主计算被否决 ${number(provider.record.replicated?.outvoted || 0)} · 超时 ${number(Number(provider.record.replicated?.missed || 0) + Number(provider.record.checked?.missed || 0))} · 复核被否决 ${number(provider.record.replicated?.checks_outvoted || 0)}</span></details>` : ''}</th><td class="market-machine-active" data-metric="active" title="Active 仅表示已注册且质押达标；在线状态未提供"><span class="market-active-label${stats.active === true ? ' is-active' : ''}">${active}</span></td><td class="market-number" data-metric="stake" title="${esc(stats.stake)} ETH">${esc(stake)}</td>${quotes}<td data-metric="lockedJobs">${number(stats.lockedJobs)}</td><td data-metric="totalCompleted" title="所有任务类型的主计算完成总数">${number(stats.totalCompleted)}</td><td class="market-machine-action">${action}</td></tr>`;
}

export function renderMarketPage(state, {
  role = 'client', account = state?.account, providerId = null, ownedProviderIds = null,
  taskType = 'image-classify-v1', connectivityByProvider = {}, ownership = 'all',
  availability = 'all', sort = 'id-asc', query = '',
} = {}) {
  const catalog = servicesForState(state);
  const service = catalog.find(entry => entry.id === taskType) || catalog[0];
  if (!service) return '<section class="panel">当前网络没有已注册的任务类型。</section>';
  const ownIds = Array.isArray(ownedProviderIds) ? ownedProviderIds : role === 'provider' && providerId != null ? [providerId] : [];
  // One table contains every matching registered machine. A bounded table
  // viewport keeps the page compact without hiding machines behind pagination.
  const list = getMarketList(state, { account, ownedProviderIds: ownIds, taskType: service.id,
    connectivityByProvider, ownership, availability, sort, query, pageSize: null });
  const link = ordering => {
    const params = new URLSearchParams({ type: service.id, sort: ordering });
    if (list.query) params.set('q', list.query);
    if (list.ownership !== 'all') params.set('ownership', list.ownership);
    if (list.availability !== 'all') params.set('availability', list.availability);
    return `#/providers?${params}`;
  };
  const column = (key, label, unit = '') => {
    const ascending = list.sort === `${key}-asc`;
    const descending = list.sort === `${key}-desc`;
    const direction = ascending ? 'desc' : 'asc';
    return `<th scope="col" aria-sort="${ascending ? 'ascending' : descending ? 'descending' : 'none'}"><a class="market-column-sort" href="${esc(link(`${key}-${direction}`))}" aria-label="${esc(label)}，按${direction === 'asc' ? '升' : '降'}序排序"><span>${esc(label)}${unit ? `<span class="market-column-unit">${esc(unit)}</span>` : ''}</span></a></th>`;
  };
  const headers = column('id', '机器') + column('active', '接单资格', 'Active') + column('stake', '质押', 'ETH')
    + catalog.map(entry => quoteSorts[entry.id] ? column(quoteSorts[entry.id], entry.name, `ETH / ${entry.unit}`) : `<th scope="col">${esc(entry.name)}<span class="market-column-unit">ETH / ${esc(entry.unit)}</span></th>`).join('')
    + column('lockedJobs', '进行中') + column('totalCompleted', '总完成') + '<th scope="col">操作</th>';
  const search = `<form id="market-search-form" role="search"><input type="search" name="q" aria-label="搜索机器" placeholder="搜索机器或地址" value="${esc(list.query)}" autocomplete="off"><button class="btn" type="submit">搜索</button></form>`;
  const serviceSelect = `<label class="market-action-service" for="market-service-select">选用服务<select id="market-service-select" aria-label="选用服务">${catalog.map(entry => `<option value="${entry.id}"${entry.id === service.id ? ' selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>`;
  // Keep the column grid explicit so the sticky header and every row share the
  // same geometry even when a machine name or action label is longer.  The
  // table remains horizontally scrollable below the compact viewport.
  const columns = '<colgroup><col class="market-col-machine"><col class="market-col-active"><col class="market-col-stake">' + catalog.map(() => '<col class="market-col-quote">').join('') + '<col class="market-col-count"><col class="market-col-count"><col class="market-col-action"></colgroup>';
  const table = `<div class="table-wrap market-list-wrap" tabindex="0" aria-label="滚动查看全部机器"><table class="market-machine-list" aria-label="机器列表">${columns}<thead><tr>${headers}</tr></thead><tbody>${list.rows.length ? list.rows.map(row => machineRow(row, service, account, state)).join('') : `<tr><td class="market-list-empty" colspan="${catalog.length + 6}">没有符合条件的机器</td></tr>`}</tbody></table></div>`;
  return `<div class="stats market-overall" aria-label="任务类型和市场均价">${catalog.map(entry => serviceSummary(state, entry)).join('')}</div><section class="panel market-panel" aria-label="市场行情"><div class="market-table-toolbar"><div class="market-table-heading"><h2>全部机器</h2><span>${list.filteredTotal} 台</span></div><div class="market-table-controls">${search}${serviceSelect}</div></div>${table}</section>`;
}
