// Adapter for the verified DeGPU local app (docs/API.md, API v1).
// Wallet keys stay in the app. A failed request never switches to demo data.
const WEI = 10n ** 18n;
const clone = value => structuredClone(value);
const sameAddress = (left, right) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());
const pascal = value => String(value ?? '').split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
const taskNames = { 'image-classify-v1': '图像分类', 'blender-render-v1': 'Blender 渲染', 'key-search-v1': '密钥搜索' };
const statusNames = { open: '等待接单', committing: '计算中', deciding: '公开复核决定', checking: '复核计算中', check_reveal: '公开复核结果', publishing: '交付结果', disputing: '核对渲染结果', tie_break: '争议裁决中', working: '搜索中', closed: '已完成' };
const outcomeNames = { cancelled: '已取消', delivered: '交付完成', verified: '复核通过', main_outvoted: '提供方结果有误', verifier_outvoted: '复核方结果有误', both_outvoted: '双方结果有误', no_majority: '未达成裁决', main_missed: '提供方超时', tiebreaker_missed: '裁决方超时', tie_client_no_share: '客户未分享裁决资料', dispute_rejected: '争议未成立' };
const outcomeCodes = {
  checked: ['none', 'cancelled', 'delivered', 'main_missed'],
  replicated: ['none', 'cancelled', 'delivered', 'verified', 'main_outvoted', 'verifier_outvoted',
    'both_outvoted', 'no_majority', 'main_missed', 'tiebreaker_missed', 'tie_client_no_share', 'dispute_rejected'],
};
// Chain deadlines use block seconds. Local wall time can differ from anvil by
// hours, especially after restoring its saved state. Never substitute it.
const chainSeconds = value => ['number', 'string'].includes(typeof value)
  && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value))
  && Number(value) > 0 && Number(value) < 100000000000 ? Number(value) : null;
const laterChainTime = (...values) => values.reduce((latest, value) => Math.max(latest || 0, chainSeconds(value) || 0), 0) || null;
const confirmedEvent = event => event.confirmed !== false
  && ![false, 0, '0', '0x0', 'failed', 'reverted'].includes(event.status);
function closedOutcome(value, mode) {
  const codes = outcomeCodes[mode] || [];
  if (['number', 'string'].includes(typeof value) && /^\d+$/.test(String(value))) return codes[Number(value)];
  const name = typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : '';
  return codes.includes(name) ? name : undefined;
}

