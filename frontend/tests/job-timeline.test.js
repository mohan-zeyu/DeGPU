import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/demo-store.js';
import { buildJobTimeline, renderJobTimeline, formatJobOffset } from '../src/job-timeline.js';

const event = (name, timestamp, args = {}, extra = {}) => ({ name, timestamp, args, ...extra });

test('task times are relative to confirmed publication and ignore a constant chain clock offset', () => {
  const at = 1792934345;
  const job = { mode: 'checked', observedChainTimestamp: at + 75,
    events: [event('JobCreated', at), event('JobAccepted', at + 2)] };
  const chain = renderJobTimeline(job);
  assert.match(chain, /已持续 <strong>1 分 15 秒/);
  assert.match(chain, /发布后 2 秒/);
  assert.doesNotMatch(chain, /北京时间|链上跨度|2026|\d{2}:\d{2}:\d{2}/);
  const lagging = { ...job, observedChainTimestamp: job.observedChainTimestamp - 4354,
    events: job.events.map(entry => ({ ...entry, timestamp: entry.timestamp - 4354 })) };
  assert.equal(renderJobTimeline(lagging), chain);
  assert.equal(formatJobOffset(job, at + 300), '发布后 5 分');
  const simulation = renderJobTimeline(job, { timeSource: 'simulation' });
  assert.match(simulation, /模拟耗时/);
  assert.equal(buildJobTimeline(job).points[0].timestamp, at);
});

test('a closed task freezes duration at its closure and a running task never borrows the computer clock', () => {
  const events = [event('JobCreated', 100), event('JobAccepted', 110), event('JobClosed', 130, { outcome: 2 })];
  const closed = { mode: 'checked', events, observedChainTimestamp: 10000 };
  assert.equal(buildJobTimeline(closed).elapsedSeconds, 30);
  assert.match(renderJobTimeline(closed), /任务耗时 <strong>30 秒/);
  const running = { mode: 'checked', events: events.slice(0, 2) };
  assert.equal(buildJobTimeline(running).elapsedSeconds, 10);
  assert.match(renderJobTimeline(running), /已确认耗时 <strong>10 秒/);
  assert.equal(buildJobTimeline({ ...running, observedChainTimestamp: 105 }).elapsedSeconds, 10);
});

test('missing publication or invalid times cannot invent elapsed time or a negative deadline offset', () => {
  const job = { events: [event('JobAccepted', 110)], observedChainTimestamp: 200 };
  assert.equal(buildJobTimeline(job).elapsedSeconds, null);
  assert.equal(formatJobOffset(job, 150), '—');
  assert.doesNotMatch(renderJobTimeline(job), /已持续|发布后/);
  const created = { events: [event('JobCreated', 100)] };
  assert.equal(formatJobOffset(created, 99), '—');
  assert.equal(formatJobOffset(created, null), '—');
  assert.equal(formatJobOffset(created, 'invalid'), '—');
});

test('timeline resolves real confirmation times from transaction receipts and preserves stage order', () => {
  const store = createDemoStore();
  const state = store.getState();
  const job = state.jobs.find(entry => entry.outcome === 'Verified');
  const before = structuredClone(job);
  const model = buildJobTimeline(job, state);
  assert.equal(model.axis, 'time');
  assert.equal(model.outcome, 'Verified');
  assert.equal(model.closed, true);
  assert.equal(model.points.at(-1).stage, 4);
  assert.ok(model.points.some(point => point.stage === 2));
  assert.ok(model.durationSeconds > 0);
  assert.ok(model.points.every((point, index) => index === 0 || point.stage >= model.points[index - 1].stage));
  assert.deepEqual(job, before);
  const html = renderJobTimeline(job, state);
  assert.match(html, /class="timeline-line ok"/);
  assert.match(html, /data-reached-stage="4"/);
  assert.doesNotMatch(html, /flow-board|资源|完成度|计算百分比/);
});

test('elapsed time or backend closed flag cannot manufacture successful completion', () => {
  const job = { mode: 'checked', phase: 'Working', closed: true, outcome: 'Delivered', deadlinePassed: true,
    events: [event('JobCreated', 100), event('JobAccepted', 110)] };
  const model = buildJobTimeline(job);
  assert.equal(model.closed, false);
  assert.equal(model.outcome, null);
  assert.equal(model.points.at(-1).stage, 1);
  assert.equal(model.status, '已到截止，等待链上处理');
});

