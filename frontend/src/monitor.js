// Local presentation telemetry. This module never sends transactions, confirms
// results or reads real hardware; 100% means a local calculation claim only.
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value) => Math.round(value * 10) / 10;
const providerSeed = (id) => [...String(id)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
const profiles = [
  { gpu: 'RTX 4090', memoryTotalGiB: 24 },
  { gpu: 'RTX 3090', memoryTotalGiB: 24 },
  { gpu: 'RTX A5000', memoryTotalGiB: 24 },
  { gpu: 'RTX 3080', memoryTotalGiB: 12 },
  { gpu: 'RTX 4070 Ti', memoryTotalGiB: 12 },
  { gpu: 'RTX A4000', memoryTotalGiB: 16 },
];
const hasEvent = (job, name, slot) => (job.events ?? []).some((entry) => entry.name === name && (slot === undefined || entry.args?.slot === slot));
const recordKey = (job, role, slot = '') => `${job.id}:${job.createdBlock ?? ''}:${job.events?.find((entry) => entry.name === 'JobCreated')?.transactionHash ?? ''}:${role}:${slot}`;
const isWork = (status) => status === 'computing' || status === 'ready';
const isOfflineScenario = (job) => job.scenario === 'main-offline' || (job.mode === 'checked' && job.scenario === 'checked-offline');

export function createDemoMonitor() {
  let state = { jobs: [], providers: [] };
  let tick = 0;
  let records = new Map();
  let histories = new Map();
  let snapshot;

  function reconcile() {
    const nextRecords = new Map();
    // Connectivity is independent of eligibility/remaining stake. A known
    // offline machine cannot keep computing another job in the background.
    const offline = new Set(state.jobs.filter((job) => isOfflineScenario(job)
      && !job.closed && (job.phase === 'Committing' || (job.mode === 'checked' && job.phase === 'Working'))).map((job) => job.provider));
    const failures = new Map();
    for (const job of state.jobs) {
      if (!isOfflineScenario(job) || job.outcome !== 'MainMissed') continue;
      const block = job.events?.find((entry) => entry.name === 'JobClosed')?.blockNumber ?? job.updatedBlock ?? -1;
      failures.set(job.provider, Math.max(failures.get(job.provider) ?? -1, block));
    }
    // A historical outage is not permanent. In this local activity model a
    // subsequent successful transaction signed by the provider resumes its
    // connection. Client-created tasks and client-submitted expiry calls do
    // not establish provider liveness; a currently configured outage wins.
    const activity = new Map();
    for (const transaction of state.transactions ?? []) {
      if (transaction.status !== 1 || typeof transaction.from !== 'string') continue;
      const address = transaction.from.toLowerCase();
      activity.set(address, Math.max(activity.get(address) ?? -1, transaction.blockNumber ?? -1));
    }
    for (const provider of state.providers) {
      if (!failures.has(provider.id)) continue;
      const latest = activity.get(String(provider.address).toLowerCase()) ?? -1;
      if (latest <= failures.get(provider.id)) offline.add(provider.id);
    }

    function assignment(job, providerId, role, total, stage, slot) {
      const key = recordKey(job, role, slot);
      const prior = records.get(key);
      let completed = clamp(prior?.completed ?? 0, 0, total);
      let status;
      if (stage === 'submitted') {
        completed = total;
        status = 'submitted';
      } else if (stage === 'stopped' || job.closed || job.deadlinePassed) {
        status = 'stopped';
      } else if (stage === 'waiting') {
        status = 'waiting';
      } else {
        completed = !prior || prior.status === 'waiting'
          ? Math.min(total, Math.ceil(total * (isOfflineScenario(job) && role === 'main' ? 0.35 : 0.12)))
          : prior.completed;
        status = completed >= total ? 'ready' : 'computing';
      }
      // MainMissed keeps its last partial count after expiration, rather than
      // turning a closed/failed task into a completed computation.
      if (offline.has(providerId) && stage !== 'submitted' && (stage === 'computing' || job.outcome === 'MainMissed')) {
        if ((!prior || prior.status === 'waiting') && isOfflineScenario(job) && role === 'main') completed = Math.min(total, Math.ceil(total * 0.35));
        status = job.closed ? 'stopped' : 'offline';
      }
      const result = {
        providerId, role, ...(slot === undefined ? {} : { slot }),
        completed, total, percent: total ? Math.round(completed / total * 100) : 0, status,
      };
      nextRecords.set(key, result);
      return result;
    }

    const jobs = state.jobs.map((job) => {
      const total = Math.max(0, Number(job.itemCount) || 0);
      if (job.mode === 'checked') {
        const submitted = hasEvent(job, 'ResultsSubmitted');
        const main = assignment(job, job.provider, 'main', total, submitted ? 'submitted' : job.phase === 'Working' ? 'computing' : 'waiting');
        return { jobId: job.id, mode: 'checked', main, verifiers: [], tiebreak: null };
      }
      const committed = hasEvent(job, 'ResultsCommitted');
      const main = assignment(job, job.provider, 'main', total, committed ? 'submitted' : job.phase === 'Committing' ? 'computing' : 'waiting');
      const verifiers = (job.verifiers ?? []).map((providerId, slot) => {
        const slotState = job.verifierStates?.[slot];
        const submitted = hasEvent(job, 'CheckCommitted', slot) || hasEvent(job, 'CheckRevealed', slot)
          || ['Committed', 'Revealed', 'Outvoted'].includes(slotState);
        const count = job.verifiers.length;
        return assignment(job, providerId, 'verifier', Math.floor((slot + 1) * total / count) - Math.floor(slot * total / count),
          submitted ? 'submitted' : slotState === 'Shared' ? 'computing' : 'waiting', slot);
      });
      const tieId = job.tieProvider ?? job.tiebreaker;
      const disputed = job.events?.findLast(entry => entry.name === 'ResultsDisputed')?.args?.items;
      const mismatchCount = Array.isArray(job.mismatched) ? job.mismatched.length
        : Array.isArray(disputed) ? disputed.length : Math.max(0, Number(job.mismatches) || 0);
      const tiebreak = tieId ? assignment(job, tieId, 'tiebreak', mismatchCount,
        hasEvent(job, 'TiebreakSubmitted') || hasEvent(job, 'JudgementSubmitted') ? 'submitted' : job.tieShared ? 'computing' : 'waiting') : null;
      return { jobId: job.id, mode: job.mode ?? 'replicated', main, verifiers, tiebreak };
    });
    records = nextRecords;

    const providers = state.providers.map((provider) => {
      const seed = providerSeed(provider.id);
      const hardware = { ...profiles[(seed - 65 + profiles.length) % profiles.length] };
      const assignments = [...records.values()].filter((entry) => entry.providerId === provider.id && isWork(entry.status));
      const running = assignments.filter((entry) => entry.status === 'computing').length;
      const connectivity = offline.has(provider.id) ? 'offline' : 'online';
      const fluctuation = ((tick + seed) % 7) - 3;
      const gpuUtil = connectivity === 'offline' ? null : clamp(running ? 69 + running * 9 + fluctuation * 2 : 5 + fluctuation, 1, 98);
      const memoryUsedGiB = connectivity === 'offline' ? null : round(clamp(running ? 3 + running * 3.8 + fluctuation * 0.12 : 0.8 + fluctuation * 0.05, 0, hardware.memoryTotalGiB));
      const history = histories.get(provider.id) ?? [];
      // Reconciliation may update the latest value, but it is not a new
      // timed sample. Keep its original wall-clock timestamp for the chart.
      const timestamp = history.at(-1)?.tick === tick ? history.at(-1).timestamp : Date.now();
      const sample = {
        tick, timestamp, connectivity, gpuUtil, memoryUsedGiB,
        cpuUtil: connectivity === 'offline' ? null : clamp(running ? 18 + running * 11 + fluctuation : 6 + fluctuation, 1, 96),
        tempC: connectivity === 'offline' ? null : clamp(running ? 60 + running * 3 + fluctuation : 37 + fluctuation, 25, 85),
        powerW: connectivity === 'offline' ? null : clamp(running ? 205 + running * 24 + fluctuation * 3 : 31 + fluctuation * 2, 18, 410),
      };
      if (history.at(-1)?.tick === tick) history[history.length - 1] = sample;
      else history.push(sample);
      histories.set(provider.id, history.slice(-24));
      return {
        providerId: provider.id, hardware, memoryTotalGiB: hardware.memoryTotalGiB,
        ...sample, activeAssignments: assignments.length, history: clone(histories.get(provider.id)),
      };
    });
    const providerIds = new Set(state.providers.map((provider) => provider.id));
    histories = new Map([...histories].filter(([id]) => providerIds.has(id)));
    snapshot = freeze(clone({ source: 'demo', tick, providers, jobs }));
    return snapshot;
  }

  function sync(nextState) {
    if (!nextState || !Array.isArray(nextState.jobs) || !Array.isArray(nextState.providers)) throw new TypeError('Monitor requires jobs and providers');
    state = clone(nextState);
    return reconcile();
  }

  function advanceSample() {
    tick += 1;
    for (const entry of records.values()) {
      if (entry.status !== 'computing') continue;
      const increment = Math.max(1, Math.ceil(entry.total * (0.08 + (providerSeed(entry.providerId) + tick) % 5 * 0.015)));
      entry.completed = Math.min(entry.total, entry.completed + increment);
    }
    return reconcile();
  }

  // Clear all samples and calculation estimates. Call sync(newState) after the
  // store resets so reused task IDs start with fresh work and fresh histories.
  function reset() {
    state = { jobs: [], providers: [] };
    tick = 0;
    records = new Map();
    histories = new Map();
    return reconcile();
  }

  reset();
  return Object.freeze({ sync, tick: advanceSample, getSnapshot: () => snapshot, reset });
}
