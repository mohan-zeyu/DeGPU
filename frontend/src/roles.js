// Read-only projections shared by the client/provider views. They do not grant
// permissions or replace the contract's sender and state checks.
export function providerRole(job, providerId) {
  if (!providerId) return null;
  if (job.provider === providerId) return '提供方';
  if (job.mode === 'checked') return null;
  // Preselected local identities do not become assignments before the public
  // decision/draw; in these phases only the main provider is known.
  if (['Open', 'Committing', 'Deciding'].includes(job.phase)) return null;
  if (job.verifiers?.includes(providerId)) return '复核方';
  if (job.tieProvider === providerId) return '裁决方';
  return null;
}

export function jobsForProvider(jobs, providerId) {
  return jobs.filter((job) => providerRole(job, providerId) !== null);
}

// Mirror the demo store's next transaction, including its sequential sharing
// and commitment order. A pending deadline is a wait, not a provider action.
export function nextActor(job) {
  if (job.closed || job.phase === 'Closed') return null;
  if (job.mode === 'checked') {
    if (!['Open', 'Working'].includes(job.phase)) return null;
    if (job.nextAction === 'expire' || job.deadlinePassed) return 'client';
    if (['wait', 'unsupported-timeout'].includes(job.nextAction)) return null;
    return job.provider ?? null;
  }
  if (job.nextAction === 'expire') return 'client';
  if (['wait', 'unsupported-timeout'].includes(job.nextAction) || job.deadlinePassed) return null;
  switch (job.phase) {
    case 'Open':
    case 'Committing':
    case 'Publishing':
      return job.provider ?? null;
    case 'Deciding':
    case 'Disputing':
      return 'client';
    case 'Checking': {
      if (job.verifierStates?.includes('Assigned')) return 'client';
      const slot = job.verifierStates?.indexOf('Shared') ?? -1;
      return slot < 0 ? null : job.verifiers?.[slot] ?? null;
    }
    case 'CheckReveal': {
      const slot = job.verifierStates?.indexOf('Committed') ?? -1;
      return slot < 0 ? null : job.verifiers?.[slot] ?? null;
    }
    case 'TieBreak':
      return job.tieShared ? job.tieProvider ?? null : 'client';
    default:
      return null;
  }
}

const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

function eventAmount(args) {
  // Logs carry integer wei. Convert only at this display boundary; accounting
  // inside demo-store.js continues to use bigint.
  if (args.amount != null) return Number(BigInt(args.amount)) / 1e18;
  return Number(args.amountEth ?? 0);
}

export function providerLedger(jobs, provider) {
  return jobsForProvider(jobs, provider.id).filter((job) => job.closed).map((job) => {
    let income = 0;
    let slashed = 0;
    for (const entry of job.events ?? []) {
      const args = entry.args ?? {};
      if (entry.name === 'Payout' && sameAddress(args.to, provider.address)) income += eventAmount(args);
      if (entry.name === 'ProviderSlashed' && sameAddress(args.provider, provider.address)) slashed += eventAmount(args);
    }
    return { job, role: providerRole(job, provider.id), income, slashed, net: income - slashed };
  });
}
