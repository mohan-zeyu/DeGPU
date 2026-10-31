// Public machine statistics describe visible, confirmed history of one service.
import { getService, getProviderOffer } from './services.js';
import { getTaskOutcomeStats, isConfirmedTaskEvent } from './task-outcomes.js';
const WEI = 10n ** 18n;
const QUOTED_SERVICE = 'image-classify-v1';

function ethAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  if (!match) return null;
  const wei = BigInt(match[1]) * WEI + BigInt((match[2] ?? '').padEnd(18, '0'));
  const fraction = (wei % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei / WEI}${fraction ? `.${fraction}` : ''}`;
}

function counter(value) {
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const nullableBoolean = (value) => typeof value === 'boolean' ? value : null;
const nullableString = (value) => typeof value === 'string' ? value : null;
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const matches = (value, provider) => value === provider.id || sameAddress(value, provider.address);

function participation(job, provider) {
  const events = (Array.isArray(job.events) ? job.events : []).filter(isConfirmedTaskEvent);
  // An address in a public event wins over an adapter's display alias. This
  // keeps historical participation intact if aliases are changed later.
  const main = events.find((entry) => entry.name === 'JobCreated')?.args?.main
    ?? job.main ?? job.provider;
  if (matches(main, provider)) return { role: 'main', verifierState: null };
  const drawn = events.find((entry) => entry.name === 'VerifiersDrawn')?.args?.verifiers;
  const verifiers = Array.isArray(drawn) ? drawn : job.verifiers ?? [];
  const slot = verifiers.findIndex((value) => matches(value, provider));
  if (slot >= 0) return { role: 'check', verifierState: nullableString(job.verifierStates?.[slot]) };
  const tie = events.find((entry) => entry.name === 'TiebreakStarted')?.args?.tiebreaker
    ?? job.tieProvider ?? job.tiebreaker;
  return matches(tie, provider) ? { role: 'tie', verifierState: null } : null;
}

function publicHistory(state, provider, taskType) {
  return Object.freeze((state.jobs ?? []).flatMap((job) => {
    if (job.taskType !== taskType) return [];
    const role = participation(job, provider);
    if (!role) return [];
    // Deliberately project public scalars rather than exposing a job reference
    // containing input names, results or client-provided credentials.
    return [Object.freeze({
      id: nullableString(job.id),
      mode: nullableString(job.mode),
      taskType: nullableString(job.taskType),
      itemCount: counter(job.itemCount),
      ...role,
      phase: nullableString(job.phase),
      status: nullableString(job.status),
      closed: nullableBoolean(job.closed),
      outcome: nullableString(job.outcome),
      createdBlock: counter(job.createdBlock),
      updatedBlock: counter(job.updatedBlock),
    })];
  }).sort((left, right) => (right.updatedBlock ?? right.createdBlock ?? -1)
    - (left.updatedBlock ?? left.createdBlock ?? -1)));
}

export function getProviderPublicStats(state, providerId, taskType = QUOTED_SERVICE) {
  const provider = state?.providers?.find((entry) => entry.id === providerId || sameAddress(entry.address, providerId));
  if (!provider) return null;
  const service = getService(taskType);
  const mode = service?.mode ?? null;
  const checked = mode === 'checked';
  const outcomes = getTaskOutcomeStats(state.jobs, taskType, { provider });
  const hasSamples = outcomes.mainResolved > 0;
  // An explicit complete history from genesis proves a new machine has zero
  // completions. Partial/unknown history cannot establish that count, and an
  // empty denominator still provides no evidence for a success/failure rate.
  const fullHistory = state.network?.historyComplete === true && state.network?.historyFromBlock === 0
    && Array.isArray(state.jobs) && outcomes.mode !== null;
  const completed = hasSamples || fullHistory ? outcomes.completed : null;
  const verified = !checked && hasSamples ? outcomes.verified : null;
  const unverified = !checked && hasSamples ? outcomes.unverified : null;
  const missed = hasSamples ? outcomes.missed : null;
  const outvoted = !checked && hasSamples ? outcomes.outvoted : null;
  const quote = ethAmount(getProviderOffer(provider, taskType));
  return Object.freeze({
    id: nullableString(provider.id),
    address: nullableString(provider.address),
    taskType,
    mode,
    unit: service?.unit ?? '项',
    registered: nullableBoolean(provider.registered),
    // The normalized adapter's active flag mirrors registry.isActive: both
    // registration and the minimum stake are required. Do not guess minStake.
    active: nullableBoolean(provider.active),
    quote: quote !== null && /[1-9]/.test(quote) ? quote : null,
    stake: ethAmount(provider.stake),
    lockedJobs: counter(provider.lockedJobs),
    verified,
    unverified,
    completed,
    missed,
    outvoted,
    source: outcomes.source,
    mainResolved: outcomes.mainResolved,
    failed: hasSamples ? outcomes.failed : null,
    timeoutRate: outcomes.timeoutRate,
    outvotedRate: outcomes.outvotedRate,
    failureRate: outcomes.failureRate,
    itemsSolved: checked && hasSamples ? outcomes.itemsSolved : null,
    itemsNotFound: checked && hasSamples ? outcomes.itemsNotFound : null,
    itemsReported: checked && hasSamples ? outcomes.itemsReported : null,
    notFoundRate: outcomes.notFoundRate,
    // Shared registry check/tie counters cannot be separated by task type.
    checksCompleted: null,
    checksMissed: null,
    checksOutvoted: null,
    history: publicHistory(state, provider, taskType),
  });
}

export function getProviderMarketPoints(state, taskType = QUOTED_SERVICE, { includeUnavailable = false } = {}) {
  if (!getService(taskType)?.available) return Object.freeze([]);
  return Object.freeze((state?.providers ?? []).flatMap((provider) => {
    const stats = getProviderPublicStats(state, provider.id, taskType);
    if (!stats || (!includeUnavailable && stats.active !== true) || stats.registered !== true
      || stats.quote === null) return [];
    // Equal coordinates still represent different providers. Group or fan out
    // their interaction targets in the chart without altering either value.
    return [Object.freeze({
      id: stats.id, address: stats.address, quote: stats.quote,
      completed: stats.completed, verified: stats.verified, unverified: stats.unverified,
      missed: stats.missed, outvoted: stats.outvoted,
      mainResolved: stats.mainResolved, timeoutRate: stats.timeoutRate,
      outvotedRate: stats.outvotedRate, failureRate: stats.failureRate,
      mode: stats.mode, itemsReported: stats.itemsReported, notFoundRate: stats.notFoundRate,
    })];
  }));
}
