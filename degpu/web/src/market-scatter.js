import { getService } from './services.js';

const WEI = 10n ** 18n;
const WIDTH = 700;
const HEIGHT = 326;
const PLOT = { left: 126, right: 664, top: 38, bottom: 246 };
const NEARBY_DISTANCE = 28;

export const MARKET_METRICS = Object.freeze([
  Object.freeze({ id: 'completed', label: '成功完成', isRate: false }),
  Object.freeze({ id: 'timeoutRate', label: '超时比例', isRate: true }),
  Object.freeze({ id: 'outvotedRate', label: '否决比例', isRate: true }),
  Object.freeze({ id: 'failureRate', label: '失败比例', isRate: true }),
]);

export const CHECKED_MARKET_METRICS = Object.freeze([
  Object.freeze({ id: 'completed', label: '已提交结算', isRate: false }),
  Object.freeze({ id: 'timeoutRate', label: '超时比例', isRate: true }),
  Object.freeze({ id: 'notFoundRate', label: '未找到占比', isRate: true }),
]);
export const getMarketMetrics = (mode = 'replicated') => mode === 'checked' ? CHECKED_MARKET_METRICS : MARKET_METRICS;
export const normalizeMarketMetric = (metric, mode = 'replicated') => getMarketMetrics(mode).some((entry) => entry.id === metric)
  ? metric : 'completed';
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function priceWei(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  return match ? BigInt(match[1]) * WEI + BigInt((match[2] ?? '').padEnd(18, '0')) : null;
}

function priceEth(value) {
  const fraction = (value % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / WEI}${fraction ? `.${fraction}` : ''}`;
}

// Presentation only: offers and geometry retain their complete wei precision.
export function formatPrice(value) {
  if (value === null || value === undefined) return '—';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return '—';
  const fraction = (match[2] ?? '').padEnd(9, '0');
  let scaled = BigInt(match[1]) * 100000000n + BigInt(fraction.slice(0, 8));
  if (scaled === 0n && /[1-9]/.test(`${match[1]}${match[2] ?? ''}`)) return '<0.00000001';
  if (fraction[8] >= '5') scaled += 1n;
  const roundedFraction = (scaled % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${scaled / 100000000n}${roundedFraction ? `.${roundedFraction}` : ''}`;
}

const displayRate = (value) => value > 0 && value < 0.1 ? '<0.1%' : `${Number(value.toFixed(1))}%`;

function nodeHref(id, metric, taskType) {
  const wellFormed = Array.from(id, (character) => character.length === 1
    && /[\uD800-\uDFFF]/.test(character) ? '\uFFFD' : character).join('');
  return `#/providers?node=${encodeURIComponent(wellFormed)}&metric=${metric}${taskType ? `&type=${encodeURIComponent(taskType)}` : ''}`;
}

function normalizePoints(points) {
  const seen = new Set();
  return (Array.isArray(points) ? points : []).flatMap((point) => {
    if (!point || (typeof point.id !== 'string' && typeof point.id !== 'number')) return [];
    const id = String(point.id);
    const amount = priceWei(point.quote);
    if (!id || seen.has(id) || amount === null) return [];
    seen.add(id);
    const completed = Number.isSafeInteger(point.completed) && point.completed >= 0 ? point.completed : null;
    const rates = Object.fromEntries([...MARKET_METRICS, ...CHECKED_MARKET_METRICS].filter((entry) => entry.isRate).map(({ id: key }) => [key,
      Number.isSafeInteger(key === 'notFoundRate' ? point.itemsReported : point.mainResolved)
        && (key === 'notFoundRate' ? point.itemsReported : point.mainResolved) > 0
        && typeof point[key] === 'number' && Number.isFinite(point[key])
        && point[key] >= 0 && point[key] <= 100 ? point[key] : null,
    ]));
    return [{ id, amount, quote: priceEth(amount), completed, ...rates }];
  });
}

function classes(base, nodes, selectedId, ownIds, rentedIds, unavailableIds, nearbyIds = []) {
  return `${base}${nodes.some((node) => node.id === selectedId) ? ' is-selected' : ''}${nodes.some((node) => ownIds.has(node.id)) ? ' is-own' : ''}${nodes.some((node) => rentedIds.has(node.id)) ? ' is-rented' : ''}${nodes.some((node) => nearbyIds.includes(node.id)) && !nodes.some((node) => node.id === selectedId) ? ' is-nearby' : ''}${nodes.every(node => unavailableIds.has(node.id)) ? ' is-unavailable' : ''}`;
}

