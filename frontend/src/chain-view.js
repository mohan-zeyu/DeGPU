const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const eventArgs = event => event?.args && typeof event.args === 'object' ? event.args : {};
const eventsOf = tx => Array.isArray(tx?.events) ? tx.events : [];
const addressEquals = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.length > 0 && right.length > 0 && left.toLowerCase() === right.toLowerCase();
const jobIdOf = tx => tx?.jobId === null ? null : String(tx?.jobId || '未知');
const publicType = method => ({
  deploy: '合约部署', register: '提供方登记', setPrice: '调整报价',
  addMarket: '登记市场', addTaskType: '登记任务类型', transfer: '转账',
}[method] || '链上交易');

function sortedTransactions(transactions) {
  return [...(Array.isArray(transactions) ? transactions : [])]
    .sort((left, right) => (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0));
}

function visible(tx, options) {
  const jobId = jobIdOf(tx);
  // Transactions without an associated job are public contract/network activity.
  // A task-linked transaction remains private unless the caller grants access.
  return jobId === null || Boolean(options.mayView?.(tx));
}

function safeTime(timestamp, options) {
  return esc(typeof options.time === 'function' ? options.time(timestamp) : '—');
}

function safeHash(hash, options) {
  return esc(typeof options.shortHash === 'function' ? options.shortHash(hash) : hash || '—');
}

function taskReference(tx, options) {
  const jobId = jobIdOf(tx);
  if (jobId === null) return '—';
  if (jobId === '未知') return '任务编号未知';
  const href = typeof options.jobHref === 'function' ? options.jobHref(jobId) : `#/jobs/${encodeURIComponent(jobId)}/flow`;
  return `<a class="link" href="${esc(href)}">#${esc(jobId)}</a>`;
}

function transactionCardTitle(tx) {
  const jobId = jobIdOf(tx);
  return jobId === null ? publicType(tx.method) : `任务 #${jobId}`;
}

export function renderBlockTransactions(block, state, options = {}) {
  const hashes = Array.isArray(block?.transactions) ? block.transactions : [];
  const transactions = sortedTransactions(hashes
    .map(hash => (state?.transactions || []).find(tx => tx.hash === hash))
    .filter(Boolean));
  const cards = transactions.map((tx, index) => {
    const canView = visible(tx, options);
    const title = transactionCardTitle(tx);
    const method = canView ? `${esc(tx.method)}()` : '';
    const hash = canView ? safeHash(tx.hash, options) : '';
    const accessibleTitle = canView && jobIdOf(tx) === null ? `${title}，${tx.method}` : title;
    return `<button type="button" class="transaction-card" data-action="transaction" data-hash="${esc(canView ? tx.hash : '')}" aria-label="第 ${index + 1} 笔交易，${esc(accessibleTitle)}"${canView ? '' : ' disabled'}><span>${index + 1} · ${esc(title)}</span><span class="mono">${method}</span><span class="mono muted">${hash}</span></button>`;
  }).join('');
  return `<div class="block-transactions"><h3>区块内交易 · ${transactions.length} 笔</h3>${transactions.length
    ? `<div class="transaction-cards">${cards}</div>`
    : '<p class="empty">该区块没有交易。</p>'}</div>`;
}

export function renderTransactionRows(transactions, options = {}) {
  return sortedTransactions(transactions).map(tx => {
    const jobId = jobIdOf(tx);
    if (!visible(tx, options)) {
      return `<tr><td colspan="5">—</td><td>任务 #${esc(jobId)}</td><td>—</td></tr>`;
    }
    const selected = tx.hash === options.selectedHash ? ' selected' : '';
    return `<tr class="${selected.trim()}"><td>${esc(tx.transactionIndex ?? 0)}</td><td><button type="button" class="link mono" data-action="transaction" data-hash="${esc(tx.hash)}" aria-label="查看交易 ${safeHash(tx.hash, options)}">${safeHash(tx.hash, options)}</button></td><td>${safeTime(tx.timestamp, options)}</td><td><button type="button" class="link mono" data-action="transaction" data-hash="${esc(tx.hash)}">${esc(tx.method)} <span class="muted">(${esc(publicType(tx.method))})</span></button></td><td><a class="link" href="#/chain?block=${encodeURIComponent(String(tx.blockNumber ?? ''))}">#${esc(tx.blockNumber ?? '—')}</a></td><td>${taskReference(tx, options)}</td><td class="${Number(tx.status) === 1 ? 'ok' : 'danger'}">${Number(tx.status) === 1 ? '成功' : '失败'}</td></tr>`;
  }).join('');
}

