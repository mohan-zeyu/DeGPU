import { getService } from './services.js';

const uiText = value => String(value ?? '').replaceAll('主节点', '提供方').replaceAll('复核节点', '复核方').replaceAll('裁决节点', '裁决方');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const labels = { waiting: '等待计算', computing: '计算中', ready: '待提交', submitted: '已提交', offline: '计算中断', stopped: '已停止' };
const roles = { main: '提供方', verifier: '复核方', tiebreak: '裁决方' };
const assignments = job => job ? [job.main, ...(job.verifiers ?? []), job.tiebreak].filter(Boolean) : [];

function progressRow(entry, unit) {
  const interrupted = ['offline', 'stopped'].includes(entry.status);
  return `<div class="compute-row${interrupted ? ' interrupted' : ''}"><div class="row spread"><span>${roles[entry.role]} · 机器 ${esc(entry.providerId)}</span><span class="${interrupted ? 'danger' : 'muted'}">${labels[entry.status]}</span></div><div class="progress-line"><div class="progress-track" role="progressbar" aria-label="机器 ${esc(entry.providerId)} · ${roles[entry.role]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${entry.percent}" aria-valuetext="${entry.completed}/${entry.total}，${labels[entry.status]}"><span style="width:${entry.percent}%"></span></div><strong>${entry.percent}%</strong><span class="work-count">${entry.completed} / ${entry.total} ${esc(unit)}</span></div></div>`;
}

export function renderComputeProgress(job, snapshot, { providerId, compact = false, role = 'client' } = {}) {
  if (snapshot.source === 'live' && !snapshot.jobs.some(entry => entry.jobId === job.id)) {
    return `<div class="chain-progress"><span>链上 · ${esc(uiText(job.status))}</span>${job.closed ? '<span>已确认结算</span>' : ''}</div>`;
  }
  const service = getService(job.taskType);
  const unit = service?.unit ?? '项';
  const similar = service?.compare === 'similar';
  const monitored = snapshot.jobs.find(entry => entry.jobId === job.id);
  let work = assignments(monitored);
  if (providerId) work = work.filter(entry => entry.providerId === providerId);
  else if (compact) work = work.slice(0, 1);
  const found = (job.events ?? []).find(entry => entry.name === 'ResultsSubmitted')?.args?.found;
  const solved = Array.isArray(found) ? found.filter(value => value === true).length : null;
  const published = (job.events ?? []).some(entry => entry.name === 'ResultsPublished');
  const providerCoverage = !job.closed ? '监管待确认'
    : job.verifiers?.length ? `监管公开 ${job.coverage || 0} / ${job.itemCount} ${unit}`
      : job.outcome === 'Delivered' && published ? '监管通过' : '监管未完成';
  const coverage = job.mode === 'checked'
    ? solved === null ? job.closed ? '没有已验证结果' : '提交后由合约检验答案' : `有效答案 ${solved} / ${job.itemCount} 项 · 未找到 ${Math.max(0, job.itemCount - solved)} 项`
    : role === 'provider' ? providerCoverage
      : similar && job.phase === 'Disputing' ? '待验收 · 帧图相似度由链下比对'
        : job.verify ? `复核公开 ${job.coverage || 0} / ${job.itemCount} ${unit}` : '不要求复核';
  return `<div class="compute-progress" style="--workers:${Math.max(1, Math.min(3, work.length))}">${work.map(entry => progressRow(entry, unit)).join('')}<div class="chain-progress"><span>链上 · ${esc(uiText(job.status))}</span><span>${esc(coverage)}</span></div></div>`;
}