test('cancelled and expired closure stays at the last confirmed stage', () => {
  for (const [outcome, stage, tone] of [['Cancelled', 0, 'muted'], ['MainMissed', 1, 'danger']]) {
    const events = [event('JobCreated', 100)];
    if (stage === 1) events.push(event('JobAccepted', 110));
    events.push(event('JobClosed', 120, { outcome }));
    const model = buildJobTimeline({ mode: 'replicated', events });
    assert.equal(model.closed, true);
    assert.equal(model.points.at(-1).stage, stage);
    assert.equal(model.tone, tone);
    const html = renderJobTimeline({ mode: 'replicated', events });
    assert.match(html, new RegExp(`class="timeline-line ${tone}" style="width:${stage ? '25' : '0'}\\.000%"`));
    assert.doesNotMatch(html, /aria-current="step"/);
  }
});

test('two confirmations reach execution on a single stage rail without filling later stages or adding an extra marker', () => {
  const job = { mode: 'checked', phase: 'Open', status: '等待接单',
    events: [event('JobCreated', 100), event('JobAccepted', 100)] };
  const model = buildJobTimeline(job);
  assert.equal(model.confirmedStage, 1);
  assert.equal(model.status, '正在执行', 'confirmed acceptance overrides an older waiting summary');
  const html = renderJobTimeline(job);
  assert.match(html, /class="timeline-line accent" style="width:25\.000%"/);
  assert.match(html, /data-stage="1"[^>]*aria-current="step"/);
  assert.equal((html.match(/class="timeline-stage-dot"/g) || []).length, 5);
  assert.equal((html.match(/class="timeline-stage-node is-passed/g) || []).length, 2);
  assert.equal((html.match(/class="timeline-stage-node is-future/g) || []).length, 3);
  assert.doesNotMatch(html, /class="timeline-point|timeline-current-label|timeline-x-axis|确认顺序|第 2 条/);
});

test('additional confirmation records in the same phase do not advance the stage rail', () => {
  const base = [event('JobCreated', 100), event('JobAccepted', 101)];
  for (const events of [base, [...base, event('ResultsCommitted', 110), event('DecisionRevealed', 111), event('VerificationDropped', 111)]]) {
    const html = renderJobTimeline({ mode: 'replicated', phase: 'Publishing', events });
    assert.match(html, /data-reached-stage="1"/);
    assert.match(html, /class="timeline-line accent" style="width:25\.000%"/);
  }
});

test('reverted or unconfirmed logs never advance line or confirm closure', () => {
  const model = buildJobTimeline({ mode: 'checked', events: [event('JobCreated', 100),
    event('JobAccepted', 110, {}, { transactionHash: 'reverted' }),
    event('ResultsSubmitted', 120, {}, { confirmed: false }),
    event('JobClosed', 120, { outcome: 2 }, { status: '0x0' })] },
  { transactions: [{ hash: 'reverted', status: 0 }] });
  assert.equal(model.points.length, 1);
  assert.equal(model.closed, false);
  assert.equal(model.points[0].stage, 0);
});

test('disputes and numeric closure enums render a confirmed result without inventing compute progress', () => {
  const model = buildJobTimeline({ mode: 'replicated', events: [event('JobCreated', 100),
    event('JobAccepted', 101), event('ResultsCommitted', 115), event('ResultsPublished', 120),
    event('ResultsDisputed', 125), event('TiebreakStarted', 125),
    event('JudgementSubmitted', 140), event('JobClosed', 140, { outcome: 11 })] });
  assert.equal(model.outcome, 'DisputeRejected');
  assert.equal(model.tone, 'ok');
  assert.equal(model.points.at(-1).stage, 4);
  assert.equal(model.points.find(point => point.event.name === 'ResultsDisputed').stage, 3);
});

test('missing or backward timestamps use confirmation order and escape externally supplied labels', () => {
  const job = { status: '<img src=x onerror=alert(1)>', events: [event('JobCreated', 110), event('JobAccepted', 100)] };
  assert.equal(buildJobTimeline(job).axis, 'sequence');
  assert.equal(buildJobTimeline(job).durationSeconds, null);
  const html = renderJobTimeline(job);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(buildJobTimeline({ events: [{ name: 'JobCreated' }] }).durationSeconds, null);
});

test('desktop API snake case outcome names preserve a successful confirmed endpoint', () => {
  const model = buildJobTimeline({ mode: 'replicated', events: [event('JobCreated', 100),
    event('ResultsPublished', 115), event('JobClosed', 120, { outcome: 'verifier_outvoted' })] });
  assert.equal(model.outcome, 'VerifierOutvoted');
  assert.equal(model.points.at(-1).stage, 4);
  assert.equal(model.tone, 'ok');
});
