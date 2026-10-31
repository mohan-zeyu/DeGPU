// Presentation access rules. A real adapter must enforce the same policy at
// its authenticated data boundary; hiding rendered fields is not encryption.
const nonempty = value => typeof value === 'string' && value.length > 0;
const sameAddress = (left, right) => nonempty(left) && nonempty(right)
  && left.startsWith('0x') && right.startsWith('0x')
  && left.toLowerCase() === right.toLowerCase();
const confirmedEvent = entry => entry && entry.confirmed !== false
  && entry.status !== 0 && entry.status !== false;
const eventArgs = (job, name) => (Array.isArray(job.events) ? job.events : [])
  .find(entry => entry?.name === name && confirmedEvent(entry))?.args;
const matches = (value, identity) => nonempty(value)
  && (value === identity.id || sameAddress(value, identity.address));

export function canViewJob(job, { account, role, providerId, providers = [] } = {}) {
  if (!job || !account || (!nonempty(account.id) && !nonempty(account.address))) return false;
  if (role === 'client') {
    const client = eventArgs(job, 'JobCreated')?.client ?? job.clientAddress ?? job.client;
    return (nonempty(account.id) && nonempty(job.clientId) && job.clientId === account.id)
      || sameAddress(client, account.address);
  }
  if (role !== 'provider' || !nonempty(providerId)) return false;
  const provider = (Array.isArray(providers) ? providers : []).find(entry => entry.id === providerId || sameAddress(entry.address, providerId));
  const identity = { id: provider?.id ?? providerId, address: provider?.address ?? providerId };
  // Public assignment events win over display aliases. Never infer a role
  // from the customer's private verify choice or a preselected candidate.
  const main = eventArgs(job, 'JobCreated')?.main ?? job.main ?? job.provider;
  if (matches(main, identity)) return true;
  if (job.mode === 'checked') return false;
  const drawn = eventArgs(job, 'VerifiersDrawn')?.verifiers;
  const verifiers = Array.isArray(drawn) ? drawn : Array.isArray(job.verifiers) ? job.verifiers : [];
  if (verifiers.some(value => matches(value, identity))) return true;
  const tie = eventArgs(job, 'TiebreakStarted')?.tiebreaker ?? job.tieProvider ?? job.tiebreaker;
  return matches(tie, identity);
}

// The public task projection is an explicit allowlist. Do not spread a job
// into links, attributes, tooltips, or publicly rendered histories.
export function publicJobReference(job) {
  return Object.freeze({ id: nonempty(job?.id) ? job.id : null });
}

// Rental access always follows the account that posted the task. A machine
// supplied by that account does not reveal its other customers' rentals.
export function rentalJobsForAccount(jobs, account, { activeOnly = false } = {}) {
  return (Array.isArray(jobs) ? jobs : []).filter(job => (!activeOnly || !job.closed)
    && canViewJob(job, { account, role: 'client' }));
}

const chainSeconds = value => (typeof value === 'number'
  || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)))
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

/**
 * Live rental telemetry is narrower than historical task-detail access. Only
 * the customer's confirmed, accepted main-computation assignment can reveal
 * a machine while it is actually computing before its execution deadline.
 * Return IDs only; callers must independently filter both machine telemetry
 * and task telemetry, and must not include pre-rental samples in the history.
 * `now` is chain seconds, never the wall-clock timestamps of local samples.
 */
export function getRunningRentalAccess(state, account, snapshot, { now = state?.blocks?.at(-1)?.timestamp } = {}) {
  const providerIds = new Set();
  const jobIds = new Set();
  const time = chainSeconds(now);
  if (!account || (!nonempty(account.id) && !nonempty(account.address)) || time === null) {
    return Object.freeze({ providerIds: Object.freeze([]), jobIds: Object.freeze([]) });
  }
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  const monitoredJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const monitoredProviders = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  for (const job of Array.isArray(state?.jobs) ? state.jobs : []) {
    if (!job || !nonempty(job.id) || job.closed || job.deadlinePassed === true) continue;
    if (!((job.mode === 'replicated' && job.phase === 'Committing')
      || (job.mode === 'checked' && job.phase === 'Working'))) continue;
    const deadline = chainSeconds(job.deadline);
    if (deadline === null || time > deadline) continue;
    const events = (Array.isArray(job.events) ? job.events : []).filter(confirmedEvent);
    if (!events.some(entry => entry.name === 'JobAccepted')
      || events.some(entry => ['JobClosed', 'ResultsCommitted', 'ResultsSubmitted', 'ResultsPublished'].includes(entry.name))) continue;
    const creation = events.find(entry => entry.name === 'JobCreated')?.args;
    // Confirmed event identities are mandatory. Client IDs and display aliases
    // cannot override an on-chain customer or promote a verifier to the main.
    if (!matches(creation?.client, account)) continue;
    const provider = providers.find(entry => nonempty(entry?.id)
      && matches(creation?.main, entry));
    if (!provider) continue;
    const monitored = monitoredJobs.find(entry => entry?.jobId === job.id)?.main;
    if (monitored?.role !== 'main' || monitored.status !== 'computing'
      || !matches(monitored.providerId, provider)) continue;
    const machine = monitoredProviders.find(entry => matches(entry?.providerId, provider));
    if (machine?.connectivity !== 'online') continue;
    providerIds.add(provider.id);
    jobIds.add(job.id);
  }
  return Object.freeze({
    providerIds: Object.freeze([...providerIds]),
    jobIds: Object.freeze([...jobIds]),
  });
}

export function getRunningRentalProviderIds(state, account, snapshot, options) {
  return getRunningRentalAccess(state, account, snapshot, options).providerIds;
}

// Select only within the previously established live-rental access set. A
// task-specific link binds its formal main machine instead of reusing an old
// selection or silently switching to an unrelated authorized rental.
export function resolveRunningRentalSelection(state, access, { jobId, providerId } = {}) {
  const jobIds = Array.isArray(access?.jobIds) ? access.jobIds : [];
  const providerIds = Array.isArray(access?.providerIds) ? access.providerIds : [];
  const requestedJob = jobId !== null && jobId !== undefined;
  const requestedProvider = providerId !== null && providerId !== undefined;
  if ((requestedJob && !jobIds.includes(jobId))
    || (requestedProvider && !providerIds.includes(providerId))) return null;
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  const mainFor = job => {
    if (!job) return null;
    const main = eventArgs(job, 'JobCreated')?.main;
    return providers.find(provider => providerIds.includes(provider?.id) && matches(main, provider)) ?? null;
  };
  if (requestedJob) {
    const job = jobs.find(entry => entry?.id === jobId);
    const main = mainFor(job);
    if (!main || (requestedProvider && main.id !== providerId)) return null;
    return Object.freeze({ providerId: main.id, jobId: job.id });
  }
  const selectedProvider = requestedProvider ? providerId : providerIds[0];
  if (!nonempty(selectedProvider)) return null;
  const job = jobIds.map(id => jobs.find(entry => entry?.id === id))
    .find(entry => mainFor(entry)?.id === selectedProvider);
  return job ? Object.freeze({ providerId: selectedProvider, jobId: job.id }) : null;
}