// All eligible quotes set the same Y domain even when a selected metric has
// unknown samples. X is relative only for completion counts; rates always use
// their absolute 0–100% scale. Exact quote arithmetic preserves wei precision.
function project(points, metric, priceDomain = null) {
  const normalized = normalizePoints(points);
  if (!normalized.length) return { normalized, groups: [] };
  const population = BigInt(normalized.length);
  const totalPrice = normalized.reduce((sum, point) => sum + point.amount, 0n);
  const maxCompleted = Math.max(0, ...normalized.map((point) => point.completed ?? 0));
  const scaledPrices = normalized.map((point) => point.amount * population);
  let yMin = scaledPrices.reduce((minimum, amount) => amount < minimum ? amount : minimum);
  let yMax = scaledPrices.reduce((maximum, amount) => amount > maximum ? amount : maximum);
  const domainMin = priceWei(priceDomain?.minQuote);
  const domainMax = priceWei(priceDomain?.maxQuote);
  const fixedDomain = domainMin !== null && domainMax !== null && domainMin <= domainMax;
  if (fixedDomain) {
    // Include all actual points even if a caller supplies a stale/narrow range.
    // A fixed initial range makes a narrowing price band visible over time.
    if (domainMin * population < yMin) yMin = domainMin * population;
    if (domainMax * population > yMax) yMax = domainMax * population;
  }
  const span = yMax - yMin;
  let padding = span ? span / 8n : totalPrice / 4n;
  if (!fixedDomain && padding < yMax / 8n) padding = yMax / 8n;
  if (padding < 1n) padding = 1n;
  // Normal market prices use an honest zero baseline: a small price band
  // should look small instead of being stretched across the entire chart.
  yMin = fixedDomain && yMin > padding ? yMin - padding : 0n;
  yMax += padding;
  if (yMax === yMin) yMax += 1n;
  const y = (amount) => PLOT.bottom - Number((amount - yMin) * 1000000000n / (yMax - yMin))
    / 1000000000 * (PLOT.bottom - PLOT.top);
  const x = (value) => PLOT.left + (metric === 'completed' ? (maxCompleted ? value / maxCompleted : 0) : value / 100)
    * (PLOT.right - PLOT.left);
  const exact = new Map();
  for (const point of normalized) {
    const value = point[metric];
    if (value === null) continue;
    const key = `${point.amount}/${value}`;
    if (!exact.has(key)) exact.set(key, { ...point, value, nodes: [], x: x(value), y: y(point.amount * population) });
    exact.get(key).nodes.push(point);
  }
  const groups = [...exact.values()].sort(fixedDomain
    ? (left, right) => left.nodes[0].id < right.nodes[0].id ? -1 : left.nodes[0].id > right.nodes[0].id ? 1 : 0
    : (left, right) => left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : right.value - left.value);
  return { normalized, groups, population, totalPrice, maxCompleted, yMin, yMax };
}

function priceTicks(population, yMin, yMax) {
  const desired = ((yMax - yMin) + population * 4n - 1n) / (population * 4n) || 1n;
  let magnitude = 1n;
  while (magnitude * 10n < desired) magnitude *= 10n;
  const step = [magnitude, magnitude * 2n, magnitude * 5n / 2n, magnitude * 5n, magnitude * 10n]
    .find(value => value >= desired);
  const first = (yMin + population * step - 1n) / (population * step) * step;
  const ticks = [];
  const seenLabels = new Set();
  for (let value = first; value * population <= yMax; value += step) {
    const label = formatPrice(priceEth(value));
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    ticks.push({ value, label, y: PLOT.bottom - Number((value * population - yMin) * 1000000000n / (yMax - yMin))
      / 1000000000 * (PLOT.bottom - PLOT.top) });
  }
  return ticks;
}

function nearbyGroup(groups, selectedId) {
  const first = groups.find((group) => group.nodes.some((node) => node.id === selectedId));
  if (!first) return [];
  const found = new Set([first]);
  const pending = [first];
  while (pending.length) {
    const current = pending.pop();
    for (const group of groups) {
      if (!found.has(group) && Math.hypot(current.x - group.x, current.y - group.y) <= NEARBY_DISTANCE) {
        found.add(group);
        pending.push(group);
      }
    }
  }
  return groups.filter((group) => found.has(group));
}

function visibleGroups(groups, providerIds) {
  if (!Array.isArray(providerIds)) return groups;
  const ids = new Set(providerIds.map(String));
  return groups.flatMap(group => {
    const nodes = group.nodes.filter(node => ids.has(node.id));
    return nodes.length ? [{ ...group, nodes }] : [];
  });
}

