const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const uiText = value => String(value ?? '').replaceAll('主节点', '提供方').replaceAll('复核节点', '复核方').replaceAll('裁决节点', '裁决方');

const STAGES = Object.freeze(['已发布', '执行', '核验', '交付', '结算']);
const EVENTS = Object.freeze({
  JobCreated: [0, '任务发布'], JobAccepted: [1, '提供方接单'],
  ResultsCommitted: [1, '结果已承诺'], DecisionRevealed: [1, '复核决定已公开'],
  VerificationDropped: [1, '本次跳过复核'], VerifiersDrawn: [2, '复核方已分配'],
  RangeShared: [2, '复核资料已分享'], CheckCommitted: [2, '复核承诺已提交'],
  CheckRevealed: [2, '复核结果已公开'], ResultsSubmitted: [3, '答案已提交检验'],
  ResultsPublished: [3, '结果已交付'], ResultsDisputed: [3, '客户已提出争议'],
  TiebreakStarted: [3, '争议裁决中'], TiebreakShared: [3, '裁决资料已分享'],
  TiebreakSubmitted: [3, '裁决结果已提交'], JudgementSubmitted: [3, '裁决票已提交'],
  Payout: [null, '款项已支付'], ProviderSlashed: [null, '质押已罚没'],
  JobClosed: [null, '任务已关闭'],
});
const OUTCOMES = Object.freeze({
  checked: ['None', 'Cancelled', 'Delivered', 'MainMissed'],
  replicated: ['None', 'Cancelled', 'Delivered', 'Verified', 'MainOutvoted', 'VerifierOutvoted',
    'BothOutvoted', 'NoMajority', 'MainMissed', 'TiebreakerMissed', 'TieClientNoShare', 'DisputeRejected'],
});
const OUTCOME_LABELS = Object.freeze({
  Cancelled: '已取消', Delivered: '已交付并结算', Verified: '复核通过并结算',
  MainOutvoted: '提供方结果未通过', VerifierOutvoted: '裁决完成并结算', BothOutvoted: '双方结果未通过',
  NoMajority: '未能达成裁决', MainMissed: '提供方超时', TiebreakerMissed: '裁决方超时',
  TieClientNoShare: '客户未分享裁决资料', DisputeRejected: '争议未成立并结算',
});
const SUCCESS = new Set(['Delivered', 'Verified', 'VerifierOutvoted', 'DisputeRejected']);
const failedReceipt = value => value === false || value === 0 || ['0', '0x0', 'failed', 'reverted'].includes(value);

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric : numeric / 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function outcomeFor(job, event) {
  const value = event?.args?.outcome;
  const values = OUTCOMES[job.mode] ?? OUTCOMES.replicated;
  if (values.includes(value)) return value;
  if (typeof value === 'string') {
    const name = value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    if (values.includes(name)) return name;
  }
  return /^(0|[1-9]\d*)$/.test(String(value)) ? values[Number(value)] ?? null : null;
}

