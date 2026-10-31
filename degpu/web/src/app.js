import { client } from './data-client.js';
import { services, getService, getProviderOffer } from './services.js';
import { renderMarketPage } from './market-view.js';
import { renderOverview } from './overview-view.js';
import { renderJobTimeline, formatJobOffset } from './job-timeline.js';
import { applyProviderBehavior, renderProviderPresentation } from './provider-presentation.js';
import { getProviderAvailability } from './provider-availability.js';
import { providerRole, providerLedger } from './roles.js';
import { parseBlenderFrames } from './blender-protocol.js';
import { renderBlockTransactions } from './chain-view.js';
import { renderWalletEntry, renderWalletAccount } from './wallet-view.js';
import { renderProviderSettings } from './provider-settings.js';
import { renderPublishPage, estimatePublish } from './publish-view.js';
import { renderLivePublish, readTaskInput, estimateTask } from './live-publish.js';
import { exactMoney, jobActions, renderParties, renderActivity, renderProviderRecord, roleLabel, providerIncome } from './parity-view.js';
import { ethToWei, weiToEth } from './network-client.js';
import { renderResultTable } from './result-details.js';

const content = document.getElementById('content');
const workspace = document.getElementById('workspace');
const toast = document.getElementById('toast');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const short = value => value?.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value || '—';
const money = exactMoney;
let state = client.getState();
const live = state.network.mode === 'live';
let busy = false;
let connecting = Boolean(client.connect);
let toastTimer;
let lastPage = '';
let presentation = false;
let walletTab = 'new';
let walletError = '';
let walletValues = {};
const loadedResults = new Set();
const resultErrors = new Map();
const loadingResults = new Set();
const jobRevisions = new Map();
const account = () => live ? state.unlocked ? state.account : null : state.account?.id ? state.account : null;
const same = (left, right) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());
const mine = provider => Boolean(account() && (provider.ownerId === account().id || same(provider.address, account().address)));
const ownProvider = () => state.providers.find(provider => mine(provider) && provider.id === route().params.get('machine')) || state.providers.find(mine);
const ownJob = job => Boolean(account() && (job.clientId === account().id || same(job.clientAddress, account().address)));
const involved = job => (live && Boolean(job.role)) || ownJob(job) || state.providers.filter(mine).some(provider => providerRole(job, provider.id));
const jobLink = (job, tab = 'run') => `#/jobs/${encodeURIComponent(typeof job === 'string' ? job : job.id)}/${tab}`;
const heading = (title, action = '') => `<div class="head"><h1>${title}</h1><div class="row">${action}</div></div>`;
const empty = text => `<div class="empty-state"><p>${esc(text)}</p></div>`;
const status = job => job.status || job.phase;

function route() {
  const [path, query = ''] = (location.hash.slice(2) || 'overview').split('?');
  const [page, id, tab] = path.split('/');
  return { page, id: id ? decodeURIComponent(id) : null, tab: tab || 'run', params: new URLSearchParams(query) };
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function act(fn, message) {
  if (busy) return;
  busy = true;
  content.setAttribute('aria-busy', 'true');
  try { await fn(); state = client.getState(); if (message) notify(message); }
  catch (error) { notify(error.message); }
  finally { busy = false; content.removeAttribute('aria-busy'); render(); }
}

function walletPage() {
  if (account()) return heading('我的账户') + renderWalletAccount(state, { live });
  return heading('连接钱包') + renderWalletEntry(state, { tab: walletTab, values: walletValues, error: walletError });
}

function paginate(entries, params, base, renderRows, label) {
  const pageSize = innerHeight >= 900 ? 8 : innerHeight >= 760 ? 6 : 4;
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(params.get('page')) || 1));
  const link = number => { const next = new URLSearchParams(params); next.set('page', number); return `${base}?${next}`; };
  return renderRows(entries.slice((page - 1) * pageSize, page * pageSize)) + (pages > 1 ? `<nav class="table-pagination" aria-label="${label}分页"><a class="btn${page === 1 ? ' disabled' : ''}" ${page > 1 ? `href="${esc(link(page - 1))}"` : 'aria-disabled="true"'}>上一页</a><span>${page} / ${pages}</span><a class="btn${page === pages ? ' disabled' : ''}" ${page < pages ? `href="${esc(link(page + 1))}"` : 'aria-disabled="true"'}>下一页</a></nav>` : '');
}