function usageChart(provider) {
  const history = provider.history ?? [];
  const timestamps = history.map(sample => typeof sample.timestamp === 'number' ? sample.timestamp : Date.parse(sample.timestamp));
  const hasTime = timestamps.length > 0 && timestamps.every((value, index) => Number.isFinite(value) && (index === 0 || value >= timestamps[index - 1]));
  const positions = hasTime ? timestamps : history.map((_, index) => index);
  const span = positions.length > 1 ? positions.at(-1) - positions[0] : 0;
  const x = index => span > 0 ? (positions[index] - positions[0]) / span * 566 : 566;
  const duration = hasTime ? span / 1000 : span;
  const tickLabel = value => `${value > 0 ? '−' : ''}${Number(value.toFixed(value > 0 && value < 0.1 ? 3 : 1))}${hasTime ? 's' : '次'}`;
  const timeTicks = duration > 0
    ? `<span>${tickLabel(duration)}</span><span>${tickLabel(duration / 2)}</span><span>${tickLabel(0)}</span>`
    : `<span></span><span>${tickLabel(0)}</span>`;
  const paths = [];
  let segment = [];
  history.forEach((sample, index) => {
    if (!Number.isFinite(sample.gpuUtil)) {
      if (segment.length) paths.push(segment);
      segment = [];
    } else segment.push([x(index), 112 - Math.min(100, Math.max(0, sample.gpuUtil)) * 1.12]);
  });
  if (segment.length) paths.push(segment);
  return `<div class="usage-plot"><div class="chart-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div><svg class="usage-chart" viewBox="0 0 566 112" preserveAspectRatio="none" role="img" aria-label="机器 ${esc(provider.providerId)} 最近 ${history.length} 次 GPU 使用率，横轴${hasTime ? '为距最后采样的秒数' : '为距最后采样的样本数'}，当前${provider.gpuUtil === null ? '离线，无采样' : `${provider.gpuUtil}%`}">${[0, 50, 100].map(value => `<line x1="0" x2="566" y1="${112 - value * 1.12}" y2="${112 - value * 1.12}" class="chart-grid" vector-effect="non-scaling-stroke"/>`).join('')}${paths.map(points => `<polyline class="chart-line" vector-effect="non-scaling-stroke" points="${points.map(point => point.join(',')).join(' ')}"/>${points.length === 1 ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="3" class="chart-dot"/>` : ''}`).join('')}</svg><div class="chart-times" aria-hidden="true">${timeTicks}</div></div>`;
}

export function renderResources(state, snapshot, selectedId, paused, { role = 'client', taskActions = {}, showTasks = true } = {}) {
  const provider = snapshot.providers.find(entry => entry.providerId === selectedId);
  if (!provider) return '<p class="empty">暂无监视数据。</p>';
  const offline = provider.connectivity === 'offline';
  const computing = snapshot.jobs.some(job => assignments(job).some(entry => entry.providerId === selectedId && entry.status === 'computing'));
  const metric = (label, value, unit = '') => `<div class="resource-metric"><p>${label}</p><strong>${value === null ? '—' : value}<span>${value === null ? '' : unit}</span></strong></div>`;
  const resourcePanel = `<section class="panel resource-panel"><div class="panel-head"><div class="row"><h2>机器 ${esc(selectedId)} · ${esc(provider.hardware.gpu)}</h2><span class="status ${offline ? 'offline-status' : ''}">${offline ? '离线' : computing ? '运行中' : provider.activeAssignments ? '待提交' : '空闲'}</span></div></div><div class="resource-metrics">${metric('GPU 使用率', provider.gpuUtil, '%')}${metric(`显存占用 · ${esc(provider.memoryTotalGiB)} GiB`, provider.memoryUsedGiB, ' GiB')}${metric('CPU 使用率', provider.cpuUtil, '%')}${metric('GPU 温度', provider.tempC, ' °C')}</div><div class="usage-heading"><h3>GPU 使用率</h3></div>${usageChart(provider)}</section>`;
  if (!showTasks) return resourcePanel;
  const context = role === 'provider' ? `view=supply&machine=${encodeURIComponent(selectedId)}` : '';
  const jobs = state.jobs.filter(job => !job.closed && assignments(snapshot.jobs.find(entry => entry.jobId === job.id)).some(entry => entry.providerId === selectedId));
  return `<div class="resource-layout">${resourcePanel}<section class="panel resource-tasks"><div class="panel-head"><h2>当前任务</h2><span class="muted">${jobs.length} 个</span></div>${jobs.length ? jobs.slice().reverse().map(job => `<article class="monitor-task"><div class="row spread"><a class="link" href="#/jobs/${encodeURIComponent(job.id)}/flow${context ? `?${context}` : ''}">任务 #${esc(job.id)}</a>${taskActions[job.id] ? `<div class="row">${taskActions[job.id]}</div>` : ''}</div>${renderComputeProgress(job, snapshot, { providerId: selectedId, role })}</article>`).join('') : '<p class="empty">暂无进行任务。</p>'}</section></div>`;
}
