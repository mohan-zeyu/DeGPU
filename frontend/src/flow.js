const uiText = value => String(value ?? '').replaceAll('主节点', '提供方').replaceAll('复核节点', '复核方').replaceAll('裁决节点', '裁决方');
const STATE_LABELS = { done: '已确认', current: '当前等待', pending: '待执行', skipped: '已跳过' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const stateOf = value => Object.hasOwn(STATE_LABELS, value) ? value : 'pending';
const similarTask = job => job.mode !== 'checked' && (job.compare === 'similar' || job.comparison === 'similar'
  || ((job.compare == null && job.comparison == null) && job.taskType === 'blender-render-v1'));
const OUTCOMES = {
  checked: ['None', 'Cancelled', 'Delivered', 'MainMissed'],
  replicated: ['None', 'Cancelled', 'Delivered', 'Verified', 'MainOutvoted', 'VerifierOutvoted',
    'BothOutvoted', 'NoMajority', 'MainMissed', 'TiebreakerMissed', 'TieClientNoShare', 'DisputeRejected'],
};
// RPC logs retain Solidity enum integers; local adapters may already use names.
// Decode at the presentation boundary without changing the receipt's evidence.
function eventOutcome(job, event) {
  const value = event?.args?.outcome;
  if (typeof value === 'string' && OUTCOMES[job.mode]?.includes(value)) return value;
  return /^(0|[1-9]\d*)$/.test(String(value)) ? OUTCOMES[job.mode]?.[Number(value)] ?? null : null;
}

function mainState(progress) {
  if (progress.commit === 'done') return 'done';
  if ([progress.accept, progress.commit].includes('current')) return 'current';
  if (progress.commit === 'skipped') return 'skipped';
  return 'pending';
}

function graphFor(job, view = {}) {
  if (job.mode === 'checked') return checkedGraph(job);
  const progress = job.progress ?? {};
  if (job.outcome === 'Cancelled') {
    return {
      mode: 'cancelled',
      nodes: [
        { key: 'create', label: '发布任务', row: 1, column: 1, state: proofsFor(job, 'create').length ? 'done' : 'pending', description: '客户创建任务并锁定预存款，确认记录为 JobCreated。' },
        { key: 'cancel', label: '取消任务', row: 1, column: 2, state: proofsFor(job, 'cancel').length ? 'done' : 'pending', description: '客户在提供方接单前取消任务，JobClosed 的 Cancelled 结果确认取消。' },
        { key: 'settle', label: '退还预存', row: 1, column: 3, state: proofsFor(job, 'settle').length ? 'done' : 'pending', description: '预存款全额退还发布账户，以该账户收到的 Payout 确认；退款与任务关闭在同一笔交易中完成。' },
      ],
    };
  }
  if (similarTask(job) && job.scenario !== 'main-offline') return similarGraph(job, view);
  if (view.role === 'provider' && job.scenario !== 'main-offline') return providerGraph(job);
  const offline = job.scenario === 'main-offline';
  const mode = offline ? 'offline' : job.verify ? 'verified' : 'unverified';
  const verifiers = Array.isArray(job.verifiers) ? job.verifiers : [];
  const verifier = slot => verifiers[slot] == null ? `复核方 ${slot + 1}` : `复核方 ${verifiers[slot]}`;
  const provider = `提供方 ${job.provider ?? '待分配'}`;
  const tiebreaker = job.tieProvider == null ? '独立裁决方' : `裁决方 ${job.tieProvider}`;
  const nodes = [
    { key: 'create', label: '发布任务', row: 1, column: 1, state: stateOf(progress.create), description: '客户创建任务并锁定预存款，确认记录为 JobCreated。' },
    { key: 'main', label: '提供方承诺', row: 1, column: 2, state: offline && job.deadlinePassed ? 'skipped' : mainState(progress), caption: offline && job.deadlinePassed ? '未按时提交' : null, description: offline && job.closed
      ? `${provider}已接单但未提交结果承诺，任务已按超时关闭。`
      : offline && job.deadlinePassed ? `${provider}已接单但未在截止前提交承诺；仍须调用 expire() 推进链上处理。`
      : `${provider}的接单与提交承诺合并展示；承诺不表示模型在链上执行。` },
  ];
  if (offline) {
    nodes.push(
      { key: 'expire', label: '超时处理', row: 1, column: 3, state: job.closed ? 'done' : job.deadlinePassed ? 'current' : 'pending', description: '超过截止时间后仍须提交 expire()；时间流逝本身不会改变链上状态。' },
      { key: 'settle', label: '退款与处罚', row: 2, column: 3, state: stateOf(progress.settle), description: '以退款、罚没质押和 JobClosed 记录确认本次超时处理已执行。' },
    );
    return { mode, nodes };
  }
  nodes.push({ key: 'decision', label: '公开复核决定', row: 1, column: 3, state: stateOf(progress.decision), description: '客户公开事先承诺的复核决定；需要复核时，合约选择复核方。' });
  if (job.verify) {
    // DOM order groups the same phases together on the narrow, single-column layout.
    // Desktop grid positions retain two independent horizontal verification branches.
    for (const [prefix, column, label, description] of [
      ['share', 1, slot => `分享给${verifier(slot)}`, slot => `客户向${verifier(slot)}分享复核区间与密封资料。`],
      ['commit', 2, slot => `${verifier(slot)}承诺`, slot => `${verifier(slot)}提交复核承诺；正常流程须等待所有有效复核方完成承诺。`],
      ['reveal', 3, slot => `${verifier(slot)}公开`, slot => `${verifier(slot)}公开复核结果，合约核对承诺并记录结果。`],
    ]) {
      for (let slot = 0; slot < 2; slot += 1) {
        const key = `${prefix}${slot === 0 ? 'B' : 'C'}`;
        nodes.push({ key, label: label(slot), row: slot + 2, column, state: stateOf(progress[key]), description: description(slot) });
      }
    }
  }
  const lastRow = job.verify ? 4 : 2;
  nodes.push({ key: 'publish', label: '公开结果与比对', row: lastRow, column: 1, state: stateOf(progress.publish), description: job.verify
    ? '提供方公开结果并与复核结果比对；结果一致时，可在同一笔交易中完成结算。'
    : '提供方公开结果后交付；本任务跳过复核分支，未使用的复核预存按合约退回。' });
  if (job.verify) {
    nodes.push(
      { key: 'tieShare', label: '分享争议资料', row: 4, column: 3, state: stateOf(progress.tieShare), caption: progress.tieShare === 'skipped' ? null : '结果不一致时', description: `客户向${tiebreaker}分享争议资料；该分支仅在结果不一致时执行。` },
      { key: 'tie', label: '争议裁决', row: 5, column: 3, state: stateOf(progress.tie), description: `${tiebreaker}提交争议项结果，合约据此处罚并结算；裁决不会自动修复链下输出。` },
    );
  }
  nodes.push({ key: 'settle', label: '任务结算', row: lastRow, column: 2, state: stateOf(progress.settle), description: '通过 Payout、ProviderSlashed（如有）和 JobClosed 确认结算；公开或裁决交易可以同时产生这些事件。' });
  return { mode, nodes };
}

function similarGraph(job, view) {
  const events = Array.isArray(job.events) ? job.events : [];
  const has = name => events.some(entry => entry.name === name);
  const providerView = view.role === 'provider';
  const assigned = has('VerifiersDrawn');
  const checking = providerView ? assigned : assigned || (Boolean(job.verify) && !has('VerificationDropped'));
  const published = has('ResultsPublished');
  const disputed = has('ResultsDisputed');
  const started = has('TiebreakStarted');
  const judged = has('JudgementSubmitted');
  const closure = events.find(entry => entry.name === 'JobClosed');
  const closed = Boolean(closure);
  const accepted = published && closed && !disputed && ['Verified', 'Delivered'].includes(eventOutcome(job, closure));
  const timedAcceptance = accepted && job.closeMethod === 'expire';
  const reviewDone = disputed || accepted;
  const progress = job.progress ?? {};
  const names = checking && Array.isArray(job.verifiers) ? job.verifiers : [];
  const verifier = slot => names[slot] == null ? `复核方 ${slot + 1}` : `复核方 ${names[slot]}`;
  const row = checking ? 4 : 2;
  const branchState = key => {
    const match = /^(share|commit|reveal)(B|C)$/.exec(key);
    const eventName = { share: 'RangeShared', commit: 'CheckCommitted', reveal: 'CheckRevealed' }[match[1]];
    const slot = match[2] === 'B' ? 0 : 1;
    if (events.some(entry => entry.name === eventName && Number(entry.args?.slot) === slot)) return 'done';
    if (closed || published) return 'skipped';
    return progress[key] === 'current' ? 'current' : 'pending';
  };
  const nodes = [
    { key: 'create', label: '发布任务', row: 1, column: 1, state: has('JobCreated') ? 'done' : 'pending', description: '客户加密上传输入文件并锁定两倍任务价格；JobCreated 记录数据清单与提供方密封授权。' },
    { key: 'main', label: '提供方承诺', row: 1, column: 2, state: has('ResultsCommitted') ? 'done' : ['Open', 'Committing'].includes(job.phase) && !job.deadlinePassed ? 'current' : closed ? 'skipped' : 'pending', description: '提供方在链下渲染并加密上传结果文件，再提交文件哈希对应的结果承诺。承诺只固定文件内容，不证明渲染质量。' },
    { key: 'decision', label: providerView ? '监管安排' : '公开复核决定', row: 1, column: 3, state: has('DecisionRevealed') || has('VerificationDropped') ? 'done' : job.phase === 'Deciding' ? 'current' : closed ? 'skipped' : 'pending', description: '客户在提供方承诺后公开预先承诺的复核决定；提供方执行时无法预知。仅在 VerifiersDrawn 后公开复核方身份。' },
  ];
  if (checking) {
    for (const [prefix, column, label, description] of [
      ['share', 1, slot => `分享给${verifier(slot)}`, slot => `客户向${verifier(slot)}密封分享输入区间及复核结果文件密钥。`],
      ['commit', 2, slot => `${verifier(slot)}承诺`, slot => `${verifier(slot)}独立渲染所分配的区间，加密上传文件并提交承诺；所有有效复核方承诺后才可公开。`],
      ['reveal', 3, slot => `${verifier(slot)}公开`, slot => `${verifier(slot)}通过 revealCheck 公开结果叶子及结果文件清单 URI。哈希用于核对文件完整性，不能替代相似度比较。`],
    ]) for (let slot = 0; slot < 2; slot += 1) {
      const key = `${prefix}${slot === 0 ? 'B' : 'C'}`;
      nodes.push({ key, label: label(slot), row: slot + 2, column, state: branchState(key), description: description(slot) });
    }
  }
  nodes.push(
    { key: 'publish', label: '发布结果文件', row, column: 1, state: published ? 'done' : job.phase === 'Publishing' && !job.deadlinePassed ? 'current' : closed ? 'skipped' : 'pending', description: '提供方调用 publishResults，公开结果叶子与加密文件清单 URI；合约核对承诺后进入 Disputing，不比较渲染文件哈希是否相等，也不立即结算。' },
    { key: 'review', label: '客户验收', row, column: 2, state: reviewDone ? 'done' : published && job.phase === 'Disputing' ? 'current' : closed ? 'skipped' : 'pending', caption: published && job.phase === 'Disputing' && job.deadlinePassed ? '争议窗口已结束' : null, description: `${job.review?.compared === false ? '当前尚未执行真实的文件相似度比较。' : ''}实际协议中，客户下载并解密结果，先用链上叶子核对文件完整性，再按任务固定的相似度指标比较提供方与已公开的复核文件；缺失、无法解密或不相似的项可提出争议。此处的完成状态确认验收决定，不单独证明执行过相似度计算；链下比较没有独立事件。` },
    { key: 'acceptResults', label: timedAcceptance ? '到期接收' : '确认接收', row, column: 3, state: accepted ? 'done' : disputed || (closed && !accepted) ? 'skipped' : 'pending', description: '只要任务仍为 Disputing，客户就可调用 acceptResults 接收并结算，争议窗口结束后也可接收。未提出争议且窗口已过时，仍须有人调用 expire 或由客户接收才会结算；时间流逝本身不关闭任务。两者都以 Payout 与 JobClosed 确认，没有独立的接收事件。' },
    { key: 'dispute', label: '提交争议', row: row + 1, column: 1, state: disputed ? 'done' : closed ? 'skipped' : 'pending', caption: disputed ? `${(job.disputedItems ?? events.find(entry => entry.name === 'ResultsDisputed')?.args?.items ?? []).length} 项` : null, description: '客户调用 dispute 并支付等于 tiebreakFee 的保证金，提交递增且不重复的争议项编号。ResultsDisputed 确认争议；合约另行抽取独立裁决方，没有可用裁决方时按 NoMajority 关闭。' },
    { key: 'tieShare', label: '分享争议资料', row: row + 1, column: 2, state: has('TiebreakShared') ? 'done' : started && !closed && !job.deadlinePassed ? 'current' : closed ? 'skipped' : 'pending', description: '客户向裁决方密封分享争议输入，以及提供方和对应复核方的结果文件密钥。裁决方核对完整性后，仅重新渲染争议项。' },
    { key: 'tie', label: '提交裁决票', row: row + 1, column: 3, state: judged ? 'done' : has('TiebreakShared') && !closed && !job.deadlinePassed ? 'current' : closed ? 'skipped' : 'pending', description: '裁决方将重新渲染的文件与双方结果做相似度比较，调用 submitJudgement 提交逐项裁决票：位 0 表示提供方结果可接受，位 1 表示对应复核方结果可接受。双方都可接受时可为 DisputeRejected，双方都不可接受时该项未决；合约按裁决票处罚与结算，不执行渲染或相似度计算。' },
  );
  if (providerView) {
    const caption = !closed ? published ? disputed ? '等待裁决' : '等待客户比较' : assigned ? '复核进行中' : '等待结果交付'
      : ['MainOutvoted', 'BothOutvoted', 'MainMissed'].includes(eventOutcome(job, closure)) ? '未通过'
        : ['Delivered', 'Verified', 'VerifierOutvoted', 'DisputeRejected'].includes(eventOutcome(job, closure)) ? '通过' : '未能确认';
    nodes.push({ key: 'oversight', label: '监管检查', row: row + 2, column: 3, state: closed ? 'done' : published ? 'current' : 'pending', caption, description: '监管检查始终保留。提供方发布文件后仍须等待客户接收或裁决结论，不能仅凭发布记录提前显示通过；没有复核方时也保留客户验收与争议窗口。' });
  }
  if ((job.deadlinePassed && ['Committing', 'Publishing', 'TieBreak'].includes(job.phase))
    || (job.closeMethod === 'expire' && ['MainMissed', 'TiebreakerMissed', 'TieClientNoShare'].includes(eventOutcome(job, closure)))) {
    nodes.push({ key: 'expire', label: '超时处理', row: row + 2, column: 1, state: closed ? 'done' : 'current', description: '超过执行、发布或裁决期限后仍须有人调用 expire。未分享裁决资料按客户未授权处理，已授权而裁决方未提交则处罚裁决方；以实际 JobClosed 和支付、罚没记录确认关闭。' });
  }
  nodes.push({ key: 'settle', label: '任务结算', row: row + 2, column: providerView ? 2 : 3, state: closed ? 'done' : 'pending', description: 'Payout、ProviderSlashed（如有）与 JobClosed 确认实际付款、处罚和关闭。接收或裁决交易可同时完成结算；无处罚的无效争议由客户保证金支付裁决费用，其余余额按合约退回。' });
  return { mode: providerView ? 'provider-similar' : 'similar', nodes };
}

// Provider execution never branches on the client's private verify choice.
// Assignment and delivery are projected only after their public chain records.
function providerGraph(job) {
  const events = Array.isArray(job.events) ? job.events : [];
  const has = name => events.some(entry => entry.name === name);
  const assigned = has('VerifiersDrawn');
  const published = has('ResultsPublished');
  const closed = eventOutcome(job, events.find(entry => entry.name === 'JobClosed'));
  const dropped = has('VerificationDropped');
  const bypassed = published && (!assigned || dropped);
  const disputed = has('TiebreakStarted');
  const resolved = has('TiebreakSubmitted');
  const progress = job.progress ?? {};
  const names = assigned && Array.isArray(job.verifiers) ? job.verifiers : [];
  const regulator = slot => names[slot] == null ? `复核方 ${slot + 1}` : `复核方 ${names[slot]}`;
  const lastRow = assigned ? 4 : 2;
  const nodes = [
    { key: 'create', label: '发布任务', row: 1, column: 1, state: has('JobCreated') ? 'done' : 'pending', description: '客户创建任务并锁定预存款，确认记录为 JobCreated。' },
    { key: 'main', label: '提供方承诺', row: 1, column: 2, state: has('ResultsCommitted') ? 'done' : ['Open', 'Committing'].includes(job.phase) ? 'current' : 'pending', description: `提供方 ${job.provider ?? '待分配'}在链下执行并提交结果承诺；执行前不展示客户是否触发复核的私有决定。` },
    { key: 'decision', label: '监管安排', row: 1, column: 3, state: has('DecisionRevealed') || dropped ? 'done' : job.phase === 'Deciding' ? 'current' : 'pending', description: '客户按承诺公开监管安排；仅在公开分配记录确认后展示复核方身份，监管检查分支持续保留。' },
  ];
  if (assigned) {
    for (const [prefix, column, label, description] of [
      ['share', 1, slot => `分享给${regulator(slot)}`, slot => `客户向已公开分配的${regulator(slot)}分享监管资料。`],
      ['commit', 2, slot => `${regulator(slot)}承诺`, slot => `${regulator(slot)}提交监管承诺；正常流程须等待所有有效复核方完成承诺。`],
      ['reveal', 3, slot => `${regulator(slot)}公开`, slot => `${regulator(slot)}公开监管结果，合约核对承诺并记录结果。`],
    ]) {
      for (let slot = 0; slot < 2; slot += 1) {
        const key = `${prefix}${slot === 0 ? 'B' : 'C'}`;
        nodes.push({ key, label: label(slot), row: slot + 2, column, state: stateOf(progress[key]), description: description(slot) });
      }
    }
  }
  nodes.push({ key: 'publish', label: '公开交付结果', row: lastRow, column: 1, state: published ? 'done' : job.phase === 'Publishing' ? 'current' : 'pending', description: '提供方公开交付结果；最终监管状态以实际公开记录与交付结果更新。' });
  const oversightState = bypassed || closed ? 'done' : assigned ? 'current' : 'pending';
  const oversightCaption = bypassed ? '通过' : closed === 'MainOutvoted' ? '未通过'
    : closed === 'Verified' || closed === 'VerifierOutvoted' ? '通过'
    : disputed && !resolved ? '等待裁决' : assigned ? '等待结果比对' : '复核方待分配';
  nodes.push({ key: 'oversight', label: '监管检查', row: lastRow, column: 2, state: oversightState, caption: oversightCaption,
    description: bypassed
      ? '本次未触发复核，交付后自动放行，监管状态显示通过。这不代表发生了复核；确认依据是实际 ResultsPublished 与 JobClosed，没有额外的监管交易或复核事件。'
      : assigned ? '复核方已按公开分配记录显示。通过、未通过或争议状态按实际结果比对与裁决记录更新；复核方承诺本身不代表结果已经通过。'
        : '执行期间保持监管检查分支可见。公开分配前不展示复核方身份，也不根据客户尚未公开的复核决定提前显示跳过或通过。' });
  nodes.push({ key: 'settle', label: '任务结算', row: lastRow, column: 3, state: proofsFor(job, 'settle').some(entry => entry.name === 'JobClosed') ? 'done' : 'pending', description: '通过实际 Payout、ProviderSlashed（如有）和 JobClosed 确认结算；监管状态通过不等同于生成额外链上交易。' });
  if (assigned) {
    const tiebreaker = has('TiebreakStarted') && job.tieProvider != null ? `裁决方 ${job.tieProvider}` : '独立裁决方';
    nodes.push(
      { key: 'tieShare', label: '分享争议资料', row: 5, column: 2, state: stateOf(progress.tieShare), caption: progress.tieShare === 'skipped' ? null : '结果不一致时', description: `客户向${tiebreaker}分享争议资料；该分支仅在结果不一致时执行。` },
      { key: 'tie', label: '争议裁决', row: 5, column: 3, state: stateOf(progress.tie), description: `${tiebreaker}提交争议项结果，合约据此处罚并结算。` },
    );
  }
  return { mode: 'provider-regulated', nodes };
}

function checkedGraph(job) {
  const events = Array.isArray(job.events) ? job.events : [];
  const created = events.some(entry => entry.name === 'JobCreated');
  const accepted = events.some(entry => entry.name === 'JobAccepted');
  const submitted = events.some(entry => entry.name === 'ResultsSubmitted');
  const closed = events.some(entry => entry.name === 'JobClosed' && eventOutcome(job, entry) === job.outcome);
  const rejected = !submitted && !job.closed && job.phase === 'Working' && Boolean(job.lastSubmissionError || job.lastRejected?.confirmed === false);
  const create = { key: 'create', label: '发布任务', row: 1, column: 1, state: created ? 'done' : 'pending', description: '客户发布公开挑战并托管一倍任务价格；JobCreated 确认创建，输入不采用图片任务的加密授权流程。' };
  const settle = { key: 'settle', label: '按有效项结算', row: 2, column: 1, state: closed ? 'done' : 'pending', description: '按通过检验的有效答案数量付款，未找到项退回单项费用。ResultsSubmitted、支付与 JobClosed 在 submitResults 同一笔交易内完成；未找到不是已证明无解。' };
  if (job.outcome === 'Cancelled' && job.closeMethod !== 'expire') {
    return { mode: 'checked-cancelled', nodes: [create,
      { key: 'cancel', label: '取消任务', row: 1, column: 2, state: closed ? 'done' : 'pending', description: '任务尚未接单时取消；JobClosed 的 Cancelled 结果确认关闭。' },
      { ...settle, label: '退还托管', row: 1, column: 3, state: checkedProofsFor(job, 'refund').length ? 'done' : 'pending', description: '未接单任务退回全部托管，以客户收到的 Payout 确认；退款与关闭在同一笔交易中完成。' },
    ] };
  }
  const expired = job.closeMethod === 'expire' || job.outcome === 'MainMissed' || (job.deadlinePassed && !submitted);
  const working = accepted && !submitted && !job.closed && job.phase === 'Working';
  const accept = { key: 'accept', label: '提供方接单', row: 1, column: 2, state: accepted ? 'done' : created && job.phase === 'Open' && !expired ? 'current' : 'pending', description: '指定提供方在截止前调用 accept；JobAccepted 后进入 Working，并锁定提供方质押。没有复核方或裁决方。' };
  const search = { key: 'search', label: '链下搜索', row: 1, column: 3, state: submitted || (rejected && !expired) ? 'done' : expired ? 'skipped' : working ? 'current' : 'pending', caption: expired ? '未提交答案' : job.scenario === 'checked-offline' && working ? '计算中断' : '链下执行', description: '提供方在链下搜索答案，搜索进度不上链，也没有搜索完成事件。提交有效答案只证明答案通过 checker，不证明执行了多少次搜索；标记未找到也不证明无解。' };
  if (expired) {
    const nodes = [create];
    if (accepted) nodes.push(accept, search);
    nodes.push(
      { key: 'expire', label: accepted ? '超时处理' : '到期取消', row: accepted ? 2 : 1, column: accepted ? 3 : 2, state: closed ? 'done' : job.deadlinePassed ? 'current' : 'pending', description: accepted ? 'Working 超时后须有人调用 expire，才会关闭任务、处罚失约提供方并退款；时间流逝本身不发交易。' : 'Open 超时后须有人调用 expire 才会取消并全额退款，尚未接单的提供方不受处罚。' },
      { ...settle, label: accepted ? '退款与处罚' : '退还托管', row: accepted ? 2 : 1, column: accepted ? 2 : 3, description: accepted ? '通过 ProviderSlashed、Payout 与 MainMissed 的 JobClosed 记录确认超时处罚和退款。没有提交、答案检验或有效项付款。' : '到期取消退回全部托管；通过客户 Payout 与 Cancelled 的 JobClosed 确认。' },
    );
    return { mode: accepted ? 'checked-timeout' : 'checked-open-timeout', nodes };
  }
  const nodes = [create, accept, search,
    { key: 'submit', label: '提交答案', row: 2, column: 3, state: submitted ? 'done' : 'pending', description: '提供方一次提交每项答案与 found 标记。任意 found=true 答案错误会使整笔交易回退，不产生 ResultsSubmitted、付款或关闭记录；可在期限内改正后重新提交。' },
    { key: 'check', label: '合约逐项检验', row: 2, column: 2, state: submitted ? 'done' : 'pending', caption: rejected ? '答案无效 · 整笔回退' : null, description: 'checker 仅检验 found=true 的答案；全部有效后才产生 ResultsSubmitted。检验与提交、结算属于同一笔交易，没有单独的检验交易，也没有复核方。found=false 只表示未提交解。' },
  ];
  if (rejected) nodes.push({ key: 'retry', label: '修正并重试', row: 3, column: 2, state: 'current', description: `本次尝试被拒绝：${job.lastSubmissionError || job.lastRejected?.error || '答案无效'}。这条本地拒绝提示不是成功交易或合约事件；任务仍为 Working，尚未付款，提供方可在截止前修正答案重提，或截止后调用 expire。` });
  nodes.push(settle);
  return { mode: 'checked', nodes };
}

function checkedProofsFor(job, key) {
  return (Array.isArray(job.events) ? job.events : []).filter(entry => {
    if (key === 'create') return entry.name === 'JobCreated';
    if (key === 'accept') return entry.name === 'JobAccepted';
    if (key === 'search') return false;
    if (key === 'submit' || key === 'check') return entry.name === 'ResultsSubmitted';
    if (key === 'cancel') return entry.name === 'JobClosed' && eventOutcome(job, entry) === 'Cancelled';
    if (key === 'refund' || (key === 'settle' && job.outcome === 'Cancelled' && job.closeMethod !== 'expire')) return entry.name === 'Payout' && typeof entry.args?.to === 'string' && typeof job.clientAddress === 'string' && entry.args.to.toLowerCase() === job.clientAddress.toLowerCase();
    if (key === 'expire') return entry.name === 'JobClosed' && ['MainMissed', 'Cancelled'].includes(eventOutcome(job, entry));
    if (key === 'settle') return entry.name === 'Payout' || entry.name === 'ProviderSlashed' || (entry.name === 'JobClosed' && eventOutcome(job, entry) === job.outcome);
    return false;
  });
}

function proofsFor(job, key) {
  if (job.mode === 'checked') return checkedProofsFor(job, key);
  if (job.outcome === 'Cancelled') {
    return (Array.isArray(job.events) ? job.events : []).filter(entry => {
      if (key === 'create') return entry.name === 'JobCreated';
      if (key === 'cancel') return entry.name === 'JobClosed' && eventOutcome(job, entry) === 'Cancelled';
      if (key === 'settle') return entry.name === 'Payout' && typeof entry.args?.to === 'string' && typeof job.clientAddress === 'string' && entry.args.to.toLowerCase() === job.clientAddress.toLowerCase();
      return false;
    });
  }
  if (similarTask(job)) {
    const names = {
      create: ['JobCreated'], main: ['JobAccepted', 'ResultsCommitted'],
      decision: ['DecisionRevealed', 'VerifiersDrawn', 'VerificationDropped'],
      publish: ['ResultsPublished'], review: [], dispute: ['ResultsDisputed', 'TiebreakStarted'],
      tieShare: ['TiebreakShared'], tie: ['JudgementSubmitted'],
      expire: ['ProviderSlashed', 'Payout', 'JobClosed'],
      settle: ['Payout', 'ProviderSlashed', 'JobClosed'],
      oversight: ['ResultsPublished', 'ResultsDisputed', 'JudgementSubmitted', 'JobClosed'],
    };
    const slotMatch = /^(share|commit|reveal)(B|C)$/.exec(key);
    const disputed = (job.events ?? []).some(entry => entry.name === 'ResultsDisputed');
    return (job.events ?? []).filter(entry => {
      if (key === 'acceptResults') return !disputed && ['Verified', 'Delivered'].includes(eventOutcome(job, (job.events ?? []).find(item => item.name === 'JobClosed')))
        && (entry.name === 'Payout' || entry.name === 'JobClosed');
      if (slotMatch) return entry.name === { share: 'RangeShared', commit: 'CheckCommitted', reveal: 'CheckRevealed' }[slotMatch[1]]
        && Number(entry.args?.slot) === (slotMatch[2] === 'B' ? 0 : 1);
      return names[key]?.includes(entry.name);
    });
  }
  const names = {
    create: ['JobCreated'], main: ['JobAccepted', 'ResultsCommitted'],
    decision: ['DecisionRevealed', 'VerifiersDrawn', 'VerificationDropped'],
    publish: ['ResultsPublished', 'TiebreakStarted'], tieShare: ['TiebreakShared'], tie: ['TiebreakSubmitted'],
    settle: ['Payout', 'ProviderSlashed', 'JobClosed'], expire: ['ProviderSlashed', 'Payout', 'JobClosed'],
    oversight: ['ResultsPublished', 'CheckRevealed', 'TiebreakStarted', 'TiebreakSubmitted', 'JobClosed'],
  };
  const slotMatch = /^(share|commit|reveal)(B|C)$/.exec(key);
  return (Array.isArray(job.events) ? job.events : []).filter(entry => {
    if (slotMatch) {
      const eventName = { share: 'RangeShared', commit: 'CheckCommitted', reveal: 'CheckRevealed' }[slotMatch[1]];
      return entry.name === eventName && Number(entry.args?.slot) === (slotMatch[2] === 'B' ? 0 : 1);
    }
    return names[key]?.includes(entry.name);
  });
}

/** Renders a read-only projection. Selecting a step changes only its explanation. */
export function renderFlow(job, selectedStep = null, view = {}) {
  if (!job) return '<p class="empty">请选择任务。</p>';
  const { mode, nodes } = graphFor(job, view);
  const requested = job.mode !== 'checked' && (selectedStep === 'accept' || selectedStep === 'commit') ? 'main' : selectedStep;
  const explicitSelection = selectedStep != null && nodes.find(node => node.key === requested);
  const selected = explicitSelection || nodes.find(node => node.state === 'current') || nodes.find(node => node.key === 'settle') || nodes[0];
  const proofs = proofsFor(job, selected.key);
  const checked = job.mode === 'checked';
  const providerView = mode === 'provider-regulated' || mode === 'provider-similar';
  const similar = mode === 'similar' || mode === 'provider-similar';
  const publicAssignment = (job.events ?? []).some(entry => entry.name === 'VerifiersDrawn');
  const gate = checked ? null : mode === 'cancelled' ? null : similar ? '文件完整性用哈希核对，相似度在链下比较，合约记录裁决与结算。' : providerView ? '监管状态以公开分配、结果交付与最终结算记录更新。' : mode === 'verified' ? '正常流程中，所有有效复核方承诺后才可公开。'
    : mode === 'offline' ? '截止时间到期不会自动结算，仍须调用 expire()。' : '本任务不复核，跳过复核分支。';
  const found = (job.events ?? []).find(entry => entry.name === 'ResultsSubmitted')?.args?.found;
  const checkedCount = Array.isArray(found) ? found.filter(value => value === true).length : null;
  return `<div class="progress-head"><span>${escape(uiText(job.status))}</span>${checked ? checkedCount === null ? '' : `<span class="muted">有效答案 ${checkedCount} / ${escape(job.itemCount ?? found.length)}</span>` : (providerView ? publicAssignment : job.verify) && !['offline', 'cancelled'].includes(mode) ? `<span class="muted">复核覆盖 ${escape(job.coverage ?? 0)} / ${escape(job.itemCount ?? 0)}</span>` : ''}<div class="legend"><span class="ok"><span class="flow-dot" aria-hidden="true"></span>${checked ? '已推进' : '已确认'}</span><span class="current"><span class="flow-dot" aria-hidden="true"></span>当前</span><span class="pending"><span class="flow-dot" aria-hidden="true"></span>待执行</span></div></div>
    <div class="flow-board" data-flow-mode="${mode}" data-has-dispute="${similar ? (job.events ?? []).some(entry => entry.name === 'ResultsDisputed') : Number(job.mismatches ?? 0) > 0}">
      <svg class="wires" aria-hidden="true" focusable="false"></svg>
      ${nodes.map(node => `<button type="button" class="flow-node" data-step="${node.key}" data-state="${node.state}" style="grid-row:${node.row};grid-column:${node.column}" aria-pressed="${node.key === selected.key}" aria-label="${escape(`${node.label}，${node.caption ?? STATE_LABELS[node.state]}`)}"><b><span class="flow-dot" aria-hidden="true"></span>${escape(node.label)}</b>${node.caption || node.state === 'skipped' ? `<small>${escape(node.caption ?? '已跳过')}</small>` : ''}</button>`).join('')}
    </div>
    ${mode === 'checked' ? '<p class="muted flow-transaction-note">提交、检验、结算 · 同一笔交易</p>' : similar ? '<p class="muted flow-transaction-note">文件发布 → 客户验收 → 接收或争议裁决</p>' : ''}
    <details class="flow-detail" ${explicitSelection ? 'open ' : ''}aria-label="步骤说明"><summary>步骤详情</summary><p>${escape(selected.description)}</p>${gate ? `<p class="gate">${gate}</p>` : ''}<h3>${(checked && selected.key === 'search') || (similar && selected.key === 'review') ? '链下步骤' : checked && selected.key === 'retry' ? '提交拒绝' : '确认记录'}${proofs.length ? ` · ${proofs.length}` : ''}</h3>${proofs.length
      ? `<ul class="proof-list">${proofs.map(entry => `<li><a class="link" href="#/chain?tx=${escape(encodeURIComponent(String(entry.transactionHash ?? '')))}">#${escape(entry.blockNumber)} · ${escape(entry.name)}</a><span class="muted">logIndex ${escape(entry.logIndex)}</span></li>`).join('')}</ul>`
      : `<p class="muted">${checked && selected.key === 'search' ? '搜索过程不上链。' : similar && selected.key === 'review' ? '比较过程不上链；接收、争议和裁决分别通过实际交易确认。' : checked && selected.key === 'retry' ? '本次尝试没有成功确认事件。' : '暂无此步骤的确认事件。'}</p>`}</details>`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let wireSequence = 0;

/** Measures existing nodes after layout; the caller owns resize observation. */
export function drawFlowWires(container) {
  const boards = container.matches?.('.flow-board') ? [container] : [...container.querySelectorAll('.flow-board')];
  for (const board of boards) drawBoard(board);
}

function drawBoard(board) {
  const svg = board.querySelector('.wires');
  if (!svg) return;
  const bounds = board.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const width = bounds.width;
  const height = bounds.height;
  const boxes = new Map([...board.querySelectorAll('.flow-node')].map(element => {
    const rect = element.getBoundingClientRect();
    const left = rect.left - bounds.left;
    const top = rect.top - bounds.top;
    return [element.dataset.step, { left, top, right: left + rect.width, bottom: top + rect.height, cx: left + rect.width / 2, cy: top + rect.height / 2, state: element.dataset.state }];
  }));
  const secondNode = boxes.get('main') ?? boxes.get('accept') ?? boxes.get('cancel') ?? boxes.get('expire');
  const narrow = boxes.get('create') && secondNode && Math.abs(boxes.get('create').left - secondNode.left) < 3;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const markerId = `flow-arrow-${++wireSequence}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  for (const [name, value] of Object.entries({ id: markerId, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse', markerUnits: 'strokeWidth' })) marker.setAttribute(name, value);
  const arrow = document.createElementNS(SVG_NS, 'path');
  arrow.setAttribute('d', 'M1 1 L7 4 L1 7');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'var(--wire)');
  arrow.setAttribute('stroke-width', '1.2');
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);

  const point = (x, y) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  function path(points, source, target, arrowEnd = true) {
    if (!points.length) return;
    const line = document.createElementNS(SVG_NS, 'path');
    const done = source === 'done' && target === 'done';
    const current = source === 'done' && target === 'current';
    line.setAttribute('class', `wire${done ? ' confirmed' : current ? ' confirmed current' : ''}`);
    line.setAttribute('d', points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' '));
    if (arrowEnd) line.setAttribute('marker-end', `url(#${markerId})`);
    svg.append(line);
  }
  function edge(from, to, route = 'auto', lane = 0) {
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b) return;
    let points;
    if (narrow) {
      const intervening = [...boxes.values()].some(box => box !== a && box !== b && box.top > Math.min(a.top, b.top) && box.bottom < Math.max(a.bottom, b.bottom));
      if (b.top > a.bottom && !intervening && route === 'auto') points = [point(a.cx, a.bottom), point(b.cx, b.top)];
      else { const rail = width - 8 - lane * 9; points = [point(a.right, a.cy), point(rail, a.cy), point(rail, b.cy), point(b.right, b.cy)]; }
    } else if (route === 'retry') {
      const rail = width - 8;
      points = [point(a.right, a.cy), point(rail, a.cy), point(rail, b.cy), point(b.right, b.cy)];
    } else if (route === 'branch') {
      const rail = 11;
      const y = a.bottom + 14;
      points = [point(a.cx, a.bottom), point(a.cx, y), point(rail, y), point(rail, b.cy), point(b.left, b.cy)];
    } else if (route === 'dispute') {
      const y = a.top - 10;
      points = [point(a.cx, a.top), point(a.cx, y), point(b.cx, y), point(b.cx, b.top)];
    } else if (route === 'return') {
      points = Math.abs(a.cx - b.cx) < 3
        ? [point(a.cx, a.top), point(b.cx, b.bottom)]
        : [point(b.cx > a.cx ? a.right : a.left, a.cy), point(b.cx, a.cy), point(b.cx, b.bottom)];
    } else if (Math.abs(a.top - b.top) < 3 && b.left > a.right) points = [point(a.right, a.cy), point(b.left, b.cy)];
    else if (Math.abs(a.top - b.top) < 3 && b.right < a.left) points = [point(a.left, a.cy), point(b.right, b.cy)];
    else if (b.top >= a.bottom && Math.abs(a.cx - b.cx) < 3) points = [point(a.cx, a.bottom), point(b.cx, b.top)];
    else points = [point(a.cx, a.bottom), point(a.cx, (a.bottom + b.top) / 2), point(b.cx, (a.bottom + b.top) / 2), point(b.cx, b.top)];
    const dispute = board.dataset.hasDispute === 'true';
    const similarityFlow = board.dataset.flowMode === 'similar' || board.dataset.flowMode === 'provider-similar';
    const inactiveBranch = !similarityFlow && (from === 'publish' || from === 'oversight') && ((to === 'settle' && dispute) || (to === 'tieShare' && !dispute))
      || from === 'review' && ((to === 'acceptResults' && dispute) || (to === 'dispute' && !dispute))
      || from === 'acceptResults' && dispute;
    path(points, inactiveBranch ? 'pending' : a.state, inactiveBranch ? 'pending' : b.state);
  }
  function joint(x, y, confirmed) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    for (const [name, value] of Object.entries({ cx: x, cy: y, r: '3', fill: confirmed ? 'var(--wire)' : 'var(--canvas)', stroke: 'var(--wire)', 'stroke-width': '1.2' })) dot.setAttribute(name, value);
    svg.append(dot);
  }
  function similarTail() {
    edge('publish', 'review');
    edge('review', 'acceptResults');
    edge('review', 'dispute', narrow ? 'auto' : 'branch');
    edge('dispute', 'tieShare');
    edge('tieShare', 'tie');
    const finish = boxes.has('oversight') ? 'oversight' : 'settle';
    edge('acceptResults', finish, 'retry', 1);
    edge('tie', finish);
    if (boxes.has('expire')) {
      const source = boxes.get('tieShare')?.state === 'done' ? 'tieShare'
        : boxes.get('dispute')?.state === 'done' ? 'dispute'
          : boxes.get('publish')?.state === 'done' ? 'publish' : 'main';
      edge(source, 'expire', 'branch', 2);
      edge('expire', finish);
    } else if (boxes.get('dispute')?.state === 'done' && boxes.get('tieShare')?.state === 'skipped'
      && boxes.get('tie')?.state === 'skipped' && boxes.get('settle')?.state === 'done') {
      edge('dispute', finish);
    }
    if (finish === 'oversight') edge('oversight', 'settle');
  }

  if (board.dataset.flowMode === 'cancelled' || board.dataset.flowMode === 'checked-cancelled') {
    edge('create', 'cancel');
    edge('cancel', 'settle');
    return;
  }
  if (board.dataset.flowMode === 'checked-open-timeout') {
    edge('create', 'expire');
    edge('expire', 'settle');
    return;
  }
  if (board.dataset.flowMode === 'checked' || board.dataset.flowMode === 'checked-timeout') {
    edge('create', 'accept');
    edge('accept', 'search');
    if (board.dataset.flowMode === 'checked-timeout') {
      edge('search', 'expire');
      edge('expire', 'settle');
    } else {
      edge('search', 'submit');
      edge('submit', 'check');
      edge('check', 'settle', 'auto', 1);
      if (boxes.has('retry')) {
        edge('check', 'retry');
        edge('retry', 'submit', 'retry');
      }
    }
    return;
  }
  edge('create', 'main');
  if (board.dataset.flowMode === 'offline') {
    edge('main', 'expire');
    edge('expire', 'settle');
    return;
  }
  edge('main', 'decision');
  const similar = board.dataset.flowMode === 'similar' || board.dataset.flowMode === 'provider-similar';
  if (similar && !boxes.has('shareB')) {
    edge('decision', 'publish', narrow ? 'auto' : 'branch');
    similarTail();
    return;
  }
  if (board.dataset.flowMode === 'provider-regulated' && !boxes.has('shareB')) {
    edge('decision', 'publish', narrow ? 'auto' : 'branch');
    edge('publish', 'oversight');
    edge('oversight', 'settle');
    return;
  }
  if (board.dataset.flowMode === 'unverified') {
    edge('decision', 'publish', narrow ? 'auto' : 'branch');
    edge('publish', 'settle');
    return;
  }
  edge('decision', 'shareB', narrow ? 'auto' : 'branch');
  edge('decision', 'shareC', 'branch', 0);
  edge('shareB', 'commitB', 'auto', 1);
  edge('shareC', 'commitC', 'auto', 2);

  // Both commitments feed one barrier; neither verifier has an independent early-reveal path.
  const commitB = boxes.get('commitB');
  const commitC = boxes.get('commitC');
  const revealB = boxes.get('revealB');
  const revealC = boxes.get('revealC');
  const publish = boxes.get('publish');
  if (commitB && commitC && revealB && revealC && publish) {
    const ready = node => node.state === 'done' || (similar && node.state === 'skipped');
    const committed = ready(commitB) && ready(commitC) && [commitB, commitC].some(node => node.state === 'done');
    const barrierState = committed ? 'done' : 'pending';
    const gateX = narrow ? width - 17 : (commitB.right + revealB.left) / 2;
    const gateY = narrow ? (commitC.bottom + revealB.top) / 2 : (commitB.cy + commitC.cy) / 2;
    for (const node of [commitB, commitC]) path([point(node.right, node.cy), point(gateX, node.cy), point(gateX, gateY)], node.state, barrierState, false);
    for (const node of [revealB, revealC]) {
      const points = narrow && node === revealB
        ? [point(gateX, gateY), point(node.cx, gateY), point(node.cx, node.top)]
        : [point(gateX, gateY), point(gateX, node.cy), point(node.left, node.cy)];
      // Narrow layouts approach the second reveal from the reserved right margin.
      if (narrow && node === revealC) points[points.length - 1] = point(node.right, node.cy);
      path(points, barrierState, node.state);
    }
    joint(gateX, gateY, committed);

    const revealed = ready(revealB) && ready(revealC) && [revealB, revealC].some(node => node.state === 'done');
    const revealState = revealed ? 'done' : 'pending';
    const joinX = width - 8;
    const joinY = (revealC.bottom + publish.top) / 2;
    for (const node of [revealB, revealC]) path([point(node.right, node.cy), point(joinX, node.cy), point(joinX, joinY)], node.state, revealState, false);
    const joinPath = narrow
      ? [point(joinX, joinY), point(publish.cx, joinY), point(publish.cx, publish.top)]
      : [point(joinX, joinY), point(11, joinY), point(11, publish.cy), point(publish.left, publish.cy)];
    path(joinPath, revealState, publish.state);
    joint(joinX, joinY, revealed);
  }
  if (similar) {
    similarTail();
    return;
  }
  if (board.dataset.flowMode === 'provider-regulated') {
    edge('publish', 'oversight');
    edge('oversight', 'settle', 'auto', 2);
    edge('oversight', 'tieShare', 'auto', 1);
  } else {
    edge('publish', 'settle', 'auto', 2);
    edge('publish', 'tieShare', narrow ? 'auto' : 'dispute', 1);
  }
  edge('tieShare', 'tie');
  edge('tie', 'settle', narrow ? 'auto' : 'return');
}