// Interaction groups do not alter coordinates. Near points stay at their true
// positions; the selection card lets keyboard/touch users reach hidden peers.
export function getMarketPointGroup(points, selectedId, { metric = 'completed', mode = 'replicated', priceDomain = null, visibleProviderIds = null } = {}) {
  const activeMetric = normalizeMarketMetric(metric, mode);
  const groups = nearbyGroup(visibleGroups(project(points, activeMetric, priceDomain).groups, visibleProviderIds), selectedId);
  return Object.freeze(groups.flatMap((group) => group.nodes.map((node) => Object.freeze({
    id: node.id, quote: node.quote, completed: node.completed, value: node[activeMetric],
    x: group.x, y: group.y,
  }))));
}

export function renderMarketScatter(points, { selectedId = null, ownId = null, ownedProviderIds = null, rentedProviderIds = [], unavailableProviderIds = [], metric = 'completed', taskType = null,
  mode = getService(taskType)?.mode ?? 'replicated', unit = getService(taskType)?.unit ?? '张', priceDomain = null,
  visibleProviderIds = null, visibility = {} } = {}) {
  const activeMetric = normalizeMarketMetric(metric, mode);
  const meta = getMarketMetrics(mode).find((entry) => entry.id === activeMetric);
  const ownIds = new Set((Array.isArray(ownedProviderIds) ? ownedProviderIds : ownId == null ? [] : [ownId]).map(String));
  const rentedIds = new Set((Array.isArray(rentedProviderIds) ? rentedProviderIds : []).map(String).filter(id => !ownIds.has(id)));
  const unavailableIds = new Set((Array.isArray(unavailableProviderIds) ? unavailableProviderIds : []).map(String));
  const projected = project(points, activeMetric, priceDomain);
  const { normalized, population, totalPrice, maxCompleted, yMin, yMax } = projected;
  const groups = visibleGroups(projected.groups, visibleProviderIds);
  if (!normalized.length) return '<div class="market-scatter-empty">暂无可比较机器</div>';

  const coordinate = (value) => value.toFixed(2);
  const nearbyIds = nearbyGroup(groups, selectedId).flatMap((group) => group.nodes.map((node) => node.id));
  // Keep personal machines visible where nearby prices overlap, without moving points.
  const paintPriority = (group) => group.nodes.some(node => node.id === selectedId) ? 3
    : group.nodes.some(node => ownIds.has(node.id)) ? 2
      : group.nodes.some(node => rentedIds.has(node.id)) ? 1 : 0;
  const dots = [...groups].sort((left, right) => paintPriority(left) - paintPriority(right)).map((group) => {
    const cx = coordinate(group.x);
    const cy = coordinate(group.y);
    const count = group.nodes.length;
    const ownCount = group.nodes.filter(node => ownIds.has(node.id)).length;
    const rentedCount = group.nodes.filter(node => rentedIds.has(node.id)).length;
    const peers = nearbyGroup(groups, group.nodes[0].id).flatMap((entry) => entry.nodes);
    const chosen = group.nodes.find((node) => node.id === selectedId) ?? group.nodes[0];
    const available = !unavailableIds.has(chosen.id);
    const label = `机器 ${group.nodes.map((node) => rentedIds.has(node.id) ? `${node.id}（我租用中）` : `${node.id}${ownIds.has(node.id) ? '（我的机器）' : ''}（${unavailableIds.has(node.id) ? '不可接单' : '可接单'}）`).join('、')}；报价 ${formatPrice(group.quote)} ETH/${unit}；${meta.label} ${meta.isRate ? displayRate(group.value) : `${group.value} 次`}${chosen.id === selectedId && !available && !rentedIds.has(chosen.id) ? `；当前选中 ${chosen.id}：当前不可接单` : ''}${count > 1 ? `；${count} 台机器同坐标` : ''}${peers.length > count ? `；附近共 ${peers.length} 台机器，可在侧卡切换` : count > 1 ? '，可在侧卡切换' : ''}`;
    const identity = ownIds.has(chosen.id) ? 'own' : rentedIds.has(chosen.id) ? 'rented' : 'other';
    const content = `<title>${escape(label)}</title><circle class="market-scatter-dot" cx="${cx}" cy="${cy}" r="8"/>${count > 1 ? `<text class="market-scatter-count" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">${count}</text>` : ''}`;
    const relativePrice = totalPrice > 0n ? (Number(group.amount * population * 10000n / totalPrice) / 100).toFixed(2) : '';
    const relativeCompleted = group.completed === null ? '' : (maxCompleted ? group.completed / maxCompleted * 100 : 0).toFixed(2);
    return `<a class="${classes('market-scatter-point', group.nodes, selectedId, ownIds, rentedIds, unavailableIds, nearbyIds)}" data-point-identity="${identity}" data-quote="${escape(group.quote)}" data-completed="${group.completed ?? ''}" data-node-count="${count}" data-relative-price="${relativePrice}" data-relative-completed="${relativeCompleted}" data-metric="${activeMetric}" data-metric-value="${group.value}" data-nearby-count="${peers.length}" data-node-id="${escape(chosen.id)}" data-owned-count="${ownCount}" data-rented-count="${rentedCount}" data-available="${available}" aria-label="${escape(label)}" href="${escape(nodeHref(chosen.id, activeMetric, taskType))}">${content}</a>`;
  }).join('');
  const horizontal = meta.isRate ? meta.label : `${meta.label} / 最高次数`;
  const yTicks = priceTicks(population, yMin, yMax).map(({ value, label, y }) =>
    `<g class="market-scatter-tick" data-axis="y" data-value="${escape(priceEth(value))}"><line x1="${PLOT.left - 5}" y1="${coordinate(y)}" x2="${PLOT.left}" y2="${coordinate(y)}"/><text x="${PLOT.left - 12}" y="${coordinate(y)}" text-anchor="end" dominant-baseline="middle">${escape(label)}</text></g>`).join('');
  const xTicks = [0, 25, 50, 75, 100].map(value => {
    const x = PLOT.left + value / 100 * (PLOT.right - PLOT.left);
    return `<g class="market-scatter-tick" data-axis="x" data-value="${value}%"><line x1="${coordinate(x)}" y1="${PLOT.bottom}" x2="${coordinate(x)}" y2="${PLOT.bottom + 5}"/><text x="${coordinate(x)}" y="269" text-anchor="middle">${value}%</text></g>`;
  }).join('');
  if (!groups.length && !Array.isArray(visibleProviderIds)) return `<div class="market-scatter-empty">暂无${meta.label}样本</div>`;
  const description = mode === 'checked'
    ? meta.isRate
      ? `纵轴是当前服务报价，单位ETH/${unit}；横轴${meta.label}为固定0至100%。${activeMetric === 'notFoundRate' ? '本类未找到项除以已提交项，不表示无解或造假。' : '本类主计算超时任务除以本类非取消已结算任务。'}仅统计该机器本类可见确认事件，不合并其他服务。`
      : `纵轴是当前服务报价，单位ETH/${unit}；横轴本类已提交结算次数以当前最高次数为基准。仅统计该机器本类可见确认事件，包含部分或全部未找到的交付。`
    : meta.isRate
      ? `纵轴是当前服务报价，单位ETH/${unit}；横轴${meta.label}为固定0至100%。分母是该机器本类非取消的已结算主计算任务，仅使用可见确认事件；失败含超时、主计算被否决、无多数及裁决中断，不含复核或裁决职责。`
      : `纵轴是当前服务报价，单位ETH/${unit}；横轴本类完成次数以当前最高主计算成功次数为基准，仅使用可见确认事件，包含经复核与未复核结算。完成次数不代表结果保证。`;
  const toggle = (key, label, className = '') => `<button class="market-legend-toggle" type="button" data-market-filter="${key}" aria-pressed="${visibility?.[key] !== false}"><i${className ? ` class="${className}"` : ''} aria-hidden="true"></i>${label}</button>`;
  const legend = `<div class="market-scatter-legend" aria-label="机器颜色">${toggle('own', '我的机器', 'is-own')}${toggle('rented', '我租用中', 'is-rented')}${toggle('other', '其他机器')}${toggle('unavailable', '浅色 · 暂不可用', 'is-unavailable')}</div>`;
  const empty = groups.length ? '' : `<text class="market-scatter-empty" x="${(PLOT.left + PLOT.right) / 2}" y="${(PLOT.top + PLOT.bottom) / 2}" text-anchor="middle">${projected.groups.length ? '已隐藏全部机器' : `暂无${meta.label}样本`}</text>`;
  return `<figure class="market-scatter" data-market-metric="${activeMetric}"><div class="market-scatter-viewport"><svg class="market-scatter-plot" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="group" aria-label="${meta.label}与机器报价散点图"><title>${description}同坐标合并，近邻保留真实位置并可在侧卡逐一选择。</title><path class="market-scatter-axis" d="M${PLOT.left} ${PLOT.top}V${PLOT.bottom}H${PLOT.right}"/><text class="market-scatter-axis-title" x="20" y="${(PLOT.top + PLOT.bottom) / 2}" text-anchor="middle" transform="rotate(-90 20 ${(PLOT.top + PLOT.bottom) / 2})">报价 · ETH / ${escape(unit)}</text>${yTicks}${xTicks}<text class="market-scatter-axis-title" x="${(PLOT.left + PLOT.right) / 2}" y="302" text-anchor="middle">${horizontal}</text>${dots}${empty}</svg></div><div class="market-scatter-footer">${legend}</div></figure>`;
}