function jobTable(jobs, params = new URLSearchParams(), base = '#/jobs') {
  if (!jobs.length) return empty('暂无任务');
  return paginate(jobs, params, base, entries => `<div class="table-wrap"><table class="compact-jobs"><thead><tr><th>任务</th><th>服务</th><th>我的职责</th><th>工作量</th><th>预存 ETH</th><th>运行状态</th><th></th></tr></thead><tbody>${entries.map(job => `<tr><td class="mono">${esc(job.id)}</td><td>${esc(getService(job.taskType)?.name || job.taskType)}</td><td>${live ? roleLabel(job.role) : ownJob(job) ? '租赁者' : esc(state.providers.filter(mine).map(provider => providerRole(job, provider.id)).find(Boolean) || '提供方')}</td><td>${esc(job.itemCount)} ${getService(job.taskType)?.unit || '项'}</td><td>${money(job.deposit)}</td><td><span class="state-dot ${job.closed ? 'is-complete' : ''}"></span>${esc(status(job))}</td><td><a class="link" href="${jobLink(job)}">查看</a></td></tr>`).join('')}</tbody></table></div>`, '任务');
}

function jobsPage(params) {
  const filter = params.get('status') || 'running';
  const role = params.get('role') || 'all';
  const jobs = state.jobs.filter(involved).filter(job => role === 'all' || (role === 'bought' ? ownJob(job) : !ownJob(job)))
    .filter(job => filter === 'all' || (filter === 'closed' ? job.closed : !job.closed))
    .sort((a, b) => (b.createdBlock || 0) - (a.createdBlock || 0));
  return heading('任务情况', '<a class="btn primary" href="#/new">发布任务</a>') + `<section class="panel"><nav class="tabs" aria-label="任务角色">${[['all', '全部职责'], ['bought', '我发布的'], ['worked', '我参与计算的']].map(([value, label]) => `<a href="#/jobs?status=${filter}&amp;role=${value}"${role === value ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav><nav class="tabs" aria-label="任务状态">${[['running', '进行中'], ['closed', '已结束'], ['all', '全部']].map(([value, label]) => `<a href="#/jobs?status=${value}&amp;role=${role}"${filter === value ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${jobTable(jobs, params)}</section>`;
}

function resultView(job) {
  const results = job.results || [];
  if (live && !ownJob(job)) return empty('计算结果仅供任务客户解密读取');
  if (loadingResults.has(job.id)) return empty('正在读取结果…');
  if (live && !loadedResults.has(job.id)) return `<div class="empty-state"><p>${esc(resultErrors.get(job.id) || '正在读取结果…')}</p>${resultErrors.has(job.id) ? `<button class="btn" data-action="retry-results" data-id="${esc(job.id)}">重试</button>` : ''}</div>`;
  if (!results.length) return empty('提供方尚未交付可读取的结果');
  const file = job.compare === 'similar';
  return paginate(results, route().params, jobLink(job, 'results'), rows => renderResultTable(job, rows), '结果');
}

function settlementView(job) {
  const settlement = job.settlement;
  const rows = [['任务预存', job.deposit], ...(Number(job.disputeBond) > 0 ? [['争议保证金', job.disputeBond]] : [])];
  if (settlement) {
    rows.push(['主计算报酬', settlement.main]);
    if (job.mode !== 'checked') rows.push(['复核报酬', weiToEth(BigInt(ethToWei(settlement.verifierB || '0')) + BigInt(ethToWei(settlement.verifierC || '0')))]);
    if (Number(settlement.tiebreak) > 0) rows.push(['裁决报酬', settlement.tiebreak]);
    if (Number(settlement.slashed) > 0) rows.push(['罚没质押', settlement.slashed]);
    rows.push(['客户退款与罚没补偿', settlement.clientRefund ?? settlement.refund]);
  }
  return `<div class="settlement-grid">${rows.map(([name, value]) => `<div class="bill-row"><span>${name}</span><strong>${money(value)} ETH</strong></div>`).join('')}</div>${settlement ? `<div class="bill-row bill-total"><span>客户净变化（不含 Gas）</span><strong>${money(settlement.clientNet)} ETH</strong></div>` : `<p class="empty">${job.closed ? '暂无结算事件' : '等待结算'}</p>`}`;
}

function eventsView(job) {
  if (!job.events?.length) return empty('暂无已确认事件');
  return paginate([...job.events].reverse(), route().params, jobLink(job, 'events'), events => `<div class="table-wrap"><table><thead><tr><th>事件</th><th>距任务发布</th><th>区块</th><th>参数</th></tr></thead><tbody>${events.map(event => `<tr><td class="mono">${esc(event.name)}</td><td>${esc(formatJobOffset(job, event.timestamp ?? event.time, state))}</td><td>#${esc(event.blockNumber ?? event.block)}</td><td><details><summary>查看参数</summary><pre>${esc(JSON.stringify(event.args || {}, null, 2))}</pre></details></td></tr>`).join('')}</tbody></table></div>`, '事件');
}

function jobPage(id, tab) {
  const job = state.jobs.find(entry => entry.id === id);
  if (!job || !involved(job)) return heading('任务情况') + empty('未找到当前钱包参与的任务');
  const activeTab = ['results', 'money', 'events'].includes(tab) ? tab : 'run';
  const allowed = jobActions(job, ownJob(job));
  const actions = `<a class="btn" href="#/jobs">返回任务</a>${allowed.cancel ? `<button class="btn" data-action="cancel-job" data-id="${esc(job.id)}">取消任务</button>` : ''}${allowed.expire ? `<button class="btn" data-action="expire-job" data-id="${esc(job.id)}">${allowed.expireLabel}</button>` : ''}${!live && !job.closed && job.nextAction === 'advance' ? `<button class="btn primary" data-action="advance-job" data-id="${esc(job.id)}">${esc(job.actionLabel || '推进演示')}</button>` : ''}`;
  const body = activeTab === 'results' ? resultView(job) : activeTab === 'money' ? settlementView(job) : activeTab === 'events' ? eventsView(job) : renderJobTimeline(job, { blocks: state.blocks, transactions: state.transactions, timeSource: live ? 'chain' : 'simulation' });
  const deadlineOffset = formatJobOffset(job, job.deadline, state);
  const deadline = !job.closed && live && deadlineOffset !== '—'
    ? `<span>本阶段截止 · ${esc(deadlineOffset)}</span>` : '';
  return heading(`任务 ${esc(id)}`, actions) + `<div class="job-facts"><span>${esc(getService(job.taskType)?.name || job.taskType)}</span><span>${esc(job.itemCount)} ${getService(job.taskType)?.unit || '项'}</span><span title="${esc(job.provider)}">提供方 ${esc(short(job.provider))}</span>${deadline}<strong>${esc(status(job))}</strong></div><section class="panel job-detail-panel"><nav class="tabs" aria-label="任务详情">${[['run', '运行情况'], ['results', '计算结果'], ['money', '资金明细'], ['events', '确认事件']].map(([key, title]) => `<a href="${jobLink(job, key)}"${activeTab === key ? ' aria-current="page"' : ''}>${title}</a>`).join('')}</nav>${body}${live ? renderParties(job) : ''}</section>`;
}

function supplyPage() {
  if (!account()) return heading('提供机器') + `<section class="panel supply-connect"><h2>让空闲算力开始接单</h2><p>连接钱包，上架机器并设置三类任务报价。</p><a class="btn primary" href="#/account">连接钱包</a></section>`;
  const provider = ownProvider();
  const showingPresentation = live && provider && (presentation || provider.behavior !== 'honest');
  const toggle = live && provider ? `<button class="btn${showingPresentation ? ' primary' : ''}" data-action="toggle-presentation">${showingPresentation ? '退出演示并恢复正常' : '演示模式'}</button>` : '';
  const jobs = provider ? state.jobs.filter(job => providerRole(job, provider.id)) : [];
  const historicalIncome = provider ? providerLedger(state.jobs, provider).reduce((sum, row) => sum + row.income, 0) : 0;
  const income = live && provider ? providerIncome(state.jobs, provider.address) : historicalIncome;
  const stats = provider ? `<div class="stats supply-summary"><div class="stat"><p>当前质押</p><strong>${money(provider.stake)} <span>ETH</span></strong></div><div class="stat"><p>进行中</p><strong>${esc(provider.lockedJobs ?? 0)} <span>个任务</span></strong></div><div class="stat"><p>已确认任务收入</p><strong>${money(income)} <span>ETH</span></strong></div></div>` : '';
  return heading('提供机器', toggle) + stats + (showingPresentation ? renderProviderPresentation(provider) : '') + `<div class="supply-clean-layout">${renderProviderSettings(state, provider, { live })}<section class="panel supply-job-list"><div class="panel-head"><h2>接单记录</h2>${provider ? `<span class="${provider.active ? 'ok' : 'muted'}" title="Active 仅表示已注册且质押达标，不代表机器在线">${provider.active ? '质押达标' : '质押未达标'}</span>` : ''}</div>${jobTable(jobs.reverse(), route().params, '#/supply')}${live ? renderProviderRecord(provider) : ''}</section></div>`;
}

function chainPage() {
  if (!state.network.chainExplorer && live) return heading('确认记录') + `<section class="panel">${state.jobs.filter(involved).length ? state.jobs.filter(involved).map(job => `<div class="bill-row"><a href="${jobLink(job, 'events')}">${esc(job.id)}</a><span>${esc(status(job))}</span></div>`).join('') : empty('暂无任务确认记录')}</section>`;
  const block = state.blocks.at(-1);
  return heading('最近区块') + `<section class="panel">${block ? renderBlockTransactions(block, state, { canViewTransaction: () => true }) : empty('暂无区块')}</section>`;
}

function render() {
  const current = route();
  const oldScroll = workspace.scrollTop;
  const key = `${current.page}/${current.id || ''}/${current.tab}`;
  const editing = content.contains(document.activeElement) && document.activeElement.closest('form');
  if (busy || editing) return;
  const isPrivate = ['jobs', 'new'].includes(current.page);
  const views = {
    overview: () => heading('首页概览') + renderOverview(state),
    providers: () => heading('市场行情') + `<div id="market-page">${renderMarketPage(state, { account: account(), ownedProviderIds: state.providers.filter(mine).map(item => item.id), taskType: current.params.get('type'), sort: current.params.get('sort') || 'id-asc', query: current.params.get('q') || '', ownership: 'all' })}</div>`,
    jobs: () => current.id ? jobPage(current.id, current.tab) : jobsPage(current.params),
    supply: supplyPage, new: () => live ? renderLivePublish(state, current.params) : renderPublishPage(state, current.params, { live, account: account(), mine }), activity: () => renderActivity(state), account: walletPage, login: walletPage, register: walletPage, chain: chainPage,
  };
  content.innerHTML = live && connecting && !state.network.connected
    ? heading('正在连接') + empty('正在读取本机服务…')
    : isPrivate && !account() ? walletPage() : (views[current.page] || views.overview)();
  if (!state.network.connected && live && !connecting) content.insertAdjacentHTML('afterbegin', `<div class="connection-notice" role="status"><span>${esc(state.network.connectionError || '本机 DeGPU 服务未连接')}</span><button class="link" data-action="reconnect">重试连接</button></div>`);
  else if (live && state.network.connectionError) content.insertAdjacentHTML('afterbegin', `<div class="connection-notice" role="status">${esc(state.network.connectionError)}</div>`);
  document.getElementById('backend-status').textContent = live ? !state.network.connected ? connecting ? '正在连接…' : '服务未连接' : state.unlocked ? '网络已连接' : '等待加入网络' : '演示模式';
  document.getElementById('backend-status').className = `backend-status ${state.network.connected || !live ? 'ok' : 'danger'}`;
  document.getElementById('account-name').textContent = account() ? state.network.walletName || '我的账户' : '连接钱包';
  document.getElementById('chain-height').textContent = state.network.chainId ? `Chain ${state.network.chainId}` : 'DeGPU Network';
  document.getElementById('topbar-machine').hidden = true;
  document.querySelectorAll('[data-nav]').forEach(link => link.toggleAttribute('aria-current', link.dataset.nav === current.page));
  document.querySelector('[data-nav][aria-current]')?.setAttribute('aria-current', 'page');
  content.dataset.page = current.page;
  document.title = `${content.querySelector('h1')?.textContent || 'DeGPU'} · DeGPU`;
  workspace.scrollTop = key !== lastPage ? 0 : oldScroll;
  lastPage = key;
  if (current.page === 'jobs' && current.id && current.tab === 'results' && live && !loadedResults.has(current.id) && !loadingResults.has(current.id) && !resultErrors.has(current.id)) {
    const job = state.jobs.find(job => job.id === current.id);
    if (job && ownJob(job)) readResults(current.id);
  }
}

async function readResults(id) {
  if (!client.getResults) return;
  loadingResults.add(id);
  try { await client.getResults(id); state = client.getState(); }
  catch (error) { resultErrors.set(id, error.message); }
  finally { loadingResults.delete(id); if (!resultErrors.has(id)) loadedResults.add(id); }
  render();
}

function updateDeposit() {
  const form = document.getElementById('new-job-form');
  if (!form) return;
  const values = new FormData(form);
  if (live) {
    const task = state.taskTypes.find(t => t.id === values.get('taskType'));
    const selected = state.providers.find(p => p.id === values.get('provider'));
    const estimate = estimateTask(task, readTaskInput(task, values), selected, account()?.balance);
    document.getElementById('deposit-preview').textContent = `${estimate.upperBound ? '最多预存' : '预存'} ${estimate.deposit ?? '取决于输入'}${estimate.deposit == null ? '' : ' ETH'}`;
    form.querySelector('[type="submit"]').disabled = !selected || !estimate.valid || !estimate.sufficient;
    form.querySelector('#publish-validation').textContent = !selected ? '当前没有提供此任务的可用机器。' : !estimate.valid ? estimate.error : !estimate.sufficient ? '余额不足以支付预存。' : '';
    const capacity = form.querySelector('#publish-capacity');
    if (capacity) capacity.hidden = task.mode !== 'replicated' || values.get('verify') !== 'true';
    return;
  }
  const task = getService(values.get('taskType'));
  const selected = state.providers.find(provider => provider.id === values.get('provider'));
  const items = Number(values.get('itemCount'));
  const estimate = estimatePublish(task.id, { count: items, impossible: Number(values.get('impossible') || 0), quote: getProviderOffer(selected, task.id) || '0', balance: account()?.balance || '0' });
  document.getElementById('deposit-preview').textContent = `预存 ${estimate.deposit || '—'} ETH${task.mode === 'checked' ? ` · 共 ${estimate.total} 项` : ''}`;
  const mismatch = state.taskTypes.find(type => type.id === task.id)?.code_matches === false;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = !selected || !estimate.valid || !estimate.sufficient || mismatch;
  const validation = form.querySelector('#publish-validation');
  if (validation) validation.textContent = !selected ? '当前没有提供此任务的可用机器。' : mismatch ? '任务代码与网络版本不一致，请先更新。' : !estimate.valid ? '总工作量须为 1–1000 项。' : !estimate.sufficient ? '余额不足以支付预存。' : '';
  const capacity = form.querySelector('#publish-capacity');
  if (capacity) capacity.hidden = task.mode === 'checked' || values.get('verify') !== 'true';
}

content.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || busy) return;
  const action = button.dataset.action;
  if (action === 'toggle-presentation') {
    const provider = ownProvider();
    if (!live || !provider) return;
    if (presentation || provider.behavior !== 'honest') {
      act(async () => { await applyProviderBehavior(client, ownProvider(), 'honest', { exit: true }); presentation = false; }, '已恢复正常计算');
    } else { presentation = true; document.activeElement?.blur(); render(); }
    return;
  }
  if (action === 'provider-behavior') { act(() => applyProviderBehavior(client, ownProvider(), button.dataset.behavior), '真实接单行为已生效'); return; }
  if (action === 'wallet-tab') { walletTab = button.dataset.tab; walletError = ''; walletValues = {}; render(); return; }
  if (action === 'reconnect') { act(() => client.connect?.()); return; }
  if (action === 'lock-wallet') { act(async () => { await client.lockWallet(); loadedResults.clear(); resultErrors.clear(); }, '钱包已锁定'); return; }
  if (action === 'copy-address') { act(() => navigator.clipboard.writeText(account().address), '地址已复制'); return; }
  if (action === 'faucet') { act(() => client.claimFaucet(), '已领取测试 ETH'); return; }
  if (action === 'serve') {
    act(async () => {
      const provider = ownProvider();
      if (!live) { await client.setProviderListing({ providerId: provider.id, enabled: !provider.listed, accountId: account().id }); return; }
      await client.setProviderServing({ providerId: provider.id, on: !provider.autoProcess });
    }, '接单设置已更新'); return;
  }
  if (action === 'stop-offering') { act(() => client.setProviderListing({ providerId: ownProvider().id, enabled: false }), '所有报价已设为零'); return; }
  if (action === 'retry-results') { resultErrors.delete(button.dataset.id); readResults(button.dataset.id); return; }
  if (action === 'cancel-job') act(() => client.cancelJob(button.dataset.id, account().id), '任务已取消');
  if (action === 'expire-job') act(() => client.expireJob(button.dataset.id), '超时已处理');
  if (action === 'advance-job') act(() => client.advanceJob(button.dataset.id), '演示已推进');
});

content.addEventListener('change', event => {
  if (event.target.id === 'market-service-select') { const params = route().params; params.set('type', event.target.value); location.hash = `/providers?${params}`; return; }
  if (event.target.id === 'task-type') { location.hash = `/new?type=${encodeURIComponent(event.target.value)}`; return; }
  if (event.target.id === 'image-files') {
    const images = [...event.target.files];
    event.target.setCustomValidity(images.some(file => !file.name.endsWith('.jpg')) ? '请选择扩展名为 .jpg 的图片。' : '');
    document.getElementById('item-count').value = images.filter(file => file.name.endsWith('.jpg')).length || 1;
    event.target.reportValidity();
  }
  if (event.target.id === 'frame-spec') { try { document.getElementById('item-count').value = parseBlenderFrames(event.target.value).length; } catch { /* Validate at submit. */ } }
  updateDeposit();
});
content.addEventListener('input', event => { if (event.target.closest('#new-job-form')) updateDeposit(); });

content.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  if (busy) return;
  const values = new FormData(form);
  if (form.id === 'market-search-form') { const params = route().params; params.set('q', values.get('q') || ''); location.hash = `/providers?${params}`; return; }
  if (form.id === 'wallet-join-form') {
    busy = true;
    form.querySelector('[type="submit"]').disabled = true;
    walletValues = { name: values.get('name'), network: values.get('network') };
    try {
      const name = String(values.get('name')).trim();
      const password = String(values.get('password'));
      const network = String(values.get('network')).trim();
      if (walletTab !== 'unlock') {
        if (password !== values.get('repeat')) throw new Error('两次输入的密码不一致。');
        await client.createWallet({ name, password, ...(walletTab === 'import' ? { private_key: String(values.get('private_key')).trim() } : {}) });
        walletTab = 'unlock';
      }
      await client.unlockWallet({ name, password, network });
      state = client.getState(); walletError = ''; walletValues = {}; location.hash = '/account';
      notify('已加入网络');
    } catch (error) { walletError = error.message; state = client.getState(); }
    finally { busy = false; document.activeElement?.blur(); render(); }
    return;
  }
  if (form.id === 'provider-offers-form' || form.id === 'machine-onboarding-form') {
    const offers = Object.fromEntries((live ? state.taskTypes : services).map(task => [task.id, values.has(`enabled.${task.id}`) ? String(values.get(`offers.${task.id}`)) : '0']));
    document.activeElement?.blur();
    await act(async () => {
      if (form.id === 'machine-onboarding-form') {
        await client.registerMachine({ offers, stake: String(values.get('stake') || '1'), accountId: account().id });
        state = client.getState();
        // Upstream registration starts serving after the stake transaction.
        if (live) await client.setProviderServing({ on: true });
      } else await client.updateProviderOffers({ providerId: ownProvider().id, accountId: account().id, offers });
    }, '机器设置已保存');
    return;
  }
  if (form.id === 'stake-form') {
    document.activeElement?.blur();
    await act(() => values.get('operation') === 'withdraw' ? client.withdrawStake({ amount: values.get('amount') }) : client.addStake({ amount: values.get('amount') }), '质押已更新');
    return;
  }
  if (form.id !== 'new-job-form') return;
  busy = true;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true; button.textContent = '正在提交…';
  try {
    if (live) {
      const task = state.taskTypes.find(t => t.id === values.get('taskType'));
      const input = readTaskInput(task, values);
      const id = await client.createJob({ taskType: task.id, provider: values.get('provider'), verify: values.get('verify') === 'true', ...input });
      state = client.getState(); document.activeElement?.blur(); location.hash = `/jobs/${encodeURIComponent(id)}/run`; notify('任务已发布');
      return;
    }
    const task = getService(values.get('taskType'));
    const rendering = task.compare === 'similar';
    if (task.id === 'image-classify-v1' && values.getAll('images').some(file => !file.name?.endsWith('.jpg'))) throw new Error('请选择扩展名为 .jpg 的图片。');
    const fields = task.mode === 'checked' ? { keys: Number(values.get('itemCount')), bits: Number(values.get('bits')), impossible: Number(values.get('impossible')) } : rendering ? { frames: String(values.get('frames')) } : { limit: Number(values.get('itemCount')) };
    const itemCount = rendering ? parseBlenderFrames(fields.frames).length : Number(values.get('itemCount')) + (task.mode === 'checked' ? Number(fields.impossible) : 0);
    const id = await client.createJob({ taskType: task.id, provider: values.get('provider'), clientId: account().id, itemCount, verify: values.get('verify') === 'true', fields, files: { ...(rendering ? { scene: values.get('scene') } : task.mode === 'checked' ? {} : { model: values.get('model'), images: values.getAll('images') }) }, sampleInputs: !live, scenario: task.mode === 'checked' ? 'checked-success' : values.get('verify') === 'true' ? 'verified' : 'unverified' });
    state = client.getState(); location.hash = `/jobs/${encodeURIComponent(id)}/run`; notify('任务已发布');
  } catch (error) { const target = form.querySelector('#form-error'); target.textContent = error.message; target.hidden = false; button.disabled = false; button.textContent = '发布任务'; }
  finally { busy = false; if (location.hash.includes('/jobs/')) render(); }
});

window.addEventListener('hashchange', () => { document.activeElement?.blur(); render(); });
client.subscribe(() => {
  const next = client.getState();
  if (next.account?.id !== state.account?.id) { loadedResults.clear(); resultErrors.clear(); jobRevisions.clear(); presentation = false; }
  state = next;
  for (const job of state.jobs) {
    const revision = `${job.phase}/${job.closed}/${job.events?.length}`;
    if (jobRevisions.get(job.id) !== revision) { loadedResults.delete(job.id); resultErrors.delete(job.id); jobRevisions.set(job.id, revision); }
  }
  render();
});
render();
if (client.connect) { try { await client.connect(); state = client.getState(); walletTab = state.wallets?.length ? 'unlock' : 'new'; } catch { state = client.getState(); } finally { connecting = false; render(); } }