function contractTarget(tx, state) {
  const network = state?.network || {};
  const address = tx?.method === 'deploy' || !tx?.to ? tx?.contractAddress : tx?.to;
  const registry = network.registryAddress;
  const markets = network.markets || {};
  const replicated = markets.replicated || network.marketAddress;
  const checked = markets.checked;
  let name = '合约';
  if (addressEquals(address, registry)) name = 'ProviderRegistry';
  else if (addressEquals(address, replicated)) name = 'ReplicatedMarket';
  else if (addressEquals(address, checked)) name = 'CheckedMarket';
  else if (addressEquals(address, tx?.mode === 'checked' ? checked : replicated) && tx?.mode) {
    name = tx.mode === 'checked' ? 'CheckedMarket' : 'ReplicatedMarket';
  } else if (!address && !tx?.to && !tx?.contractAddress) name = '部署目标未知';
  return { address, name };
}

function valueHtml(value) {
  if (Array.isArray(value)) {
    return `<details><summary>${value.length} 项 · 展开查看</summary><ol class="value-list">${value.map(item => `<li>${esc(typeof item === 'object' ? JSON.stringify(item) : item)}</li>`).join('')}</ol></details>`;
  }
  return esc(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
}

function unitForEventField(key) {
  return ['amount', 'stake', 'newStake', 'pricePerItem'].includes(key) ? ' <span class="muted">wei</span>' : '';
}

export function renderTransactionDetail(tx, state, options = {}) {
  if (!tx) return '';
  const jobId = jobIdOf(tx);
  const job = jobId === null ? null : (state?.jobs || []).find(entry => entry.id === jobId);
  if (jobId !== null && (!job || !options.mayView?.(tx))) {
    const taskReference = jobId === '未知' ? '任务编号未知' : `#${jobId}`;
    const href = typeof options.jobHref === 'function' ? options.jobHref(jobId) : `#/jobs/${encodeURIComponent(jobId)}/flow`;
    return `<section class="panel" id="transaction-detail" aria-label="交易详情"><h2>关联任务</h2><p class="supporting-details">${jobId === '未知' ? taskReference : `<a class="link" href="${esc(href)}">${taskReference}</a>`}</p><p class="note">任务详情仅对参与方开放。</p></section>`;
  }

  const target = contractTarget(tx, state);
  const argsFor = event => job && typeof options.visibleEventArgs === 'function'
    ? (options.visibleEventArgs(job, event) || {}) : eventArgs(event);
  const logs = eventsOf(tx).map(event => {
    const args = argsFor(event);
    const fields = Object.entries(args).map(([key, value]) => `<div><dt class="mono">${esc(key)}${unitForEventField(key)}</dt><dd class="mono">${valueHtml(value)}</dd></div>`).join('');
    return `<div class="log-entry"><p class="mono">${esc(event.name)} <span class="muted">· logIndex ${esc(event.logIndex ?? '—')}</span></p>${fields ? `<dl class="facts">${fields}</dl>` : ''}</div>`;
  }).join('');
  const association = jobId === null ? '' : `<div><dt>关联任务</dt><dd>${taskReference(tx, options)}</dd></div>`;
  const targetAddress = target.address ? `<span class="mono address">${esc(target.address)}</span>` : '';
  return `<section class="panel" id="transaction-detail" aria-label="交易详情"><div class="panel-head"><h2>交易详情</h2><span class="${Number(tx.status) === 1 ? 'ok' : 'danger'} small">${Number(tx.status) === 1 ? '执行成功' : '执行失败'}</span></div><p class="mono fullhash">${esc(tx.hash)}</p><dl class="facts"><div><dt>区块／时间</dt><dd>#${esc(tx.blockNumber ?? '—')} · ${safeTime(tx.timestamp, options)}</dd></div><div><dt>区块内序号</dt><dd>${esc(tx.transactionIndex ?? 0)}</dd></div><div><dt>发起账户</dt><dd class="mono">${esc(tx.from || '—')}</dd></div><div><dt>目标合约</dt><dd>${esc(target.name)}${targetAddress}</dd></div><div><dt>调用方法</dt><dd class="mono">${esc(tx.method)}()</dd></div><div><dt>Gas 用量</dt><dd>${Number(tx.gasUsed || 0).toLocaleString('zh-CN')}</dd></div>${association}</dl><div class="log-section"><h3>事件日志 · ${eventsOf(tx).length} 条</h3>${logs || '<p class="muted">没有事件日志。</p>'}</div></section>`;
}
