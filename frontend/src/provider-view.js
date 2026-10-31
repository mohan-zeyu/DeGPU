import { getService } from './services.js';
import { formatPrice } from './market-scatter.js';
import { publicJobReference } from './access.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const count = value => value == null ? '—' : esc(value);
const stake = value => value == null ? '—' : `${esc(formatPrice(value))} ETH`;
const rate = value => typeof value !== 'number' || !Number.isFinite(value) ? '—'
  : value > 0 && value < 0.1 ? '<0.1%' : `${Number(value.toFixed(1))}%`;

// Explicit scalar projections exclude inputs, keys, credentials and telemetry.
export function renderProviderProfile(stats, { taskType = stats.taskType ?? 'image-classify-v1' } = {}) {
  const service = getService(taskType);
  const checked = service?.mode === 'checked';
  const unit = service?.unit ?? '项';
  const metric = (label, value, title = '') => `<div class="stat"><p${title ? ` title="${esc(title)}"` : ''}>${label}</p><strong>${count(value)}</strong></div>`;
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const price = stats.quote == null ? '—' : `${esc(formatPrice(stats.quote))} ETH / ${esc(unit)}`;
  const completionCards = checked
    ? metric('已提交结算', stats.completed, '本类可见确认历史中，该机器主计算已提交结算任务；部分或全部未找到也计数。')
      + metric('超时比例', rate(stats.timeoutRate), '本类主计算超时任务 ÷ 本类非取消的已结算主计算任务。')
      + metric('未找到占比', rate(stats.notFoundRate), '本类未找到项 ÷（找到项＋未找到项）；不证明无解或造假。')
    : metric('成功完成', stats.completed, `本类可见确认历史中，该机器主计算成功交付次数，不含复核或裁决职责。${service?.compare === 'similar' ? '包括渲染验收及争议驳回后的成功交付。' : ''}`)
      + metric('超时比例', rate(stats.timeoutRate), '本类主计算超时任务 ÷ 本类非取消的已结算主计算任务。')
      + metric('否决比例', rate(stats.outvotedRate), '本类主计算被否决任务 ÷ 本类非取消的已结算主计算任务，含双方被否决。');
  const detail = checked
    ? `<details class="supporting-details"><summary>本类可见记录</summary><dl class="facts provider-facts">${fact('找到项数', count(stats.itemsSolved))}${fact('未找到项数', count(stats.itemsNotFound))}${fact('超时任务', count(stats.missed))}${fact('失败比例', esc(rate(stats.failureRate)))}</dl></details>`
    : `<details class="supporting-details"><summary>本类可见记录</summary><dl class="facts provider-facts">${fact('经复核完成', count(stats.verified))}${fact('未复核结算', `<span title="本类已结算但未获得完整复核确认。">${count(stats.unverified)}</span>`)}${fact('主计算超时', count(stats.missed))}${fact('主计算被否决', count(stats.outvoted))}${fact('失败比例', esc(rate(stats.failureRate)))}</dl></details>`;
  const history = stats.history.slice(0, 10).map(publicJobReference).filter(job => job.id !== null);
  const historyView = history.length
    ? `<div class="row" aria-label="任务编号">${history.map(job => `<a class="link mono" href="#/jobs/${encodeURIComponent(job.id)}/events">${esc(job.id)}</a>`).join('')}</div>`
    : '<p class="empty">暂无公开任务记录。</p>';
  return `<div class="stats provider-completions">${completionCards}</div><section class="panel" aria-label="提供方公开资料"><div class="panel-head"><h2>公开资料 · ${esc(service?.name ?? taskType)}</h2><span class="${stats.active === true ? 'ok' : 'warn'}">${stats.active === true ? '质押达标' : stats.active === false ? '暂不可参与' : '资格未知'}</span></div><dl class="facts provider-facts">${fact('提供方地址', `<span class="mono">${esc(stats.address || '—')}</span>`)}${fact('当前报价', price)}${fact('当前质押', stake(stats.stake))}${fact('跨市场任务锁定', `${count(stats.lockedJobs)} 个`)}</dl>${detail}</section><section class="panel" aria-label="提供方公开任务记录"><div class="panel-head"><h2>最近任务</h2><span class="muted">${Math.min(stats.history.length, 10)} 条</span></div>${historyView}</section>`;
}
