import { getService } from './services.js';

const SUCCESSFUL_OUTCOMES = new Set(['Delivered', 'Verified', 'VerifierOutvoted', 'DisputeRejected']);
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

const knownTotal = (values) => {
  if (values.some((value) => value === null)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
};

const OUTCOMES = Object.freeze({
  replicated: ['None', 'Cancelled', 'Delivered', 'Verified', 'MainOutvoted', 'VerifierOutvoted',
    'BothOutvoted', 'NoMajority', 'MainMissed', 'TiebreakerMissed', 'TieClientNoShare', 'DisputeRejected'],
  checked: ['None', 'Cancelled', 'Delivered', 'MainMissed'],
});
export const isConfirmedTaskEvent = event => event && event.confirmed !== false && event.status !== 0 && event.status !== false;
const closedOutcome = (value, mode) => typeof value === 'string' && OUTCOMES[mode]?.includes(value) ? value
  : /^(0|[1-9]\d*)$/.test(String(value)) ? OUTCOMES[mode]?.[Number(value)] ?? null : null;

// Per-service history only; the registry's shared market counters cannot
// establish separate classification/render histories. Provider samples require
// a confirmed creation event assigning that machine as main computation.
export function getTaskOutcomeStats(jobs, taskType, { provider = null } = {}) {
  const service = getService(taskType);
  const mode = service?.available ? service.mode : null;
  const checked = mode === 'checked';
  let completed = 0;
  let verified = checked ? null : 0;
  let unverified = checked ? null : 0;
  let missed = 0;
  let outvoted = checked ? null : 0;
  let failed = 0;
  let mainResolved = 0;
  const solvedCounts = [];
  const notFoundCounts = [];
  const seen = new Set();
  for (const job of jobs ?? []) {
    if (!mode || job.taskType !== taskType || job.mode !== mode || typeof job.id !== 'string' || !job.id) continue;
    const events = (Array.isArray(job.events) ? job.events : []).filter(isConfirmedTaskEvent);
    if (provider) {
      const main = events.find(event => event.name === 'JobCreated')?.args?.main;
      if (main !== provider.id && !sameAddress(main, provider.address)) continue;
    }
    const closure = events.findLast(event => event.name === 'JobClosed');
    const outcome = closedOutcome(closure?.args?.outcome, mode);
    if (!outcome || ['None', 'Cancelled'].includes(outcome)) continue;
    const identity = `${mode}/${job.marketAddress ?? ''}/${job.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    mainResolved += 1;
    const delivered = SUCCESSFUL_OUTCOMES.has(outcome);
    if (delivered) {
      completed += 1;
      if (!checked) {
        const rejectedWithCheck = outcome === 'DisputeRejected'
          && events.some(event => event.name === 'CheckRevealed');
        if (['Verified', 'VerifierOutvoted'].includes(outcome) || rejectedWithCheck) verified += 1;
        else unverified += 1;
      }
    }
    else failed += 1;
    if (outcome === 'MainMissed') missed += 1;
    if (!checked && ['MainOutvoted', 'BothOutvoted'].includes(outcome)) outvoted += 1;
    if (checked && delivered) {
      const found = events.findLast(event => event.name === 'ResultsSubmitted')?.args?.found;
      const valid = Array.isArray(found) && Number.isSafeInteger(job.itemCount) && job.itemCount > 0
        && found.length === job.itemCount && found.every(value => typeof value === 'boolean');
      solvedCounts.push(valid ? found.filter(Boolean).length : null);
      notFoundCounts.push(valid ? found.filter(value => !value).length : null);
    }
  }
  const itemsSolved = checked ? knownTotal(solvedCounts) : null;
  const itemsNotFound = checked ? knownTotal(notFoundCounts) : null;
  const itemsReported = checked ? knownTotal([itemsSolved, itemsNotFound]) : null;
  return Object.freeze({
    taskType,
    mode,
    source: 'task-events',
    completed, verified, unverified,
    missed,
    outvoted,
    failed,
    mainResolved,
    timeoutRate: mainResolved ? missed / mainResolved * 100 : null,
    outvotedRate: !checked && mainResolved ? outvoted / mainResolved * 100 : null,
    failureRate: mainResolved ? failed / mainResolved * 100 : null,
    itemsSolved, itemsNotFound, itemsReported,
    notFoundRate: itemsReported ? itemsNotFound / itemsReported * 100 : null,
  });
}

