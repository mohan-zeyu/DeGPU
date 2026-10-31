import { ethToWei, weiToEth } from './network-client.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const exactMoney = value => {
  try { const text = String(value ?? '0'); return text.startsWith('-') ? `-${weiToEth(ethToWei(text.slice(1)))}` : weiToEth(ethToWei(text)); }
  catch { return '—'; }
};
export const roleLabel = role => ({ client: '租赁者', main: '提供方', verifier: '复核方', tiebreaker: '裁决方' })[role] || '参与者';
export function providerIncome(jobs, address) {
  const same = value => value && address && value.toLowerCase() === address.toLowerCase();
  return weiToEth(jobs.filter(j => j.role !== 'client' && !same(j.clientAddress || j.client))
    .flatMap(j => j.events || []).filter(e => e.name === 'Payout' && same(e.args?.to))
    .reduce((sum, e) => sum + BigInt(e.args.amount || '0'), 0n));
}
export function jobActions(job, isClient) {
  const unknownClock = job.chainClockKnown === false && Number(job.deadline) > 0;
  return { cancel: !job.closed && job.phase === 'Open' && (isClient || job.deadlinePassed),
    expire: !job.closed && (job.deadlinePassed || unknownClock),
    expireLabel: job.deadlinePassed ? '处理超时' : '检查并处理超时' };
}
export function renderParties(job) {
  const states = { assigned: '已分配', shared: '已分享输入', committed: '已提交承诺', revealed: '已公开结果', no_share: '客户未分享', bad_input: '输入有误', missed: '超时', outvoted: '已被否决' };
  const row = (label, address, extra = '') => `<div><dt>${label}</dt><dd class="mono">${esc(address || '—')}${extra}</dd></div>`;
  const verifiers = job.verifierDetails || [];
  const note = job.verify ? '已选择复核；请以各复核方状态和最终结算为准。'
    : job.dropped === 'client_no_reveal' ? '未复核：客户没有及时公开决定。'
      : job.dropped === 'no_eligible_verifier' ? '未复核：符合条件的复核方不足。'
        : job.decided ? '客户选择不复核，未使用的复核预存将退回。' : '复核决定仍保密，等待主计算提交承诺。';
  return `<details class="supporting-details"><summary>参与方与复核详情</summary><dl class="facts">
    ${row('客户', job.clientAddress)}${row('主计算', job.provider)}
    ${verifiers.map((v, i) => row(`复核方 ${i + 1}`, v.address, `<span> · ${esc(states[v.state] || v.state)} · 项目 ${esc(v.items?.[0])}–${esc(v.items?.[1] - 1)}</span>`)).join('')}
    ${job.tieProvider ? row('裁决方', job.tieProvider) : ''}</dl>${job.mode === 'replicated' ? `<p>${note}</p>` : ''}${job.disputedItems?.length ? `<p>争议项目：${esc(job.disputedItems.join(', '))}</p>` : ''}</details>`;
}
export function renderActivity(state) {
  return `<div class="head"><h1>活动日志</h1></div><section class="panel"><p class="muted">本机 app 的操作和后台执行记录，最多保留最近 1000 条。</p><div class="table-wrap"><table><thead><tr><th>序号</th><th>记录</th></tr></thead><tbody>${[...(state.activity || [])].reverse().map(line => `<tr><td>${esc(line.seq)}</td><td>${esc(line.message)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
export function renderProviderRecord(provider) {
  const labels = { verified_completed: '经复核完成', unverified_completed: '未复核完成', missed: '主计算超时', outvoted: '主计算被否决', checks_completed: '复核／裁决完成', checks_missed: '复核／裁决超时', checks_outvoted: '复核被否决', completed: '已提交结算', items_solved: '找到项数', items_not_found: '未找到项数' };
  return `<details class="supporting-details"><summary>链上信誉记录</summary>${Object.entries(provider?.record || {}).map(([mode, counters]) => `<h3>${mode === 'checked' ? '合约检验任务' : '重复计算任务'}</h3><dl class="facts">${Object.entries(counters).map(([key, value]) => `<div><dt>${esc(labels[key] || key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`).join('')}</details>`;
}
