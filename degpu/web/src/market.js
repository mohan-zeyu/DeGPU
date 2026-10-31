// Market prices stay separate by service and by source: a registry quote is an
// offer, while a settled sample is the main provider's actual Payout log.
import { getService, getProviderOffer } from './services.js';
import { getTaskOutcomeStats, isConfirmedTaskEvent } from './task-outcomes.js';
import { rentalJobsForAccount } from './access.js';
import { getProviderMarketPoints } from './provider-stats.js';

const WEI = 10n ** 18n;
const QUOTED_SERVICE = 'image-classify-v1';
const SUCCESSFUL_OUTCOMES = new Set(['Delivered', 'Verified', 'VerifierOutvoted', 'DisputeRejected']);

function quoteWei(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  if (!match) return null;
  return BigInt(match[1]) * WEI + BigInt((match[2] ?? '').padEnd(18, '0'));
}

function payoutWei(value) {
  if (typeof value !== 'bigint' && typeof value !== 'string') return null;
  if (!/^\d+$/.test(String(value))) return null;
  return BigInt(value);
}

function eth(value) {
  const fraction = (value % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / WEI}${fraction ? `.${fraction}` : ''}`;
}

// Round at the smallest chain unit, rather than converting wei into a floating
// point ETH value before averaging.
const roundedDivide = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

// Renting is an account-to-job relationship, independent of machine ownership
// or the view's former role selector. Creation event addresses win over aliases;
// closure evidence also wins over an adapter's stale `closed: false` flag.
export function getRentedProviderIds(state, { account = state?.account } = {}) {
  const ids = new Set();
  for (const job of rentalJobsForAccount(state?.jobs, account, { activeOnly: true })) {
    const events = (Array.isArray(job.events) ? job.events : []).filter(isConfirmedTaskEvent);
    if (events.some(event => event.name === 'JobClosed')) continue;
    const main = events.find(event => event.name === 'JobCreated')?.args?.main ?? job.main ?? job.provider;
    const provider = (state?.providers ?? []).find(entry => entry.id === main || sameAddress(entry.address, main));
    if (typeof provider?.id === 'string' && provider.id) ids.add(provider.id);
  }
  return Object.freeze([...ids]);
}

// Service summaries use typed confirmed task events, never market-wide counters.
export function getNetworkOutcomeStats(state, taskType = QUOTED_SERVICE) {
  return Object.freeze({
    ...getTaskOutcomeStats(state?.jobs, taskType),
    providerCount: (state?.providers ?? []).filter(provider => provider.registered === true).length,
  });
}

function quotesFor(state, taskType) {
  if (!getService(taskType)?.available && !state.taskTypes?.some(task => task.id === taskType)) return [];
  return (state.providers ?? []).flatMap((provider) => {
    const amount = quoteWei(getProviderOffer(provider, taskType));
    return provider.registered === true && provider.active === true && amount !== null && amount > 0n
      ? [{ id: provider.id, amount }] : [];
  });
}

export function getMarketStats(state, taskType = QUOTED_SERVICE) {
  const mode = getService(taskType)?.mode ?? null;
  const quotes = quotesFor(state, taskType);
  const quoteTotal = quotes.reduce((sum, quote) => sum + quote.amount, 0n);
  const buckets = new Map();
  for (const { amount } of quotes) buckets.set(amount, (buckets.get(amount) ?? 0) + 1);
  const distribution = [...buckets].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([amount, count]) => Object.freeze({ price: eth(amount), count }));

  let settledCount = 0;
  let settledItems = 0;
  let settledPayout = 0n;
  let openJobs = 0;
  let inProgressJobs = 0;
  for (const job of state.jobs ?? []) {
    if (job.taskType !== taskType) continue;
    if (!job.closed) {
      if (job.phase === 'Open') openJobs += 1;
      else inProgressJobs += 1;
      continue;
    }
    if (!SUCCESSFUL_OUTCOMES.has(job.outcome)
      || !Number.isSafeInteger(job.itemCount) || job.itemCount <= 0) continue;
    // Checked pays only found answers. Its realized price is per solved item,
    // not per input (which would turn refunds into an artificial discount).
    const units = mode === 'checked' ? job.solved : job.itemCount;
    if (!Number.isSafeInteger(units) || units <= 0 || units > job.itemCount) continue;

    const main = job.events?.find((entry) => entry.name === 'JobCreated')?.args?.main
      ?? state.providers?.find((provider) => provider.id === job.provider)?.address;
    let amount = 0n;
    let hasPayout = false;
    for (const entry of job.events ?? []) {
      if (entry.name !== 'Payout' || !sameAddress(entry.args?.to, main)) continue;
      const paid = payoutWei(entry.args?.amount);
      if (paid === null) continue;
      amount += paid;
      hasPayout = true;
    }
    // A missing receipt is not evidence of a free completed task. Only count
    // samples whose actual main fee is known; refunds, penalties and check fees
    // never contribute to the market's realized compute unit price.
    if (!hasPayout) continue;
    settledCount += 1;
    settledItems += units;
    settledPayout += amount;
  }

  return Object.freeze({
    taskType,
    mode,
    quoteCount: quotes.length,
    averageQuote: quotes.length ? eth(roundedDivide(quoteTotal, BigInt(quotes.length))) : null,
    minQuote: distribution[0]?.price ?? null,
    maxQuote: distribution.at(-1)?.price ?? null,
    distribution: Object.freeze(distribution),
    settledCount,
    settledItems,
    settledAverage: settledItems ? eth(roundedDivide(settledPayout, BigInt(settledItems))) : null,
    openJobs,
    inProgressJobs,
  });
}

export function getProviderQuoteComparison(state, providerId, taskType = QUOTED_SERVICE) {
  const quotes = quotesFor(state, taskType);
  const own = quotes.find((quote) => quote.id === providerId);
  const total = quotes.reduce((sum, quote) => sum + quote.amount, 0n);
  const averageQuote = quotes.length ? eth(roundedDivide(total, BigInt(quotes.length))) : null;
  if (!own) return Object.freeze({ quote: null, averageQuote, relation: null, differencePercent: null });

  // Compare against the exact rational mean, not its rounded display string.
  const difference = own.amount * BigInt(quotes.length) - total;
  const relation = difference < 0n ? 'below' : difference > 0n ? 'above' : 'equal';
  let differencePercent = '0';
  if (total > 0n && difference !== 0n) {
    const tenths = roundedDivide((difference < 0n ? -difference : difference) * 1000n, total);
    const fraction = tenths % 10n;
    differencePercent = `${difference < 0n ? '-' : '+'}${tenths / 10n}${fraction ? `.${fraction}` : ''}`;
  }
  return Object.freeze({ quote: eth(own.amount), averageQuote, relation, differencePercent });
}

export const MARKET_COMPETITION_ROUNDS = 12;

// A counterfactual quotation path, not registry updates or predicted payouts.
// Buyers comparing the same service put pressure on a wide initial spread.
// Experience and confirmed reliability permit a small premium/discount, never
// a claim that completion counts measure GPU speed or guarantee a result.
export function getMarketCompetitionSnapshot(state, taskType = QUOTED_SERVICE, round = 0) {
  const currentRound = typeof round === 'number' && Number.isFinite(round)
    ? Math.max(0, Math.min(MARKET_COMPETITION_ROUNDS, Math.trunc(round))) : 0;
  const sourcePoints = getProviderMarketPoints(state, taskType, { includeUnavailable: true })
    .filter(point => typeof point.id === 'string' && point.id);
  const amounts = sourcePoints.map(point => quoteWei(point.quote));
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const count = BigInt(amounts.length);
  const initialMin = amounts.length ? amounts.reduce((min, value) => value < min ? value : min) : null;
  const initialMax = amounts.length ? amounts.reduce((max, value) => value > max ? value : max) : null;
  const anchor = count ? roundedDivide(total, count) : 0n;
  const maxCompleted = Math.max(1, ...sourcePoints.map(point => point.completed ?? 0));
  const premiums = sourcePoints.map(point => {
    const experience = Math.round(250 * (point.completed ?? 0) / maxCompleted);
    const samples = point.mainResolved ?? 0;
    const reliability = typeof point.failureRate === 'number'
      ? Math.round(point.failureRate * 3 * samples / (samples + 5)) : 0;
    // Small, deterministic cost differences keep a stable market a price band.
    const cost = [...point.id].reduce((hash, character) => (hash * 31 + character.codePointAt(0)) % 61, 0) - 30;
    return experience - reliability + cost;
  });
  const meanPremium = premiums.length ? Math.round(premiums.reduce((sum, value) => sum + value, 0) / premiums.length) : 0;
  // Equal initial quotes do not acquire artificial volatility. Narrow markets
  // also keep their existing scale instead of being forced into a wider band.
  const initialSpan = initialMax === null ? 0n : initialMax - initialMin;
  const maximumOffset = initialSpan / 8n;
  const targets = amounts.map((amount, index) => {
    const premium = BigInt(premiums[index] - meanPremium);
    let offset = anchor * premium / 10000n;
    if (offset > maximumOffset) offset = maximumOffset;
    if (offset < -maximumOffset) offset = -maximumOffset;
    const target = anchor + offset;
    return target < initialMin ? initialMin : target > initialMax ? initialMax : target;
  });
  // Front-loaded adjustments show sellers responding to price comparison;
  // the final rounds settle rather than continuing to undercut indefinitely.
  const remainingBasisPoints = [10000n, 7900n, 6200n, 4800n, 3600n, 2600n,
    1800n, 1200n, 750n, 400n, 180n, 140n, 100n][currentRound];
  const projected = amounts.map((amount, index) => roundedDivide(
    amount * remainingBasisPoints + targets[index] * (10000n - remainingBasisPoints), 10000n,
  ));
  const projectedTotal = projected.reduce((sum, amount) => sum + amount, 0n);
  const average = count ? roundedDivide(projectedTotal, count) : null;
  const min = projected.length ? projected.reduce((value, amount) => amount < value ? amount : value) : null;
  const max = projected.length ? projected.reduce((value, amount) => amount > value ? amount : value) : null;
  const points = Object.freeze(sourcePoints.map((point, index) => Object.freeze({
    ...point, quote: eth(projected[index]), originalQuote: point.quote,
  })));
  return Object.freeze({
    taskType, round: currentRound, totalRounds: MARKET_COMPETITION_ROUNDS,
    progress: currentRound / MARKET_COMPETITION_ROUNDS,
    phase: currentRound === 0 ? 'initial' : currentRound === MARKET_COMPETITION_ROUNDS ? 'stable' : 'competing',
    points, quoteCount: points.length,
    averageQuote: average === null ? null : eth(average),
    minQuote: min === null ? null : eth(min), maxQuote: max === null ? null : eth(max),
    // Relative full spread, useful without exposing long decimal percentages.
    dispersionPercent: average ? Number((max - min) * 1000000n / average) / 10000 : null,
    // Keep the initial Y domain during playback, otherwise auto-scaling would
    // make even a converged price band fill the entire chart vertically.
    priceDomain: Object.freeze({
      minQuote: initialMin === null ? null : eth(initialMin),
      maxQuote: initialMax === null ? null : eth(initialMax),
    }),
  });
}