export function weiToEth(value = '0') {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${absolute / WEI}${fraction ? `.${fraction}` : '.000'}`;
}

export function ethToWei(value) {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  if (!match) throw new Error('ETH 金额须为非负十进制数，最多保留 18 位小数。');
  return (BigInt(match[1]) * WEI + BigInt((match[2] || '').padEnd(18, '0'))).toString();
}

const emptyState = () => ({
  network: { mode: 'live', name: 'DeGPU', connected: false, joined: false, chainId: null, timestamp: null,
    walletUnlocked: false, historyComplete: false, accountJobsOnly: true, chainExplorer: false,
    providerListing: true, providerAutomation: true, walletApi: true },
  unlocked: false, wallets: [], users: [], account: {}, providers: [], jobs: [], transactions: [], blocks: [], taskTypes: [],
  selfProvider: null, activity: [], telemetry: { source: 'live', tick: 0, providers: [], jobs: [] },
});

function normalizeProvider(provider, walletAddress, selfProvider, savedOffers) {
  const own = sameAddress(provider.address, walletAddress);
  const extra = own ? selfProvider || {} : {};
  const replicated = provider.record?.replicated || {};
  const checked = provider.record?.checked || {};
  const offers = Object.fromEntries(Object.entries(provider.prices_wei || {}).map(([name, amount]) => [name, weiToEth(amount)]));
  const stats = {
    verified: replicated.verified_completed ?? 0, unverified: replicated.unverified_completed ?? 0,
    missed: replicated.missed ?? 0, outvoted: replicated.outvoted ?? 0,
    checksCompleted: replicated.checks_completed ?? 0, checksMissed: replicated.checks_missed ?? 0,
    checksOutvoted: replicated.checks_outvoted ?? 0,
  };
  return { ...provider, ...extra, concurrentJobs: true, id: provider.address, ownerId: provider.address,
    name: own ? '我的机器' : provider.address, stake: weiToEth(provider.stake_wei), offers,
    pricePerItem: offers['image-classify-v1'] ?? '0.000', lockedJobs: provider.open_jobs,
    listed: Object.values(provider.prices_wei || {}).some(value => BigInt(value) > 0n),
    listingBusy: Number(provider.open_jobs) > 0, savedOffers: clone(savedOffers || offers),
    ...(own ? { autoProcess: Boolean(extra.serving), serving: Boolean(extra.serving) } : {}),
    ...stats, statsByMode: { replicated: stats, checked: {
      completed: checked.completed ?? 0, missed: checked.missed ?? 0,
      itemsSolved: checked.items_solved ?? 0, itemsNotFound: checked.items_not_found ?? 0,
    } },
  };
}

function settlementFor(job, events) {
  if (!job.closed || !events.some(event => event.name === 'JobClosed')) return null;
  const paid = address => events.filter(event => event.name === 'Payout' && sameAddress(event.args.to, address))
    .reduce((sum, event) => sum + BigInt(event.args.amount || '0'), 0n);
  const refund = paid(job.client);
  const bond = BigInt(job.dispute_bond_wei || '0');
  const slashed = events.filter(event => event.name === 'ProviderSlashed').reduce((sum, event) => sum + BigInt(event.args.amount || '0'), 0n);
  const verifierAddresses = (job.verifiers || []).map(value => value.address);
  return { deposit: weiToEth(job.deposit_wei), main: weiToEth(paid(job.main)),
    verifierB: weiToEth(paid(verifierAddresses[0])), verifierC: weiToEth(paid(verifierAddresses[1])),
    tiebreak: weiToEth(paid(job.tiebreaker)), refund: weiToEth(refund), clientRefund: weiToEth(refund),
    clientNet: weiToEth(refund - BigInt(job.deposit_wei) - bond), slashed: weiToEth(slashed), gasExcluded: true,
  };
}

function normalizeJob(job, taskTypes, priorResults, metadata = {}, chainTimestamp = null) {
  const task = taskTypes.find(type => type.id === job.task);
  const events = (job.timeline || []).map((entry, index) => ({ ...entry, name: entry.event,
    blockNumber: entry.block, timestamp: entry.time, jobId: job.ref, mode: job.mode,
    // The app supplies no transaction hash or EVM log index; retain its order.
    timelineIndex: index, args: clone(entry.args || {}),
  }));
  const confirmed = events.filter(confirmedEvent);
  const closure = confirmed.findLast(event => event.name === 'JobClosed');
  // The app reads the summary before scanning logs. A transaction confirmed
  // between those reads can make its timeline newer than its status/deadline.
  const acceptedAfterSummary = !closure && !job.closed && job.status === 'open'
    && ['checked', 'replicated'].includes(job.mode) && confirmed.some(event => event.name === 'JobAccepted');
  const projected = { ...job, deadlinePending: acceptedAfterSummary };
  if (closure) {
    projected.closed = true;
    projected.status = 'closed';
    projected.outcome = closedOutcome(closure.args.outcome, job.mode) || job.outcome;
  } else if (acceptedAfterSummary) {
    projected.status = job.mode === 'checked' ? 'working' : 'committing';
    // The old deadline belongs to Open, not the newly confirmed work phase.
    projected.deadline = null;
  }
  // A confirmed event is only a lower bound on chain time, never a ticking
  // clock. Use this job's records so a newer task cannot age an older snapshot.
  const observedChainTimestamp = confirmed.reduce((latest, event) =>
    laterChainTime(latest, event.timestamp), laterChainTime(chainTimestamp, job.chain_timestamp));
  const deadline = chainSeconds(projected.deadline);
  const deadlinePassed = !projected.closed && deadline !== null && observedChainTimestamp !== null
    && observedChainTimestamp > deadline;
  const verifiers = (job.verifiers || []).map(value => value.address);
  const normal = { ...projected, ...metadata, id: job.ref, chainJobId: job.id, localId: job.id,
    chainStatus: job.status, chainOutcome: job.outcome, rawTimeline: clone(job.timeline || []),
    phase: pascal(projected.status), outcome: pascal(projected.outcome), taskType: job.task,
    taskTypeId: task?.chainId, compare: job.task === 'blender-render-v1' ? 'similar' : 'exact',
    itemCount: job.num_items, provider: job.main, clientId: job.client, clientAddress: job.client,
    deposit: weiToEth(job.deposit_wei), disputeBond: weiToEth(job.dispute_bond_wei || '0'),
    verifiers, verifierDetails: clone(job.verifiers || []), verifierAddresses: verifiers, verifierStates: (job.verifiers || []).map(value => pascal(value.state)),
    tieProvider: job.tiebreaker || null, verify: Boolean(job.verified), deadlinePassed, observedChainTimestamp, chainClockKnown: chainSeconds(chainTimestamp) !== null || chainSeconds(job.chain_timestamp) !== null,
    status: deadlinePassed ? '到期待处理' : projected.closed ? outcomeNames[projected.outcome] || '已完成' : statusNames[projected.status] || projected.status,
    events, results: priorResults || [], resultKind: task?.result, mismatches: job.mismatched?.length || 0,
    disputedItems: clone(job.mismatched || []), solved: job.solved,
    createdBlock: events[0]?.blockNumber, updatedBlock: events.at(-1)?.blockNumber,
    nextAction: projected.closed ? null : deadlinePassed ? 'expire' : 'wait', actionLabel: deadlinePassed ? '处理超时' : '自动运行中',
    executionSource: 'degpu-app', settlement: settlementFor(projected, confirmed), progress: {},
  };
  const stepEvents = { JobCreated: 'create', JobAccepted: 'accept', ResultsCommitted: 'commit', DecisionRevealed: 'decision', ResultsPublished: 'publish', ResultsSubmitted: 'submit', JobClosed: 'settle', TiebreakShared: 'tieShare', TiebreakSubmitted: 'tie', JudgementSubmitted: 'tie', ResultsDisputed: 'dispute' };
  for (const event of confirmed) if (stepEvents[event.name]) normal.progress[stepEvents[event.name]] = 'done';
  return normal;
}

export function createNetworkClient({ fetcher = globalThis.fetch, pollMs = 2000, baseUrl = '', storage } = {}) {
  if (storage === undefined && typeof window !== 'undefined') {
    try { storage = window.localStorage; } catch { /* storage may be unavailable */ }
  }
  let state = emptyState();
  let timer;
  let polling = false;
  let mutations = 0;
  let revision = 0;
  let uploadSequence = 0;
  let identity = '';
  let providerWarning = null;
  const listeners = new Set();
  const uploads = new Map();
  const jobDetails = new Map();
  const results = new Map();
  const metadata = new Map();
  const savedOffers = new Map();
  const emit = () => listeners.forEach(listener => listener(clone(state)));
  const clearPrivateState = () => { jobDetails.clear(); results.clear(); metadata.clear(); uploads.clear(); providerWarning = null; };
  const offerKey = address => `${state.network.url || ''}/${state.network.registry || ''}/${String(address).toLowerCase()}`;
  function rememberOffers(address, offers) {
    const key = offerKey(address);
    savedOffers.set(key, clone(offers));
    // Only public prices are persisted, never wallet passwords, keys or results.
    try { storage?.setItem(`degpu.saved-offers.${key}`, JSON.stringify(offers)); } catch { /* storage is optional */ }
  }
  function rememberedOffers(address) {
    const key = offerKey(address);
    if (savedOffers.has(key)) return savedOffers.get(key);
    try {
      const value = JSON.parse(storage?.getItem(`degpu.saved-offers.${key}`) || 'null');
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(price => typeof price === 'string' && /^\d+(?:\.\d{1,18})?$/.test(price))) {
        savedOffers.set(key, value);
        return value;
      }
    } catch { /* Ignore corrupt persisted public prices. */ }
    return undefined;
  }

  async function request(path, { method = 'GET', body, timeout = method === 'GET' ? 15000 : 120000 } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      const response = await fetcher(`${baseUrl}/api${path}`, { method, signal: controller.signal, cache: 'no-store',
        headers: { ...(method === 'POST' ? { 'X-DeGPU': '1' } : {}), ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
      });
      let data;
      try { data = await response.json(); } catch { throw new Error(`DeGPU 服务未返回有效数据（HTTP ${response.status}）。`); }
      if (!response.ok) {
        const detail = data.detail || data.error || data.message;
        const message = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(item => `${item.loc?.join('.') || ''}: ${item.msg || '参数有误'}`).join('；') : `请求失败（HTTP ${response.status}）`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('DeGPU 服务响应超时，请查看本机服务日志后确认操作结果。');
      throw error;
    } finally { clearTimeout(timeoutId); }
  }

  async function refresh() {
    const currentRevision = ++revision;
    try {
      const [status, wallets] = await Promise.all([request('/status', { timeout: 15000 }), request('/wallets', { timeout: 15000 })]);
      if (currentRevision !== revision) return clone(state);
      if (typeof status.unlocked !== 'boolean' || !Array.isArray(wallets)) throw new Error('DeGPU 服务返回了不完整的钱包状态。');
      const nextIdentity = status.unlocked ? `${status.network?.url || ''}/${status.network?.chain_id || ''}/${status.network?.registry || ''}/${status.wallet?.address || ''}` : '';
      if (identity !== nextIdentity) { clearPrivateState(); identity = nextIdentity; }
      const network = { ...emptyState().network, ...state.network, name: status.network?.name || 'DeGPU',
        connected: true, connectionError: null, joined: status.unlocked, walletUnlocked: status.unlocked,
        chainId: status.network?.chain_id ?? null, url: status.network?.url || '', registry: status.network?.registry || null,
        // Older app APIs omit chain_timestamp. Keep it unknown in that case.
        timestamp: chainSeconds(status.chain_timestamp), clock: status.clock || null,
        serving: status.serving, walletName: status.wallet?.name || '',
      };
      if (!status.unlocked) {
        state = { ...emptyState(), network, wallets, wallet: null };
        emit();
        return clone(state);
      }
      const [account, tasks, providers, own, jobs, activity] = await Promise.all([
        request('/account'), request('/tasks'), request('/providers'), request('/provider'), request('/jobs'), request('/activity'),
      ]);
      if (currentRevision !== revision) return clone(state);
      if (!account.address || !Array.isArray(tasks) || !Array.isArray(providers) || !Array.isArray(jobs) || !Array.isArray(activity)) throw new Error('DeGPU 服务返回了不完整的网络状态。');
      const types = tasks.map(task => ({ ...task, id: task.name, name: taskNames[task.name] || task.name,
        pluginName: task.name, chainId: task.task_id, registered: true, compare: task.name === 'blender-render-v1' ? 'similar' : 'exact',
        defaultPrice: weiToEth(task.default_price_wei || '0'), available: true,
      }));
      // A bounded queue avoids issuing one expensive chain scan per job at once.
      const pending = [...jobs];
      const detailMap = new Map();
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && currentRevision === revision) {
          const summary = pending.shift();
          const cached = jobDetails.get(summary.ref);
          const finalized = cached?.closed && (cached.timeline || []).some(event => event.event === 'JobClosed' && confirmedEvent(event));
          const detail = finalized ? cached : await request(`/jobs/${encodeURIComponent(summary.ref)}`);
          detailMap.set(summary.ref, detail);
        }
      }));
      if (currentRevision !== revision) return clone(state);
      for (const [ref, detail] of detailMap) jobDetails.set(ref, detail);
      const normalizedJobs = jobs.map(job => normalizeJob(detailMap.get(job.ref) || job, types, results.get(job.ref), metadata.get(job.ref), network.timestamp));
      const unlockedAccount = { ...account, id: account.address, name: status.wallet?.name || account.address,
        username: status.wallet?.name, source: 'wallet', balance: weiToEth(account.balance_wei),
        locked: weiToEth(normalizedJobs.filter(job => !job.closed && sameAddress(job.clientAddress, account.address))
          .reduce((sum, job) => sum + BigInt(job.deposit_wei || '0') + BigInt(job.dispute_bond_wei || '0'), 0n)),
      };
      // Scope saved prices by network and wallet; they can be restored after reload.
      state.network = network;
      const ownState = { ...own, warning: providerWarning };
      const allProviders = providers.map(provider => normalizeProvider(provider, account.address, ownState, rememberedOffers(provider.address)));
      state = { ...emptyState(), network, unlocked: true, wallet: status.wallet, wallets,
        users: [unlockedAccount], account: unlockedAccount, taskTypes: types,
        providers: allProviders, selfProvider: normalizeProvider(own, account.address, ownState, rememberedOffers(account.address)),
        jobs: normalizedJobs, activity,
      };
      emit();
      return clone(state);
    } catch (error) {
      if (currentRevision === revision) {
        if (error.status === 423) { clearPrivateState(); identity = ''; state = emptyState(); }
        state.network = { ...state.network, connected: false, connectionError: error.message };
        emit();
      }
      throw error;
    }
  }

  async function connect() {
    if (!timer && pollMs > 0) timer = setInterval(async () => {
      if (polling || mutations || globalThis.document?.hidden) return;
      polling = true;
      try { await refresh(); } catch { /* expose the error in network.connectionError */ }
      finally { polling = false; }
    }, pollMs);
    return refresh();
  }

  function requireWallet() {
    if (!state.network.connected) throw new Error('DeGPU 服务未连接，暂时无法提交操作。');
    if (!state.unlocked) throw new Error('请先解锁钱包并加入网络。');
  }

  async function mutate(path, body, { needsWallet = true } = {}) {
    if (needsWallet) requireWallet();
    mutations += 1;
    revision += 1;
    try {
      const result = await request(path, { method: 'POST', body });
      if (path.startsWith('/provider/')) providerWarning = result.warning || null;
      if (path === '/lock' || path === '/unlock') {
        clearPrivateState();
        identity = '';
        state = { ...emptyState(), wallets: state.wallets, wallet: result.wallet,
          network: { ...emptyState().network, connected: true, url: result.network?.url || '',
            walletUnlocked: result.unlocked, joined: result.unlocked, walletName: result.wallet?.name || '', serving: result.serving },
        };
        emit();
      }
      // A transaction can be confirmed even when the next read fails.
      try { await refresh(); } catch { /* the visible connection state carries the read error */ }
      if (result.warning && state.selfProvider) {
        state.selfProvider.warning = result.warning;
        const own = state.providers.find(p => sameAddress(p.address, state.account.address));
        if (own) own.warning = result.warning;
        emit();
      }
      return result;
    } finally { mutations -= 1; }
  }

  function requireOwnProvider(providerId) {
    requireWallet();
    if (providerId && !sameAddress(providerId, state.account.address)) throw new Error('只能操作当前钱包的机器。');
  }

  const pricesToWei = offers => Object.fromEntries(Object.entries(offers || {}).map(([name, price]) => [name, ethToWei(price)]));
  const setPrices = async ({ providerId, offers, prices_wei } = {}) => {
    requireOwnProvider(providerId);
    return mutate('/provider/prices', { prices_wei: prices_wei || pricesToWei(offers) });
  };

  async function createJob(input = {}) {
    requireWallet();
    const postingIdentity = identity;
    const taskName = input.task || input.taskType;
    const task = state.taskTypes.find(type => type.id === taskName);
    if (!task) throw new Error('该任务类型未在当前网络部署。');
    const main = input.main || input.provider || input.providerId;
    if (!main) throw new Error('请选择提供方。');
    if (sameAddress(main, state.account.address)) throw new Error('不能把任务交给自己的机器。');
    const form = new FormData();
    form.append('task', taskName);
    form.append('main', main);
    if (task.mode === 'replicated') form.append('verify', String(input.verify === true));
    const fields = { ...input.fields };
    if (taskName === 'key-search-v1') {
      fields.keys ??= input.keys ?? input.itemCount;
      fields.bits ??= input.bits;
      fields.impossible ??= input.impossible;
    } else if (taskName === 'image-classify-v1') fields.limit ??= input.limit ?? input.itemCount;
    else if (taskName === 'blender-render-v1') fields.frames ??= Array.isArray(input.frames) ? input.frames.join(',') : input.frames || input.frameSpec;
    const files = { ...input.files };
    for (const field of task.fields || []) {
      const name = field.name;
      if (field.type === 'file' || field.type === 'files') {
        let selected = files[name] ?? input[name] ?? input.uploadIds?.[name];
        if (selected == null) continue; // The backend applies its documented local default.
        if (!Array.isArray(selected)) selected = [selected];
        for (let file of selected) {
          if (typeof file === 'string') {
            if (!uploads.has(file)) throw new Error(`文件 ${name} 的待上传记录已失效，请重新选择。`);
            file = uploads.get(file);
          }
          if (!file?.arrayBuffer || !file.name || file.size <= 0) throw new Error(`请选择有效的 ${name} 文件。`);
          form.append(name, file, file.name);
        }
      } else if (fields[name] != null) form.append(name, String(fields[name]));
    }
    const response = await mutate('/jobs', form);
    if (!response.ref) throw new Error('DeGPU 服务未返回新任务编号，请先查看任务列表。');
    if (postingIdentity !== identity) return response.ref;
    metadata.set(response.ref, { ...(Array.isArray(input.frames) ? { frames: clone(input.frames) } : {}),
      ...(input.sceneName ? { sceneName: input.sceneName } : {}), ...(input.modelName ? { modelName: input.modelName } : {}) });
    jobDetails.set(response.ref, response);
    const normalized = normalizeJob(response, state.taskTypes, [], metadata.get(response.ref), state.network.timestamp);
    state.jobs = [normalized, ...state.jobs.filter(job => job.id !== response.ref)];
    emit();
    for (const value of Object.values(input.uploadIds || {}).flat()) uploads.delete(value);
    return response.ref;
  }

  async function getResults(id) {
    requireWallet();
    const readingIdentity = identity;
    const result = await request(`/jobs/${encodeURIComponent(id)}/results`);
    if (readingIdentity !== identity) throw new Error('钱包已切换，请重新读取当前钱包的任务结果。');
    const job = state.jobs.find(entry => entry.id === id);
    const normalized = (result.items || []).map(item => ({ ...item, found: result.kind === 'value' ? item.value !== null : Boolean(item.file),
      ...(result.kind === 'file' ? { previewUrl: item.file, downloadUrl: item.file, filename: `item-${String(item.index).padStart(4, '0')}${result.suffix || '.bin'}`, frame: job?.frames?.[item.index] }
        : job?.taskType === 'image-classify-v1' ? { classId: item.value, labelId: item.value } : { key: item.value }),
      disputed: item.mismatched === true, verified: job?.outcome === 'Verified' && !item.mismatched,
    }));
    results.set(id, normalized);
    if (job) { job.results = normalized; job.resultKind = result.kind; emit(); }
    return { ...result, items: normalized };
  }

  return Object.freeze({
    connect, refresh, createJob, getResults, getState: () => clone(state),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listWallets: () => request('/wallets'), status: () => request('/status'),
    createWallet: input => mutate('/wallets', { name: input.name, password: input.password,
      ...((input.private_key || input.privateKey) ? { private_key: input.private_key || input.privateKey } : {}) }, { needsWallet: false }),
    importWallet(input) {
      const key = input.private_key || input.privateKey;
      if (!key) throw new Error('请输入要导入的钱包私钥。');
      return mutate('/wallets', { name: input.name, password: input.password, private_key: key }, { needsWallet: false });
    },
    unlockWallet: input => mutate('/unlock', { name: input.name, password: input.password, ...(input.network ? { network: input.network } : {}) }, { needsWallet: false }),
    lockWallet: () => mutate('/lock', undefined, { needsWallet: false }),
    claimFaucet: () => mutate('/faucet'),
    registerMachine: ({ stake = '0.8', stake_wei, offers, prices_wei } = {}) => mutate('/provider/register', { stake_wei: stake_wei || ethToWei(stake), ...(prices_wei || offers ? { prices_wei: prices_wei || pricesToWei(offers) } : {}) }),
    addStake: ({ amount, amount_wei } = {}) => mutate('/provider/stake', { amount_wei: amount_wei || ethToWei(amount) }),
    withdrawStake: ({ amount, amount_wei } = {}) => mutate('/provider/withdraw', { amount_wei: amount_wei || ethToWei(amount) }),
    stakeProvider: ({ amount, amount_wei } = {}) => mutate('/provider/stake', { amount_wei: amount_wei || ethToWei(amount) }),
    withdrawProvider: ({ amount, amount_wei } = {}) => mutate('/provider/withdraw', { amount_wei: amount_wei || ethToWei(amount) }),
    updateProviderOffers: setPrices, setProviderPrices: setPrices,
    async setProviderServing({ providerId, on, enabled, behavior } = {}) {
      requireOwnProvider(providerId);
      const serve = on ?? enabled;
      if (typeof serve !== 'boolean') throw new Error('运行状态须为布尔值。');
      return mutate('/provider/serve', { on: serve, ...(behavior ? { behavior } : {}) });
    },
    async setProviderAutomation({ providerId, enabled } = {}) {
      requireOwnProvider(providerId);
      if (typeof enabled !== 'boolean') throw new Error('运行状态须为布尔值。');
      return mutate('/provider/serve', { on: enabled });
    },
    async setProviderListing({ providerId, enabled } = {}) {
      requireOwnProvider(providerId);
      if (typeof enabled !== 'boolean') throw new Error('上架状态须为布尔值。');
      const provider = state.selfProvider;
      if (!provider?.registered) throw new Error('请先登记机器。');
      if (!enabled) {
        if (Object.values(provider.offers).some(value => BigInt(ethToWei(value)) > 0n)) rememberOffers(provider.address, provider.offers);
        return setPrices({ providerId, prices_wei: Object.fromEntries(Object.keys(provider.offers).map(name => [name, '0'])) });
      }
      const offers = rememberedOffers(provider.address);
      if (!offers || !Object.values(offers).some(value => BigInt(ethToWei(value)) > 0n)) throw new Error('请先为要提供的任务设置非零报价。');
      return setPrices({ providerId, offers });
    },
    cancelJob: id => mutate(`/jobs/${encodeURIComponent(id)}/cancel`),
    expireJob: id => mutate(`/jobs/${encodeURIComponent(id)}/expire`),
    async uploadFile(file) {
      requireWallet();
      if (!file?.arrayBuffer || !file.name || file.size <= 0) throw new Error('请选择有效的非空文件。');
      if (file.size > 256 * 1024 * 1024) throw new Error('单个文件不能超过 256 MiB。');
      const id = `local-file-${++uploadSequence}`;
      uploads.set(id, file);
      return { id, name: file.name, size: file.size };
    },
    advanceJob() { throw new Error('任务由 DeGPU 后台自动运行，请保持本机服务开启。'); },
    acceptResults() { throw new Error('渲染结果由 DeGPU 后台自动核对和验收。'); },
    disputeResults() { throw new Error('渲染争议由 DeGPU 后台按实际结果自动提交。'); },
    passDeadline() { throw new Error('真实网络使用实际时间，不能跳过任务截止时间。'); },
    processProvider() { throw new Error('请开启运行状态，由 DeGPU 后台自动处理任务。'); },
    selectAccount() { throw new Error('切换钱包需要密码，请在账户页面解锁钱包。'); },
    reset() { throw new Error('真实网络不能通过网页重置。'); },
    disconnect() { clearInterval(timer); timer = null; revision += 1; state.network.connected = false; emit(); },
  });
}