export function formatTimelineDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分${value % 60 ? ` ${value % 60} 秒` : ''}`;
  return `${Math.floor(value / 3600)} 时${Math.floor(value % 3600 / 60) ? ` ${Math.floor(value % 3600 / 60)} 分` : ''}`;
}

/** A record of confirmed protocol stages. It never estimates hardware progress. */
export function buildJobTimeline(job = {}, { transactions = [], blocks = [] } = {}) {
  const receipts = new Map(transactions.map(entry => [entry.hash, entry]));
  const blockTimes = new Map(blocks.map(entry => [Number(entry.number), timestamp(entry.timestamp)]));
  const ordered = (Array.isArray(job.events) ? job.events : [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => Object.hasOwn(EVENTS, event.name) && event.confirmed !== false && !failedReceipt(event.status)
      && !failedReceipt(receipts.get(event.transactionHash)?.status))
    .sort((left, right) => {
      const a = Number(left.event.blockNumber), b = Number(right.event.blockNumber);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
      const ai = Number(left.event.logIndex), bi = Number(right.event.logIndex);
      return Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi ? ai - bi : left.index - right.index;
    });
  const points = [];
  let stage = 0;
  let closure = null;
  for (const { event } of ordered) {
    const spec = EVENTS[event.name];
    const outcome = event.name === 'JobClosed' ? outcomeFor(job, event) : null;
    if (spec[0] !== null) stage = Math.max(stage, spec[0]);
    if (event.name === 'JobClosed') {
      closure = { outcome, event };
      if (SUCCESS.has(outcome)) stage = 4;
    }
    const receipt = receipts.get(event.transactionHash);
    const at = timestamp(event.timestamp ?? event.time ?? event.at)
      ?? timestamp(receipt?.timestamp) ?? blockTimes.get(Number(event.blockNumber)) ?? null;
    points.push({
      event, stage, timestamp: at,
      label: event.name === 'JobClosed' ? OUTCOME_LABELS[outcome] ?? '任务已关闭' : spec[1],
      tone: event.name === 'ProviderSlashed' || event.name === 'ResultsDisputed' ? 'warn'
        : event.name === 'JobClosed' ? SUCCESS.has(outcome) ? 'ok' : outcome === 'Cancelled' ? 'muted' : 'danger' : 'accent',
    });
  }
  const allTimed = points.length > 0 && points.every(point => point.timestamp !== null)
    && points.every((point, index) => index === 0 || point.timestamp >= points[index - 1].timestamp);
  const publishedAt = points.find(point => point.event.name === 'JobCreated')?.timestamp ?? null;
  const durationSeconds = allTimed && publishedAt !== null ? points.at(-1).timestamp - publishedAt : null;
  const observedAt = timestamp(job.observedChainTimestamp);
  const elapsedSeconds = durationSeconds === null ? null : closure || observedAt === null
    ? durationSeconds : Math.max(points.at(-1).timestamp, observedAt) - publishedAt;
  const axis = allTimed && durationSeconds > 0 ? 'time' : 'sequence';
  const awaitingAcceptance = job.phase === 'Open' || ['等待接单', '等待主节点接单'].includes(job.status);
  const status = closure ? OUTCOME_LABELS[closure.outcome] ?? '任务已关闭'
    : job.deadlinePassed ? '已到截止，等待链上处理'
      : awaitingAcceptance && points.some(point => point.event.name === 'JobAccepted') ? '正在执行'
        : uiText(job.status || ({ Open: '等待接单', Working: '正在执行',
      Committing: '正在执行', Checking: '复核进行中', CheckReveal: '等待复核结果', Publishing: '等待交付',
      Disputing: '等待验收', TieBreak: '争议裁决中' })[job.phase] || '等待确认记录');
  return Object.freeze({ points, stages: STAGES, axis, durationSeconds, publishedAt, elapsedSeconds, status, confirmedStage: points.length ? stage : null,
    outcome: closure?.outcome ?? null, closed: Boolean(closure),
    tone: closure ? SUCCESS.has(closure.outcome) ? 'ok' : closure.outcome === 'Cancelled' ? 'muted' : 'danger'
      : job.deadlinePassed ? 'warn' : 'accent',
  });
}

export function formatJobOffset(job, value, options = {}) {
  const model = buildJobTimeline(job, options);
  const at = timestamp(value);
  return model.publishedAt !== null && at !== null && at >= model.publishedAt
    ? `发布后 ${formatTimelineDuration(at - model.publishedAt)}` : '—';
}

export function renderJobTimeline(job = {}, options = {}) {
  const model = buildJobTimeline(job, options);
  const { points, stages } = model;
  const title = options.title ?? '任务运行';
  const currentStage = model.confirmedStage;
  const passedWidth = currentStage === null ? 0 : currentStage / (stages.length - 1) * 100;
  const simulated = options.timeSource === 'simulation';
  const elapsedLabel = simulated ? '模拟耗时' : model.closed ? '任务耗时'
    : timestamp(job.observedChainTimestamp) !== null ? '已持续' : '已确认耗时';
  const duration = model.elapsedSeconds === null ? '' : `<span>${elapsedLabel} <strong>${esc(formatTimelineDuration(model.elapsedSeconds))}</strong></span>`;
  const events = points.filter((point, index) => index === 0 || index === points.length - 1
    || point.stage !== points[index - 1].stage || ['ResultsDisputed', 'ProviderSlashed'].includes(point.event.name));
  const markers = events.slice(-5).map(point => {
    const offset = model.durationSeconds === null || point.timestamp === null ? null : point.timestamp - model.publishedAt;
    const at = offset === null ? `区块 #${point.event.blockNumber ?? '—'}` : `发布后 ${formatTimelineDuration(offset)}`;
    const href = point.event.transactionHash ? (options.txHref?.(point.event.transactionHash) ?? `#/chain?tx=${encodeURIComponent(point.event.transactionHash)}`) : null;
    return `<li><span class="timeline-event-dot ${point.tone}"></span><div>${href ? `<a href="${esc(href)}">${esc(point.label)}</a>` : `<span>${esc(point.label)}</span>`}<time${offset === null ? '' : ` datetime="PT${Math.round(offset)}S"`}>${esc(at)}</time></div></li>`;
  }).join('');
  const stageMarkup = stages.map((label, index) => {
    const reached = currentStage !== null && index <= currentStage;
    const current = !model.closed && index === currentStage;
    return `<span class="timeline-stage-node ${reached ? 'is-passed' : 'is-future'}${current ? ' is-current' : ''}" data-stage="${index}" style="left:${(index / (stages.length - 1) * 100).toFixed(3)}%"${current ? ' aria-current="step"' : ''} title="${esc(`${label} · ${reached ? '已确认' : '待确认'}`)}"><span class="timeline-stage-dot" aria-hidden="true"></span><span class="timeline-stage-label">${esc(label)}</span></span>`;
  }).join('');
  const chart = points.length ? `<figure class="job-timeline-figure"><div class="timeline-horizontal ${model.tone}" role="img" aria-label="${esc(`${title}，${model.status}，已确认至${stages[currentStage]}，${points.length} 条确认记录`)}"><div class="timeline-rail" data-reached-stage="${currentStage}"><span class="timeline-rail-base"></span><span class="timeline-line ${model.tone}" style="width:${passedWidth.toFixed(3)}%"></span>${stageMarkup}</div></div></figure>` : '<div class="timeline-empty">等待任务确认记录</div>';
  return `<div class="job-timeline"><div class="timeline-heading"><h2>${esc(title)}</h2><span class="timeline-status ${model.tone}" role="status">${esc(model.status)}</span></div><div class="timeline-summary">${duration}<span>确认记录 <strong>${points.length}</strong></span></div>${chart}${markers ? `<ol class="timeline-events" aria-label="关键记录">${markers}</ol>` : ''}</div>`;
}
