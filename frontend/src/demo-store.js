// An isolated simulation of the existing JobMarket interface, not an RPC client.
// ETH accounting uses wei internally; the demo account's figures exclude gas.
import { NETWORK_USERS, NETWORK_PROVIDERS, networkHistoryInputs } from './network-fixtures.js';
import { CHECKED_TASKS, checkedFixtures, checkedItemsHash, checkedSubmission, checkCheckedAnswer, hexBytes } from './checked-tasks.js';
import { getMarketCompetitionSnapshot, MARKET_COMPETITION_ROUNDS } from './market.js';

const TASK_TYPES = [
  { id: 'image-classify-v1', mode: 'replicated', compare: 'exact', chainId: 2, name: '图像分类', registered: true, maxItems: 1000, defaultItems: 200, secondsPerItem: 1 },
  { id: 'blender-render-v1', mode: 'replicated', compare: 'similar', chainId: 1, name: 'Blender 渲染', registered: true, maxItems: 1000, defaultItems: 12, secondsPerItem: 30 },
  ...CHECKED_TASKS,
];

const WEI = 10n ** 18n;
const MIN_STAKE = WEI * 8n / 10n;
const TIEBREAK_FEE = WEI / 500n;
const CLIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const MARKET = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const CHECKED_MARKET = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ADDRESSES = [
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026e726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
];
const SCENARIOS = new Set(['verified', 'unverified', 'main-cheat', 'verifier-cheat', 'main-offline', 'verifier-offline']);
const STEPS = ['create', 'accept', 'commit', 'decision', 'shareB', 'shareC', 'commitB', 'commitC', 'revealB', 'revealC', 'publish', 'tieShare', 'tie', 'settle'];
const CHECK_STEPS = ['shareB', 'shareC', 'commitB', 'commitC', 'revealB', 'revealC'];
const LABELS = ['虎斑猫', '金毛犬', '跑车', '帆船', '教堂', '锦鲤'];
const clone = (value) => structuredClone(value);
const wei = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'));
};
const eth = (amount) => {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % WEI).toString().padStart(18, '0').replace(/0+$/, '').padEnd(3, '0');
  return `${sign}${absolute / WEI}.${fraction}`;
};
// Deliberately synthetic identifiers. These are not cryptographic commitments.
const demoHash = (kind, number) => `0x${kind}${number.toString(16).padStart(64 - kind.length, '0')}`;
const event = (name, args = {}) => ({ name, args });
const mismatchCount = (job) => ['main-cheat', 'similar-missing'].includes(job.scenario) ? Math.max(1, Math.floor(job.itemCount / 5)) : job.scenario === 'verifier-cheat' ? job.itemCount : 0;
const resultLeaf = (job, index, role = 'honest') => {
  const kind = role === 'main' && job.scenario === 'main-cheat' && index < mismatchCount(job)
    ? 'baad' : role === 'verifier' && job.scenario === 'verifier-cheat' ? 'dead'
      : job.compare === 'similar' ? role === 'main' ? 'f11e' : role === 'verifier' ? 'f12e' : 'f13e' : '1eaf';
  return demoHash(kind, job.chainJobId * 1001 + index);
};

export function createDemoStore({ profile = 'compact' } = {}) {
  let state;
  let accounts;
  let selectedAccountId;
  let clock;
  let nextBlock;
  let nextTransaction;
  const listeners = new Set();
  const findProvider = (id) => state.providers.find((provider) => provider.id === id);
  const findAccount = (id = selectedAccountId) => {
    const account = accounts.get(id);
    if (!account) throw new Error('账户不存在');
    return account;
  };
  const findJob = (id) => {
    const job = state.jobs.find((item) => item.id === String(id));
    if (!job) throw new Error('任务不存在');
    return job;
  };
  const notify = () => {
    for (const listener of listeners) listener(getState());
  };
  const getState = () => {
    const snapshot = clone(state);
    for (const provider of snapshot.providers) {
      if (provider.ownerId === selectedAccountId) provider.listingBusy = isProviderBusy(provider);
    }
    return snapshot;
  };

  function refreshAccount() {
    for (const provider of state.providers) {
      provider.statsByMode.replicated = Object.fromEntries(['verified', 'unverified', 'missed', 'outvoted', 'checksCompleted', 'checksMissed', 'checksOutvoted']
        .map((key) => [key, provider[key]]));
    }
    state.users = [...accounts.values()].map((account) => {
      const locked = state.jobs.filter((job) => !job.closed && job.clientId === account.id)
        .reduce((sum, job) => sum + wei(job.deposit) + wei(job.disputeBond ?? '0'), 0n);
      return {
        id: account.id, name: account.name, address: account.address,
        initialBalance: eth(account.initialBalance), balance: eth(account.balance), locked: eth(locked),
        net: eth(account.balance - account.initialBalance),
        settledNet: eth(account.returned - account.deposited + locked),
        deposited: eth(account.deposited), returned: eth(account.returned), gasExcluded: true,
      };
    });
    state.account = { ...state.users.find((account) => account.id === selectedAccountId) };
    state.network.latestBlock = nextBlock - 1;
    state.network.timestamp = clock;
  }

  function refreshOpenJobs() {
    // EVM time belongs to the network, so advancing one scenario can expire
    // another task. Time alone never emits an event or closes a job.
    for (const job of state.jobs) {
      if (!job.closed) job.deadlinePassed = clock > job.deadline;
      refreshProgress(job);
    }
  }

  function mineBlock(entries) {
    const number = nextBlock++;
    clock += 12;
    const hash = demoHash('d3b1', number);
    const previous = state.blocks.at(-1);
    const block = {
      number, hash, parentHash: previous?.hash ?? demoHash('d3b1', number - 1),
      timestamp: clock, transactions: [], gasUsed: 0,
    };
    let nextLogIndex = 0;
    entries.forEach(({ job, method, actor, events, gasUsed = 95000 }, transactionIndex) => {
      // A transaction has its own identity even when several share one block.
      const transactionHash = demoHash('d3a1', nextTransaction++);
      const logs = events.map((entry) => ({
        ...entry, args: { jobId: job.chainJobId, ...entry.args },
        mode: job.mode, marketAddress: job.marketAddress, address: job.marketAddress,
        blockNumber: number, blockHash: hash, transactionHash, transactionIndex,
        logIndex: nextLogIndex++,
      }));
      block.transactions.push(transactionHash);
      block.gasUsed += gasUsed;
      state.transactions.push({
        hash: transactionHash, blockNumber: number, blockHash: hash, transactionIndex, timestamp: clock,
        from: actor === 'client' ? job.clientAddress : findProvider(actor).address, to: job.marketAddress,
        mode: job.mode, marketAddress: job.marketAddress, chainJobId: job.chainJobId,
        method, jobId: job.id, status: 1, gasUsed, events: logs,
        value: method === 'createJob' ? job.deposit : method === 'dispute' ? job.disputeBond : '0.000',
      });
      job.events.push(...logs);
      if (events.some((entry) => entry.name === 'JobClosed')) job.closeMethod = method;
      job.createdBlock ??= number;
      job.updatedBlock = number;
    });
    state.blocks.push(block);
    refreshOpenJobs();
    refreshAccount();
    return block;
  }

  function mine(job, method, actor, events, gasUsed = 95000) {
    return mineBlock([{ job, method, actor, events, gasUsed }]);
  }

  function refreshProgress(job) {
    if (job.mode === 'checked') {
      job.progress = Object.fromEntries(['create', 'accept', 'search', 'submit', 'check', 'settle'].map((key) => [key, 'pending']));
      job.progress.create = 'done';
      const accepted = job.events.some((entry) => entry.name === 'JobAccepted');
      if (accepted) job.progress.accept = 'done';
      const submitted = job.events.some((entry) => entry.name === 'ResultsSubmitted');
      if (submitted) for (const key of ['search', 'submit', 'check']) job.progress[key] = 'done';
      job.nextAction = job.closed ? null : job.deadlinePassed ? 'expire' : job.scenario === 'checked-offline' && accepted ? 'wait' : 'advance';
      job.status = job.closed ? ({ Cancelled: '已取消', Delivered: job.solved ? '答案已验证' : '未找到答案', MainMissed: '主节点超时' })[job.outcome]
        : job.deadlinePassed ? '超时待推进' : job.phase === 'Open' ? '等待主节点接单' : '等待提交答案';
      job.actionLabel = job.nextAction === 'expire' ? '调用 expire' : job.nextAction === 'wait' ? '等待截止时间' : job.phase === 'Open' ? '主节点接单' : '提交答案并验证';
      if (job.closed) {
        job.progress.settle = 'done';
        for (const key of Object.keys(job.progress)) if (job.progress[key] === 'pending') job.progress[key] = 'skipped';
      } else job.progress[job.phase === 'Open' ? 'accept' : 'search'] = job.deadlinePassed ? 'pending' : 'current';
      return;
    }
    const steps = job.compare === 'similar' ? [...STEPS.slice(0, 11), 'review', 'dispute', ...STEPS.slice(11)] : STEPS;
    const progress = Object.fromEntries(steps.map((key) => [key, 'pending']));
    const done = (key) => { progress[key] = 'done'; };
    for (const entry of job.events) {
      const ordinary = {
        JobCreated: 'create', JobAccepted: 'accept', ResultsCommitted: 'commit',
        DecisionRevealed: 'decision', ResultsPublished: 'publish', TiebreakShared: 'tieShare',
        TiebreakSubmitted: 'tie', JudgementSubmitted: 'tie', ResultsDisputed: 'dispute', JobClosed: 'settle',
      }[entry.name];
      if (ordinary) done(ordinary);
      const prefix = { RangeShared: 'share', CheckCommitted: 'commit', CheckRevealed: 'reveal' }[entry.name];
      if (prefix) done(`${prefix}${entry.args.slot === 0 ? 'B' : 'C'}`);
    }
    if (job.compare === 'similar' && (job.review?.compared || job.events.some(entry => entry.name === 'ResultsDisputed') || job.closeMethod === 'acceptResults' || job.closeMethod === 'expire' && job.resultsURI)) done('review');
    if (!job.verify) for (const key of [...CHECK_STEPS, ...(job.compare === 'similar' ? [] : ['tieShare', 'tie'])]) progress[key] = 'skipped';
    if (job.closed && job.outcome !== 'MainMissed') {
      for (const key of ['tieShare', 'tie']) if (progress[key] !== 'done') progress[key] = 'skipped';
    }
    job.nextAction = job.closed ? null : 'advance';
    job.actionLabel = '';
    const current = (keys, status, actionLabel) => {
      for (const key of keys) progress[key] = 'current';
      job.status = status;
      job.actionLabel = actionLabel;
    };
    if (job.closed) {
      for (const key of steps) if (progress[key] === 'pending') progress[key] = 'skipped';
      job.status = ({ Cancelled: '已取消', Delivered: '交付完成', Verified: '复核通过', MainOutvoted: '提供方被否决', VerifierOutvoted: '复核方被否决', MainMissed: '提供方超时', DisputeRejected: '争议未成立', NoMajority: '未能达成裁决', TiebreakerMissed: '裁决方超时', TieClientNoShare: '客户未分享裁决资料' })[job.outcome];
    } else if (job.phase === 'Open') {
      current(['accept'], '等待主节点接单', '主节点接单');
    } else if (job.phase === 'Committing') {
      current(['commit'], '等待主节点提交承诺', '提交结果承诺');
      if (job.scenario === 'main-offline') {
        job.nextAction = job.deadlinePassed ? 'expire' : 'wait';
        job.status = job.deadlinePassed ? '超时待推进' : '主节点离线，等待截止时间';
        job.actionLabel = job.deadlinePassed ? '调用 expire' : '推进至截止时间';
      }
    } else if (job.phase === 'Deciding') {
      current(['decision'], '等待公开复核决定', '公开复核决定');
    } else if (job.phase === 'Checking') {
      const shared = job.verifierStates;
      if (shared.includes('Assigned')) {
        const slot = shared.indexOf('Assigned');
        current(shared.flatMap((value, index) => value === 'Assigned' ? [`share${index === 0 ? 'B' : 'C'}`] : []), '等待分享复核资料', `分享资料给复核节点 ${job.verifiers[slot]}`);
      } else {
        const slot = shared.indexOf('Shared');
        current(shared.flatMap((value, index) => value === 'Shared' ? [`commit${index === 0 ? 'B' : 'C'}`] : []), '等待复核节点提交承诺', `复核节点 ${job.verifiers[slot]} 提交承诺`);
      }
    } else if (job.phase === 'CheckReveal') {
      const slot = job.verifierStates.indexOf('Committed');
      current(job.verifierStates.flatMap((value, index) => value === 'Committed' ? [`reveal${index === 0 ? 'B' : 'C'}`] : []), `等待复核节点 ${job.verifiers[slot]} 公开`, `复核节点 ${job.verifiers[slot]} 公开结果`);
      if (job.scenario === 'verifier-offline' && job.verifierStates.includes('Revealed')) {
        job.nextAction = job.deadlinePassed ? 'expire' : 'wait';
        job.status = job.deadlinePassed ? '超时待推进' : '复核节点离线，等待截止时间';
        job.actionLabel = job.deadlinePassed ? '处理复核超时' : '等待截止时间';
      }
    } else if (job.phase === 'Publishing') {
      current(['publish'], '等待提供方公开结果', job.compare === 'similar' ? '发布结果文件' : '公开结果并比对');
    } else if (job.phase === 'Disputing') {
      current(['review'], '等待客户检查结果', ['main-cheat', 'verifier-cheat', 'similar-missing', 'dispute-rejected'].includes(job.scenario) ? '提交争议' : '接受结果');
    } else if (job.phase === 'TieBreak') {
      current([job.tieShared ? 'tie' : 'tieShare'], job.tieShared ? '等待争议裁决' : '等待分享争议资料', job.tieShared ? '提交裁决并结算' : '分享争议资料');
    }
    if (!job.closed && job.deadlinePassed) {
      for (const key of steps) if (progress[key] === 'current') progress[key] = 'pending';
      const supported = (job.scenario === 'main-offline' && job.phase === 'Committing')
        || (job.scenario === 'verifier-offline' && job.phase === 'CheckReveal') || ['Disputing', 'TieBreak'].includes(job.phase);
      job.status = '超时待推进';
      job.nextAction = supported ? 'expire' : 'unsupported-timeout';
      job.actionLabel = supported ? '调用 expire' : '该超时分支暂不可用';
    }
    job.progress = progress;
  }

  function prepareJob(input, id, availableBalance) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务参数须为对象');
    const taskType = input.taskType ?? 'image-classify-v1';
    const registration = TASK_TYPES.find((type) => type.id === taskType);
    if (!registration?.registered) throw new Error('当前仅已注册 image-classify-v1、blender-render-v1 和 key-search-v1 任务');
    const mode = registration.mode;
    if (input.mode !== undefined && input.mode !== mode) throw new Error('任务类型与市场模式不一致');
    const itemCount = input.itemCount ?? input.frames?.length ?? input.items?.length ?? registration.defaultItems;
    if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > registration.maxItems) {
      throw new Error(`任务数量须为 1–${registration.maxItems} 的整数`);
    }
    let items;
    let frames;
    if (registration.compare === 'similar') {
      frames = input.frames === undefined ? Array.from({ length: itemCount }, (_, index) => index + 1) : input.frames;
      if (!Array.isArray(frames) || frames.length !== itemCount || frames.some(frame => !Number.isSafeInteger(frame) || frame < 0)) throw new Error('帧列表须与任务数量一致，并使用非负安全整数');
      frames = [...frames];
    }
    if (mode === 'checked') {
      if (input.items !== undefined) {
        if (!Array.isArray(input.items) || input.items.length !== itemCount) throw new Error('输入列表须与任务数量一致');
        items = Array.from(input.items, (item) => { hexBytes(item); return item.toLowerCase(); });
      } else items = checkedFixtures(taskType, itemCount, input.fixtureIds).map((fixture) => fixture.item);
    }
    let scenario = input.scenario ?? (input.verify === false ? 'unverified' : 'verified');
    if (mode === 'checked') {
      if (['verified', 'unverified'].includes(scenario)) scenario = 'checked-success';
      if (!['checked-success', 'checked-partial', 'checked-none', 'checked-invalid', 'checked-offline'].includes(scenario)) throw new Error('未知 checked 处理方案');
    } else {
      if (!SCENARIOS.has(scenario) && !(registration.compare === 'similar' && ['similar-missing', 'dispute-rejected'].includes(scenario))) throw new Error('未知处理方案');
      if (scenario === 'verified' && input.verify === false) scenario = 'unverified';
    }
    if (mode === 'checked' && scenario === 'checked-invalid') checkedSubmission({ taskType, items, scenario });
    const verify = mode === 'replicated' && !['unverified', 'main-offline'].includes(scenario);
    const provider = findProvider(input.provider ?? input.providerId ?? 'A');
    if (!provider?.active) throw new Error('主节点未注册或质押不足');
    const account = findAccount(input.clientId ?? selectedAccountId);
    if (provider.address.toLowerCase() === account.address.toLowerCase()) throw new Error('主节点不能是任务客户');
    const unitPrice = wei(provider.offers[taskType] ?? '0');
    if (unitPrice <= 0n) throw new Error('主节点不提供该任务类型');
    const price = BigInt(itemCount) * unitPrice;
    const deposit = (mode === 'checked' ? 1n : 2n) * price;
    if (availableBalance < deposit) throw new Error('账户余额不足');
    return {
      id: `${mode}:${id}`, chainJobId: id, localId: id, mode,
      marketAddress: mode === 'checked' ? CHECKED_MARKET : MARKET,
      taskType, taskTypeId: registration.chainId, compare: registration.compare, secondsPerItem: registration.secondsPerItem,
      itemCount, provider: provider.id, verify, scenario,
      clientId: account.id, clientAddress: account.address, unitPrice: eth(unitPrice),
      modelName: mode === 'checked' || registration.compare === 'similar' ? '' : String(input.modelName || 'MobileNetV2.onnx'),
      ...(registration.compare === 'similar' ? { frames, sceneName: String(input.sceneName || 'scene.blend'),
        resultsURI: '', verifierResultsURIs: [], disputeBond: '0.000', disputedItems: [], verdicts: [],
        review: { compared: false, disputed: false }, executionSource: 'local-protocol-fixtures', resultFilesAvailable: false } : {}),
      inputNames: Array.isArray(input.inputNames) ? input.inputNames.map(String) : [],
      ...(mode === 'checked' ? { items, itemsHash: checkedItemsHash(items), solved: 0,
        inputSource: input.items === undefined ? 'built-in' : 'public-bytes', executionSource: 'fixture-answers-real-checker' } : {}),
      phase: 'Open', status: '', closed: false, outcome: null,
      events: [], progress: {}, coverage: 0, mismatches: 0, settlement: null,
      deadlinePassed: false, deadline: clock + 12 + 300, results: [],
      verifiers: [], verifierStates: [], tieProvider: null, tiebreaker: null, tieShared: false, tieSubmitted: false,
      price: eth(price), deposit: eth(deposit), resultWarning: '', slashedPool: '0.000',
      drawMode: 'demo-deterministic',
    };
  }

  function creationEntry(job) {
    const provider = findProvider(job.provider);
    if (job.mode === 'checked') return { job, method: 'createJob', actor: 'client', gasUsed: 180000,
      events: [event('JobCreated', { client: job.clientAddress, main: provider.address, taskType: job.taskTypeId, items: [...job.items] })] };
    return { job, method: 'createJob', actor: 'client', gasUsed: 320000, events: [event('JobCreated', {
      client: job.clientAddress, main: provider.address, taskType: job.taskTypeId, numItems: job.itemCount,
      dataHash: demoHash('da7a', job.chainJobId), dataURI: `local:manifest:${job.id}`,
      verifyCommit: demoHash('c011', job.chainJobId), sealedForMain: '0x64656d6f',
    })] };
  }

  function depositJob(job) {
    state.jobs.push(job);
    const account = findAccount(job.clientId);
    account.balance -= wei(job.deposit);
    account.deposited += wei(job.deposit);
  }

  function createJob(input = {}, emit = true) {
    const account = findAccount(input?.clientId ?? selectedAccountId);
    const mode = TASK_TYPES.find((type) => type.id === (input?.taskType ?? 'image-classify-v1'))?.mode;
    const job = prepareJob(input, state.jobs.filter((job) => job.mode === mode).length + 1, account.balance);
    const entry = creationEntry(job);
    depositJob(job);
    mineBlock([entry]);
    if (emit) notify();
    return job.id;
  }

  function createJobsInBlock(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 6) throw new Error('同一区块须包含 2–6 个任务');
    // Prepare the entire batch, including its combined escrow, before mutation.
    // This groups independent transactions; it does not invent a batch method
    // on JobMarket or make real independent EVM transactions atomic.
    const availableBalances = new Map([...accounts].map(([id, account]) => [id, account.balance]));
    const nextIds = { replicated: state.jobs.filter((job) => job.mode === 'replicated').length + 1,
      checked: state.jobs.filter((job) => job.mode === 'checked').length + 1 };
    const jobs = Array.from(inputs, (input, index) => {
      const clientId = input?.clientId ?? selectedAccountId;
      const mode = TASK_TYPES.find((type) => type.id === (input?.taskType ?? 'image-classify-v1'))?.mode;
      const job = prepareJob(input, nextIds[mode]++, availableBalances.get(clientId));
      availableBalances.set(clientId, availableBalances.get(clientId) - wei(job.deposit));
      return job;
    });
    const entries = jobs.map(creationEntry);
    jobs.forEach(depositJob);
    const block = mineBlock(entries);
    notify();
    return { jobIds: jobs.map((job) => job.id), blockNumber: block.number, blockHash: block.hash, transactionHashes: [...block.transactions] };
  }

  function resultSamples(job) {
    return Array.from({ length: job.compare === 'similar' ? job.itemCount : Math.min(6, job.itemCount) }, (_, index) => {
      const disputed = job.scenario === 'main-cheat' && index < job.mismatches;
      const slot = index < Math.floor(job.itemCount / 2) ? 0 : 1;
      const common = {
        index, source: 'main',
        verified: job.verifierStates[slot] === 'Revealed' && !disputed && job.scenario !== 'verifier-cheat', disputed,
      };
      if (job.compare === 'similar') return {
        ...common, verified: false, frame: job.frames[index], filename: `frame-${String(job.frames[index]).padStart(4, '0')}.png`,
        inputName: job.sceneName, digest: resultLeaf(job, index, 'main'),
        available: job.scenario !== 'similar-missing' || index >= mismatchCount(job),
        comparisonSource: 'local-protocol-fixture',
      };
      return {
        ...common, inputName: job.inputNames[index] || `image-${String(index + 1).padStart(3, '0')}.jpg`,
        label: disputed ? LABELS[(index + 1) % LABELS.length] : LABELS[index],
        labelId: disputed ? (index + 1) % 1000 : index,
      };
    });
  }

  function settle(job, outcome, logs) {
    const price = wei(job.price);
    let slashed = wei(job.slashedPool);
    let main = ['Cancelled', 'MainOutvoted', 'MainMissed', 'NoMajority'].includes(outcome) || job.unresolvedMask ? 0n : price;
    let verifierB = 0n;
    let verifierC = 0n;
    let tiebreak = 0n;
    const slash = (id, bps, counter) => {
      const provider = findProvider(id);
      const amount = wei(provider.stake) * BigInt(bps) / 10000n;
      provider.stake = eth(wei(provider.stake) - amount);
      provider.active = wei(provider.stake) >= MIN_STAKE;
      provider[counter] += 1;
      slashed += amount;
      logs.push(event('ProviderSlashed', { provider: provider.address, amount: amount.toString(), amountEth: eth(amount) }));
    };
    if (outcome === 'MainOutvoted') slash(job.provider, 3000, 'outvoted');
    if (outcome === 'MainMissed') slash(job.provider, 1000, 'missed');
    if (job.verifiers.length) {
      {
        // Fee ranges use the price snapshot made when the job was created,
        // independent of what the selected verifiers quote for their own work.
        const firstFee = BigInt(Math.floor(job.itemCount / 2)) * wei(job.unitPrice);
        const outvoted = slot => job.compare === 'similar' ? Boolean((job.outvotedMask ?? 0) & 1 << slot) : outcome === 'VerifierOutvoted';
        const unresolved = slot => Boolean((job.unresolvedMask ?? 0) & 1 << slot);
        if (job.verifierStates[0] === 'Revealed' && !unresolved(0) && !outvoted(0)) verifierB = firstFee;
        if (job.verifierStates[1] === 'Revealed' && !unresolved(1) && !outvoted(1)) verifierC = price - firstFee;
        job.verifiers.forEach((id, slot) => {
          if (outvoted(slot)) {
            slash(id, 3000, 'checksOutvoted');
            job.verifierStates[slot] = 'Outvoted';
          } else if (job.verifierStates[slot] === 'Revealed' && !unresolved(slot)) findProvider(id).checksCompleted += 1;
        });
      }
    }
    if (job.tieProvider) {
      if (outcome === 'TiebreakerMissed') slash(job.tieProvider, 500, 'checksMissed');
      else if (job.tieSubmitted) {
        const available = 2n * price + slashed + wei(job.disputeBond ?? '0') - main - verifierB - verifierC;
        tiebreak = TIEBREAK_FEE < available ? TIEBREAK_FEE : available;
        findProvider(job.tieProvider).checksCompleted += 1;
      }
    }
    if (main > 0n) findProvider(job.provider)[['Verified', 'VerifierOutvoted'].includes(outcome) || outcome === 'DisputeRejected' && job.verifierStates.includes('Revealed') ? 'verified' : 'unverified'] += 1;
    const totalDeposited = 2n * price + wei(job.disputeBond ?? '0');
    const refund = totalDeposited + slashed - main - verifierB - verifierC - tiebreak;
    const payout = (id, amount) => {
      if (amount === 0n) return;
      const to = id === 'client' ? job.clientAddress : findProvider(id).address;
      if (id !== 'client') findProvider(id).earned = eth(wei(findProvider(id).earned) + amount);
      logs.push(event('Payout', { to, amount: amount.toString(), amountEth: eth(amount) }));
    };
    payout(job.provider, main);
    payout(job.verifiers[0], verifierB);
    payout(job.verifiers[1], verifierC);
    payout(job.tieProvider, tiebreak);
    payout('client', refund);
    const remainingVerifiers = job.verifiers.filter((_, slot) => job.verifierStates[slot] !== 'Missed');
    // An Open job has not locked any provider; cancellation refunds escrow only.
    for (const id of (outcome === 'Cancelled' ? [] : [job.provider, ...remainingVerifiers, job.tieProvider]).filter(Boolean)) {
      findProvider(id).lockedJobs -= 1;
    }
    const account = findAccount(job.clientId);
    account.balance += refund;
    account.returned += refund;
    job.closed = true;
    job.phase = 'Closed';
    job.outcome = outcome;
    if (outcome === 'VerifierOutvoted') job.results.forEach((row) => { row.verified = true; });
    job.settlement = {
      deposit: job.deposit, main: eth(main), verifierB: eth(verifierB), verifierC: eth(verifierC),
      tiebreak: eth(tiebreak), refund: eth(refund), slashed: eth(slashed), clientNet: eth(refund - totalDeposited),
      ...(job.compare === 'similar' ? { disputeBond: job.disputeBond, totalDeposited: eth(totalDeposited) } : {}),
    };
    logs.push(event('JobClosed', { outcome }));
  }

  function cancelJob(id, clientId) {
    const job = findJob(id);
    if (job.closed || job.phase !== 'Open') throw new Error('仅待接单任务可取消');
    // An optional clientId checks ownership, never authorizes acting on behalf
    // of another account. The currently selected account must own the job.
    if (job.clientId !== selectedAccountId || (clientId !== undefined && clientId !== job.clientId)) {
      throw new Error('只能取消当前账户发布的任务');
    }
    const logs = [];
    if (job.mode === 'checked') settleChecked(job, 'Cancelled', logs);
    else settle(job, 'Cancelled', logs);
    mine(job, 'cancel', 'client', logs, 65000);
    notify();
    return getState();
  }

  function settleChecked(job, outcome, logs) {
    const provider = findProvider(job.provider);
    const stats = provider.statsByMode.checked;
    let main = 0n;
    let slashed = 0n;
    if (outcome === 'Delivered') {
      stats.completed += 1;
      stats.itemsSolved += job.solved;
      stats.itemsNotFound += job.itemCount - job.solved;
      main = BigInt(job.solved) * wei(job.unitPrice);
    } else if (outcome === 'MainMissed') {
      stats.missed += 1;
      slashed = wei(provider.stake) / 10n;
      provider.stake = eth(wei(provider.stake) - slashed);
      provider.active = wei(provider.stake) >= MIN_STAKE;
      logs.push(event('ProviderSlashed', { provider: provider.address, amount: slashed.toString(), amountEth: eth(slashed) }));
    }
    const refund = wei(job.deposit) + slashed - main;
    if (main > 0n) {
      provider.earned = eth(wei(provider.earned) + main);
      logs.push(event('Payout', { to: provider.address, amount: main.toString(), amountEth: eth(main) }));
    }
    if (refund > 0n) logs.push(event('Payout', { to: job.clientAddress, amount: refund.toString(), amountEth: eth(refund) }));
    if (job.phase === 'Working') provider.lockedJobs -= 1;
    const account = findAccount(job.clientId);
    account.balance += refund;
    account.returned += refund;
    job.closed = true;
    job.phase = 'Closed';
    job.outcome = outcome;
    job.settlement = { deposit: job.deposit, main: eth(main), verifierB: '0.000', verifierC: '0.000',
      tiebreak: '0.000', refund: eth(refund), slashed: eth(slashed), clientNet: eth(refund - wei(job.deposit)) };
    logs.push(event('JobClosed', { outcome }));
  }

  function submitResults(id, submission, emit = true) {
    const job = findJob(id);
    // Validate the complete call before changing any state, just as a reverted
    // CheckedMarket transaction cannot retain a partial answer or payment.
    if (job.mode !== 'checked' || job.closed || job.phase !== 'Working') throw new Error('仅已接单 checked 任务可提交答案');
    if (!submission || typeof submission !== 'object') throw new Error('答案参数须为对象');
    if (submission.providerId !== undefined && submission.providerId !== job.provider) throw new Error('仅主节点可提交答案');
    if (clock + 12 > job.deadline) throw new Error('下一块时间已超过任务截止时间');
    const items = submission.items ?? job.items;
    const { answers, found } = submission;
    if (![items, answers, found].every((array) => Array.isArray(array) && array.length === job.itemCount)) throw new Error('输入、答案和 found 数量须与任务数量一致');
    if (checkedItemsHash(items) !== job.itemsHash) throw new Error('公开输入与创建任务时的承诺不一致');
    if (answers.some((answer) => hexBytes(answer).length !== 32) || found.some((value) => typeof value !== 'boolean')) throw new Error('答案须为 bytes32，found 须为布尔值');
    for (let index = 0; index < items.length; index += 1) {
      if (found[index] && !checkCheckedAnswer(job.taskType, items[index], answers[index])) throw new Error('提交的答案未通过链上校验');
    }
    const solved = found.filter(Boolean).length;
    job.solved = solved;
    job.answers = [...answers];
    job.found = [...found];
    job.results = answers.map((answer, index) => ({ index, item: items[index], found: found[index], answer,
      [job.taskType === 'nonce-search-v1' ? 'nonce' : 'key']: found[index] ? BigInt(answer).toString() : null,
      verified: found[index], verificationSource: found[index] ? 'on-chain-checker' : null }));
    delete job.lastSubmissionError;
    delete job.lastRejected;
    const logs = [event('ResultsSubmitted', { answers: [...answers], found: [...found] })];
    settleChecked(job, 'Delivered', logs);
    mine(job, 'submitResults', job.provider, logs, 125000 + solved * 12000);
    if (emit) notify();
    return emit ? getState() : undefined;
  }

  function startTiebreak(job, logs) {
    const tie = state.providers.find(provider => provider.active && wei(provider.offers[job.taskType] ?? '0') > 0n
      && ![job.provider, ...job.verifiers].includes(provider.id) && provider.address.toLowerCase() !== job.clientAddress.toLowerCase());
    if (!tie) {
      job.unresolvedMask = job.disputedItems.reduce((mask, item) => mask | 1 << (item < Math.floor(job.itemCount / 2) ? 0 : 1), 0);
      settle(job, 'NoMajority', logs);
      return;
    }
    job.tieProvider = tie.id;
    job.tiebreaker = tie.id;
    tie.lockedJobs += 1;
    job.phase = 'TieBreak';
    job.deadline = clock + 12 + 600 + job.mismatches * job.secondsPerItem;
    logs.push(event('TiebreakStarted', { tiebreaker: tie.address, mismatched: [...job.disputedItems] }));
  }

  function requireClientReview(id, clientOnly = true) {
    const job = findJob(id);
    if (job.closed || job.compare !== 'similar' || job.phase !== 'Disputing') throw new Error('仅文件相似性任务在结果检查阶段可操作');
    if (clientOnly && job.clientId !== selectedAccountId) throw new Error('仅任务客户可检查或争议结果');
    return job;
  }

  function acceptReviewedResults(id, emit = true, clientOnly = true) {
    const job = requireClientReview(id, clientOnly);
    const logs = [];
    job.review = { ...job.review, accepted: true };
    settle(job, job.verifierStates.includes('Revealed') ? 'Verified' : 'Delivered', logs);
    mine(job, 'acceptResults', 'client', logs, 165000);
    if (emit) notify();
    return emit ? getState() : undefined;
  }

  function disputeReviewedResults(id, items, emit = true, clientOnly = true) {
    const job = requireClientReview(id, clientOnly);
    if (clock + 12 > job.deadline) throw new Error('下一块时间已超过争议截止时间');
    const disputed = items ?? Array.from({ length: mismatchCount(job) || 1 }, (_, index) => index);
    if (!Array.isArray(disputed) || !disputed.length || disputed.some((item, index) => !Number.isInteger(item) || item < 0 || item >= job.itemCount || index > 0 && item <= disputed[index - 1])) throw new Error('争议序号须递增、不重复，且在任务范围内');
    const account = findAccount(job.clientId);
    if (account.balance < TIEBREAK_FEE) throw new Error('账户余额不足以支付争议保证金');
    account.balance -= TIEBREAK_FEE;
    account.deposited += TIEBREAK_FEE;
    job.disputeBond = eth(TIEBREAK_FEE);
    job.disputedItems = [...disputed];
    job.mismatches = disputed.length;
    job.review = { ...job.review, disputed: true };
    const logs = [event('ResultsDisputed', { items: [...disputed] })];
    startTiebreak(job, logs);
    mine(job, 'dispute', 'client', logs, 180000);
    if (emit) notify();
    return emit ? getState() : undefined;
  }

  function acceptResults(id) { return acceptReviewedResults(id); }
  function disputeResults(id, items) { return disputeReviewedResults(id, items); }

  function advanceJob(id, emit = true) {
    const job = findJob(id);
    if (job.closed) throw new Error('任务已结束');
    if (job.phase === 'Disputing' && !job.deadlinePassed) {
      const dispute = ['main-cheat', 'verifier-cheat', 'similar-missing', 'dispute-rejected'].includes(job.scenario);
      if (dispute && clock + 12 > job.deadline) throw new Error('下一块时间已超过争议截止时间');
      // These outcomes are local protocol fixtures. They neither compare PNG
      // pixels nor represent execution of Blender on this browser machine.
      return dispute ? disputeReviewedResults(id, undefined, emit, false) : acceptReviewedResults(id, emit, false);
    }
    if (job.mode === 'checked') {
      if (job.phase === 'Working') {
        if (job.nextAction !== 'advance') throw new Error('节点离线或截止时间已过；需要调用 expire');
        try {
          return submitResults(id, checkedSubmission(job, job.lastRejected ? 'checked-success' : job.scenario), emit);
        } catch (error) {
          if (job.scenario !== 'checked-invalid' || job.lastRejected || error.message !== '提交的答案未通过链上校验') throw error;
          job.lastSubmissionError = error.message;
          job.lastRejected = { confirmed: false, error: error.message, at: clock };
          if (emit) notify();
          throw error;
        }
      }
      if (clock + 12 > job.deadline) throw new Error('下一块时间已超过任务截止时间');
      if (!findProvider(job.provider).active) throw new Error('主节点未注册或质押不足');
      findProvider(job.provider).lockedJobs += 1;
      job.phase = 'Working';
      job.deadline = clock + 12 + 300 + job.itemCount * job.secondsPerItem;
      mine(job, 'accept', job.provider, [event('JobAccepted')]);
      if (emit) notify();
      return emit ? getState() : undefined;
    }
    // All preconditions must run before touching the job, its balance or logs.
    // Even a deadline that has not yet passed can reject the next mined block.
    if (clock + 12 > job.deadline) throw new Error('下一块时间已超过任务截止时间；需要调用 expire，该超时分支暂不可用');
    if (job.nextAction !== 'advance') throw new Error('主节点离线；截止时间后需要调用 expire');
    let method;
    let actor = job.provider;
    let logs;
    let gasUsed = 95000;
    switch (job.phase) {
      case 'Open':
        method = 'accept';
        findProvider(job.provider).lockedJobs += 1;
        job.phase = 'Committing';
        job.deadline = clock + 12 + 600 + job.itemCount * job.secondsPerItem;
        logs = [event('JobAccepted')];
        break;
      case 'Committing':
        method = 'commitResults';
        job.phase = 'Deciding';
        job.deadline = clock + 12 + 300;
        logs = [event('ResultsCommitted')];
        break;
      case 'Deciding': {
        method = 'revealDecision';
        actor = 'client';
        logs = [event('DecisionRevealed', { verify: job.verify })];
        if (job.verify) {
          // Deterministic demo assignment; production draws come from VerifiersDrawn.
          const drawStart = profile === 'network' ? job.chainJobId * 7 % state.providers.length : 0;
          const drawOrder = [...state.providers.slice(drawStart), ...state.providers.slice(0, drawStart)];
          const eligible = drawOrder.filter((provider) => provider.active && wei(provider.offers[job.taskType] ?? '0') > 0n && provider.id !== job.provider
            && provider.address.toLowerCase() !== job.clientAddress.toLowerCase()).slice(0, 2).map((provider) => provider.id);
          if (eligible.length !== 2) throw new Error('活跃复核节点不足');
          job.verifiers = eligible;
          job.verifierStates = ['Assigned', 'Assigned'];
          job.verifiers.forEach((id) => { findProvider(id).lockedJobs += 1; });
          job.phase = 'Checking';
          logs.push(event('VerifiersDrawn', { verifiers: job.verifiers.map((id) => findProvider(id).address) }));
          job.deadline = clock + 12 + 600 + Math.ceil(job.itemCount / 2) * job.secondsPerItem;
        } else {
          job.phase = 'Publishing';
          job.deadline = clock + 12 + 300;
        }
        break;
      }
      case 'Checking': {
        const shareSlot = job.verifierStates.indexOf('Assigned');
        if (shareSlot !== -1) {
          method = 'shareRange';
          actor = 'client';
          job.verifierStates[shareSlot] = 'Shared';
          logs = [event('RangeShared', { slot: shareSlot, verifier: findProvider(job.verifiers[shareSlot]).address, sealedForVerifier: '0x64656d6f' })];
        } else {
          const slot = job.verifierStates.indexOf('Shared');
          method = 'commitCheck';
          actor = job.verifiers[slot];
          job.verifierStates[slot] = 'Committed';
          logs = [event('CheckCommitted', { slot })];
          if (job.verifierStates.every((value) => value === 'Committed')) {
            job.phase = 'CheckReveal';
            job.deadline = clock + 12 + 300;
          }
        }
        break;
      }
      case 'CheckReveal': {
        const slot = job.verifierStates.indexOf('Committed');
        method = 'revealCheck';
        actor = job.verifiers[slot];
        job.verifierStates[slot] = 'Revealed';
        const start = Math.floor(slot * job.itemCount / 2);
        const end = Math.floor((slot + 1) * job.itemCount / 2);
        job.coverage += end - start;
        const resultsURI = job.compare === 'similar' ? `local:results:${job.id}:verifier:${slot}` : '';
        if (job.compare === 'similar') job.verifierResultsURIs[slot] = resultsURI;
        logs = [event('CheckRevealed', { slot, start, end, leaves: Array.from({ length: end - start }, (_, index) => resultLeaf(job, start + index, 'verifier')), resultsURI })];
        gasUsed = 88620 + 24000 * (end - start);
        if (job.verifierStates.every((value) => value === 'Revealed')) {
          job.phase = 'Publishing';
          job.deadline = clock + 12 + 300;
        }
        break;
      }
      case 'Publishing': {
        method = 'publishResults';
        const mismatches = mismatchCount(job);
        job.mismatches = mismatches;
        job.results = resultSamples(job);
        const resultsURI = job.compare === 'similar' ? `local:results:${job.id}:main` : '';
        logs = [event('ResultsPublished', { leaves: Array.from({ length: job.itemCount }, (_, index) => resultLeaf(job, index, 'main')), resultsURI })];
        if (job.compare === 'similar') {
          job.resultsURI = resultsURI;
          job.phase = 'Disputing';
          job.deadline = clock + 12 + 300;
        } else if (job.mismatches) {
          job.disputedItems = Array.from({ length: job.mismatches }, (_, index) => index);
          startTiebreak(job, logs);
          job.resultWarning = job.scenario === 'main-cheat' ? '链上裁决不会自动修复主节点返回结果；需在链下重新获取正确输出。' : '';
        } else settle(job, job.verifierStates.includes('Revealed') ? 'Verified' : 'Delivered', logs);
        gasUsed = 150000 + job.itemCount * 3500;
        break;
      }
      case 'TieBreak':
        if (!job.tieShared) {
          method = 'shareTiebreak';
          actor = 'client';
          job.tieShared = true;
          logs = [event('TiebreakShared', { tiebreaker: findProvider(job.tieProvider).address, sealedForTiebreaker: '0x64656d6f' })];
        } else {
          actor = job.tieProvider;
          job.tieSubmitted = true;
          if (job.compare === 'similar') {
            method = 'submitJudgement';
            const verdict = ['main-cheat', 'similar-missing'].includes(job.scenario) ? 2 : job.scenario === 'verifier-cheat' ? 1 : 3;
            job.verdicts = Array(job.mismatches).fill(verdict);
            let mainOutvoted = false;
            job.outvotedMask = 0;
            job.disputedItems.forEach((item, index) => {
              const slot = item < Math.floor(job.itemCount / 2) ? 0 : 1;
              const mainOk = Boolean(job.verdicts[index] & 1);
              const verifierOk = Boolean(job.verdicts[index] & 2);
              if (job.verifierStates[slot] !== 'Revealed' || !verifierOk) {
                if (!mainOk) mainOutvoted = true;
                else if (job.verifierStates[slot] === 'Revealed' && !verifierOk) job.outvotedMask |= 1 << slot;
              } else if (!mainOk) mainOutvoted = true;
            });
            logs = [event('JudgementSubmitted', { verdicts: [...job.verdicts] })];
            settle(job, mainOutvoted ? 'MainOutvoted' : job.outvotedMask ? 'VerifierOutvoted' : 'DisputeRejected', logs);
          } else {
            method = 'submitTiebreak';
            logs = [event('TiebreakSubmitted', { leaves: Array.from({ length: job.mismatches }, (_, index) => resultLeaf(job, index)) })];
            settle(job, job.scenario === 'main-cheat' ? 'MainOutvoted' : 'VerifierOutvoted', logs);
          }
          gasUsed = 380000;
        }
        break;
      default: throw new Error('不支持的任务阶段');
    }
    mine(job, method, actor, logs, gasUsed);
    if (emit) notify();
    return emit ? getState() : undefined;
  }

  function passDeadline(id) {
    const job = findJob(id);
    const supported = (job.mode === 'checked' && ['Open', 'Working'].includes(job.phase))
      || ['Disputing', 'TieBreak'].includes(job.phase)
      || (job.scenario === 'main-offline' && job.phase === 'Committing')
      || (job.scenario === 'verifier-offline' && job.phase === 'CheckReveal' && job.verifierStates.includes('Revealed'));
    if (job.closed || !supported) throw new Error('当前阶段无需等待截止时间');
    clock = Math.max(clock, job.deadline + 1);
    refreshOpenJobs();
    refreshAccount();
    notify();
    return getState();
  }

  function expireJob(id) {
    const job = findJob(id);
    if (job.phase === 'TieBreak') {
      if (job.closed || clock <= job.deadline) throw new Error('尚未超过可执行 expire 的截止时间');
      const logs = [];
      if (job.tieShared) job.unresolvedMask = job.disputedItems.reduce((mask, item) => mask | 1 << (item < Math.floor(job.itemCount / 2) ? 0 : 1), 0);
      settle(job, job.tieShared ? 'TiebreakerMissed' : 'TieClientNoShare', logs);
      mine(job, 'expire', 'client', logs, 180000);
      notify();
      return getState();
    }
    if (job.phase === 'Disputing') {
      if (job.closed || clock <= job.deadline) throw new Error('尚未超过可执行 expire 的截止时间');
      const logs = [];
      settle(job, job.verifierStates.includes('Revealed') ? 'Verified' : 'Delivered', logs);
      mine(job, 'expire', 'client', logs, 165000);
      notify();
      return getState();
    }
    if (job.mode === 'checked') {
      if (job.closed || !['Open', 'Working'].includes(job.phase) || clock <= job.deadline) throw new Error('尚未超过可执行 expire 的截止时间');
      const logs = [];
      settleChecked(job, job.phase === 'Open' ? 'Cancelled' : 'MainMissed', logs);
      mine(job, 'expire', 'client', logs, 110000);
      notify();
      return getState();
    }
    const mainMissed = job.phase === 'Committing';
    const checkMissed = job.scenario === 'verifier-offline' && job.phase === 'CheckReveal';
    if (job.closed || !job.deadlinePassed || clock <= job.deadline || (!mainMissed && !checkMissed)) throw new Error('尚未超过可执行 expire 的截止时间');
    const logs = [];
    if (mainMissed) settle(job, 'MainMissed', logs);
    else {
      job.verifierStates.forEach((status, slot) => {
        if (status !== 'Committed') return;
        const provider = findProvider(job.verifiers[slot]);
        const amount = wei(provider.stake) * 500n / 10000n;
        provider.stake = eth(wei(provider.stake) - amount);
        provider.active = wei(provider.stake) >= MIN_STAKE;
        provider.checksMissed += 1;
        provider.lockedJobs -= 1;
        job.slashedPool = eth(wei(job.slashedPool) + amount);
        job.verifierStates[slot] = 'Missed';
        logs.push(event('ProviderSlashed', { provider: provider.address, amount: amount.toString(), amountEth: eth(amount) }));
        logs.push(event('VerifierDropped', { slot, state: 'Missed' }));
      });
      job.phase = 'Publishing';
      job.deadline = clock + 12 + 300;
    }
    mine(job, 'expire', 'client', logs, 160000);
    notify();
    return getState();
  }

  function selectAccount(id) {
    findAccount(id);
    selectedAccountId = id;
    refreshAccount();
    notify();
    return getState();
  }

  // Local configuration only. ProviderRegistry exposes one setPrice call per
  // market/task type; this adapter does not fabricate a batch transaction or
  // a successful PriceSet receipt without a deployed registry connection.
  function validatedOffers(offers) {
    if (!offers || typeof offers !== 'object' || Array.isArray(offers)) throw new Error('服务报价须为对象');
    const entries = Object.entries(offers);
    if (!entries.length) throw new Error('请至少填写一项服务报价');
    const supported = new Set(TASK_TYPES.filter(task => task.registered === true).map(task => task.id));
    const maximumWei = (1n << 256n) - 1n;
    const nextOffers = {};
    for (const [taskType, value] of entries) {
      if (!supported.has(taskType)) throw new Error('该计算服务尚未接入');
      if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value.trim())) throw new Error('报价须为非负十进制字符串，最多保留 18 位小数');
      const price = wei(value.trim());
      if (price > maximumWei) throw new Error('报价超出 uint256 范围');
      nextOffers[taskType] = eth(price);
    }
    return nextOffers;
  }

  function updateProviderOffers({ providerId, accountId, offers } = {}) {
    if (typeof accountId !== 'string' || accountId !== selectedAccountId) throw new Error('仅当前登录账号可修改机器报价');
    findAccount(accountId);
    const provider = findProvider(providerId);
    if (!provider || provider.ownerId !== accountId) throw new Error('仅可修改本账号绑定的机器');
    if (provider.registered !== true) throw new Error('机器尚未注册');
    const nextOffers = validatedOffers(offers);
    if (provider.listed !== false && !Object.values({ ...provider.offers, ...nextOffers }).some(value => wei(value) > 0n)
      && isProviderBusy(provider)) throw new Error('机器仍有未完成任务，任务结束后才可下架');
    // Validate every submitted service before changing any one of them. Existing
    // job.unitPrice, deposits, stakes, balances and deadlines remain unchanged.
    if (provider.listed === false) provider.savedOffers = { ...provider.savedOffers, ...nextOffers };
    else {
      provider.offers = { ...provider.offers, ...nextOffers };
      if (!Object.values(provider.offers).some(value => wei(value) > 0n)) {
        provider.listed = false;
        provider.savedOffers = { ...provider.offers };
      }
    }
    notify();
    return getState();
  }

  function isProviderBusy(provider) {
    const identities = new Set([provider.id, provider.address].filter(Boolean).map(value => value.toLowerCase()));
    return Number(provider.lockedJobs) > 0 || state.jobs.some(job => !job.closed
      && [job.provider, job.main, ...(job.verifiers || []), ...(job.verifierAddresses || []), job.tieProvider, job.tiebreaker]
        .some(value => typeof value === 'string' && identities.has(value.toLowerCase())));
  }

  function setProviderListing({ providerId, accountId, enabled } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('上下架设置必须为布尔值');
    if (typeof accountId !== 'string' || accountId !== selectedAccountId) throw new Error('仅当前登录账号可修改机器设置');
    findAccount(accountId);
    const provider = findProvider(providerId);
    if (!provider || provider.ownerId !== accountId) throw new Error('仅可修改本账号绑定的机器');
    if (provider.registered !== true) throw new Error('机器尚未注册');
    if (!enabled && isProviderBusy(provider)) throw new Error('机器仍有未完成任务，任务结束后才可下架');
    if (enabled) {
      const offers = provider.listed === false ? provider.savedOffers : provider.offers;
      if (!offers || !Object.values(offers).some(value => wei(value) > 0n)) throw new Error('请先设置至少一项正报价');
      provider.offers = { ...offers };
    } else {
      if (provider.listed !== false) provider.savedOffers = { ...provider.offers };
      provider.offers = Object.fromEntries(Object.keys(provider.offers).map(name => [name, '0.000']));
    }
    provider.listed = enabled;
    notify();
    return getState();
  }

  // Enrollment only moves this local account's available funds into its local
  // machine stake. It is not a ProviderRegistry registration receipt.
  function registerMachine(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('机器登记资料须为对象');
    const { accountId, offers } = input;
    if (typeof accountId !== 'string' || accountId !== selectedAccountId) throw new Error('仅当前登录账号可登记机器');
    const account = findAccount(accountId);
    if (state.providers.some(provider => provider.ownerId === account.id)) throw new Error('本账号已绑定机器');
    if (state.providers.some(provider => provider.address.toLowerCase() === account.address.toLowerCase())) throw new Error('该账户地址已绑定机器');
    const normalized = validatedOffers(offers);
    if (!Object.values(normalized).some(price => wei(price) > 0n)) throw new Error('请至少开启一项正报价服务');
    if (account.balance < MIN_STAKE) throw new Error('可用余额不足以支付机器质押');
    let sequence = 1;
    while (findProvider(`R${sequence}`)) sequence += 1;
    const nextOffers = Object.fromEntries(TASK_TYPES.filter(task => task.registered === true)
      .map(task => [task.id, normalized[task.id] ?? '0.000']));
    const zeroStats = Object.fromEntries(['verified', 'unverified', 'missed', 'outvoted', 'checksCompleted', 'checksMissed', 'checksOutvoted']
      .map(key => [key, 0]));
    const provider = {
      id: `R${sequence}`, name: `${account.name}的机器`, address: account.address, ownerId: account.id,
      registrationSource: 'local-enrollment', registered: true, active: true,
      stake: eth(MIN_STAKE), pricePerItem: nextOffers['image-classify-v1'], offers: nextOffers,
      ...zeroStats, lockedJobs: 0, earned: '0.000',
      statsByMode: { replicated: { ...zeroStats }, checked: { completed: 0, missed: 0, itemsSolved: 0, itemsNotFound: 0 } },
    };
    // All identity, quote and balance checks above finish before either side of
    // this transfer changes. No chain clock, sequence or receipt is advanced.
    account.balance -= MIN_STAKE;
    state.providers.push(provider);
    refreshAccount();
    notify();
    return getState();
  }

  function registerAccount(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('账户资料须为对象');
    const name = String(input.name ?? '').trim();
    const address = String(input.address ?? '').trim();
    if (!name || name.length > 40) throw new Error('账户名称须为 1–40 个字符');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('钱包地址格式不正确');
    if ([...accounts.values()].some((account) => account.address.toLowerCase() === address.toLowerCase())) throw new Error('钱包地址已注册');
    const id = input.id ?? `user-${String(accounts.size + 1).padStart(2, '0')}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(id) || accounts.has(id)) throw new Error('账户编号无效或已存在');
    accounts.set(id, { id, name, address, initialBalance: 10n * WEI, balance: 10n * WEI, deposited: 0n, returned: 0n });
    selectedAccountId = id;
    refreshAccount();
    notify();
    return id;
  }

  function seedNetwork() {
    const finish = (id) => {
      let remaining = 24;
      while (!findJob(id).closed && remaining-- > 0) {
        if (findJob(id).nextAction === 'wait') passDeadline(id);
        else if (findJob(id).nextAction === 'expire') expireJob(id);
        else {
          try { advanceJob(id, false); }
          catch (error) { if (!findJob(id).lastRejected) throw error; }
        }
      }
      if (!findJob(id).closed) throw new Error(`历史任务 ${id} 未完成结算`);
    };
    // Independent submissions by three accounts occupy one block, with their
    // own receipt, sender, escrow and log index. Each then settles separately.
    const grouped = createJobsInBlock([
      { clientId: 'user-01', provider: 'A', itemCount: 96, scenario: 'unverified' },
      { clientId: 'user-02', provider: 'D', itemCount: 160, scenario: 'unverified' },
      { clientId: 'user-03', provider: 'H', itemCount: 240, scenario: 'unverified' },
    ]);
    grouped.jobIds.forEach(finish);
    for (const input of networkHistoryInputs()) finish(createJob(input, false));

    // A documented penalty makes one low-stake node ineligible, rather than
    // labelling a node inactive without the public event that explains why.
    finish(createJob({ clientId: 'user-07', provider: 'P', itemCount: 128, scenario: 'main-cheat' }, false));

    // Checked history uses the exact public inputs and Ethereum checkers. A
    // not-found response is unpaid, but does not assert proof of impossibility.
    for (let index = 0; index < 36; index += 1) {
      const taskType = 'key-search-v1';
      const eligible = state.providers.filter((provider) => provider.active && wei(provider.offers[taskType]) > 0n);
      finish(createJob({ clientId: NETWORK_USERS[(index * 5 + 2) % NETWORK_USERS.length].id,
        provider: eligible[(index * 5 + Math.floor(index / 3)) % eligible.length].id, taskType, itemCount: [4, 8, 12, 16, 24, 32][index % 6],
        scenario: index === 9 ? 'checked-offline' : index % 11 === 0 ? 'checked-none'
          : index % 7 === 0 ? 'checked-invalid' : index % 4 === 0 ? 'checked-partial' : 'checked-success' }, false));
    }
    const abandoned = createJob({ clientId: 'user-08', provider: 'D', taskType: 'key-search-v1', itemCount: 8 }, false);
    passDeadline(abandoned);
    expireJob(abandoned);

    // Render history follows file publication, client review and bonded dispute
    // paths. It records protocol examples rather than fabricated PNG downloads.
    for (let index = 0; index < 18; index += 1) {
      const eligible = state.providers.filter(provider => provider.active && wei(provider.offers['blender-render-v1'] ?? '0') > 0n);
      finish(createJob({ clientId: NETWORK_USERS[(index * 5 + 3) % NETWORK_USERS.length].id,
        provider: eligible[(index * 3) % eligible.length].id, taskType: 'blender-render-v1',
        itemCount: [4, 8, 12, 16][index % 4], sceneName: ['产品展示.blend', '室内漫游.blend', '角色动画.blend'][index % 3],
        scenario: index === 3 ? 'main-cheat' : index === 8 ? 'verifier-cheat' : index === 13 ? 'dispute-rejected'
          : index === 16 ? 'similar-missing' : index % 5 === 0 ? 'unverified' : 'verified' }, false));
    }

    // Create unfinished work only after all history, because advancing network
    // time for an old timeout must never quietly expire the current dashboard.
    const revealing = createJob({ clientId: 'user-01', provider: 'C', itemCount: 240, scenario: 'verified' }, false);
    while (findJob(revealing).coverage === 0) advanceJob(revealing, false);
    const computing = createJob({ clientId: 'user-01', provider: 'A', itemCount: 400, scenario: 'verified' }, false);
    advanceJob(computing, false);
    const deciding = createJob({ clientId: 'user-02', provider: 'B', itemCount: 160, scenario: 'verified' }, false);
    advanceJob(deciding, false);
    advanceJob(deciding, false);
    const publishing = createJob({ clientId: 'user-04', provider: 'O', itemCount: 96, scenario: 'unverified' }, false);
    while (findJob(publishing).phase !== 'Publishing') advanceJob(publishing, false);
    createJob({ clientId: 'user-03', provider: 'H', itemCount: 320, scenario: 'verified' }, false);
    const renderComputing = createJob({ clientId: 'user-01', provider: 'K', itemCount: 12, taskType: 'blender-render-v1', sceneName: '产品展示.blend' }, false);
    advanceJob(renderComputing, false);
    createJob({ clientId: 'user-06', provider: 'D', taskType: 'blender-render-v1', itemCount: 12 }, false);
    const keyComputing = createJob({ clientId: 'user-10', provider: 'J', taskType: 'key-search-v1', itemCount: 16, scenario: 'checked-invalid' }, false);
    advanceJob(keyComputing, false);
    try { advanceJob(keyComputing, false); } catch (error) { if (!findJob(keyComputing).lastRejected) throw error; }

    // The loaded market represents quotations after price competition. Seed
    // every existing contract first: its agreed unitPrice, escrow, receipts and
    // settlement remain unchanged when the provider advertises a new offer.
    // Each service converges independently; disabled services stay disabled.
    const currentOffers = TASK_TYPES.filter(type => type.registered).map(type =>
      getMarketCompetitionSnapshot(state, type.id, MARKET_COMPETITION_ROUNDS));
    for (const snapshot of currentOffers) {
      for (const point of snapshot.points) findProvider(point.id).offers[snapshot.taskType] = point.quote;
    }
    for (const provider of state.providers) provider.pricePerItem = provider.offers['image-classify-v1'];
  }

  function reset(emit = true) {
    const users = profile === 'network' ? NETWORK_USERS : [{ id: 'user-01', name: '林舟', address: CLIENT }];
    accounts = new Map(users.map((user) => [user.id, {
      ...user, initialBalance: 10n * WEI, balance: 10n * WEI, deposited: 0n, returned: 0n,
    }]));
    selectedAccountId = users[0].id;
    clock = Date.parse('2026-10-24T02:00:00Z') / 1000;
    nextBlock = 1;
    nextTransaction = 1;
    state = {
      network: { chainId: 31337, name: 'Anvil', mode: 'demo', marketAddress: MARKET,
        markets: { replicated: MARKET, checked: CHECKED_MARKET }, gasExcluded: true },
      jobs: [], blocks: [{ number: 0, hash: demoHash('d3b1', 0), parentHash: `0x${'0'.repeat(64)}`, timestamp: clock, transactions: [], gasUsed: 0 }],
      transactions: [], account: {}, users: [],
      taskTypes: clone(TASK_TYPES),
      providers: (profile === 'network' ? NETWORK_PROVIDERS : ADDRESSES.map((address, index) => ({
        id: String.fromCharCode(65 + index), address, stake: '1.000', pricePerItem: '0.0001', ownerId: NETWORK_USERS[index % NETWORK_USERS.length].id,
      }))).map((provider, index) => ({
        ...provider, registered: true,
        offers: { 'image-classify-v1': provider.pricePerItem,
          'blender-render-v1': profile === 'network' && index % 7 === 5 ? '0.000' : eth(wei(provider.pricePerItem) * BigInt(1000 + index % 5 * 130) / 100n),
          'key-search-v1': profile === 'network' && index % 6 === 4 ? '0.000' : eth(wei(provider.pricePerItem) * BigInt(120 + index % 4 * 17) / 100n) },
        statsByMode: { replicated: {}, checked: { completed: 0, missed: 0, itemsSolved: 0, itemsNotFound: 0 } },
        active: true, lockedJobs: 0, verified: 0, unverified: 0, missed: 0, outvoted: 0,
        checksCompleted: 0, checksMissed: 0, checksOutvoted: 0, earned: '0.000',
      })),
    };
    if (profile === 'network') {
      seedNetwork();
      refreshAccount();
      if (emit) notify();
      return getState();
    }
    const first = createJob({ scenario: 'unverified' }, false);
    while (!findJob(first).closed) advanceJob(first, false);
    const second = createJob({ scenario: 'verified' }, false);
    while (!findJob(second).closed) advanceJob(second, false);
    const third = createJob({ scenario: 'verified' }, false);
    while (findJob(third).coverage === 0) advanceJob(third, false);
    if (emit) notify();
    return getState();
  }

  reset(false);
  return {
    getState, createJob, createJobsInBlock, cancelJob, advanceJob, passDeadline, expireJob, reset,
    selectAccount, registerAccount, registerMachine, submitResults, acceptResults, disputeResults, updateProviderOffers, setProviderListing,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('订阅回调必须是函数');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
