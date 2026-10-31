// HTTP adapter for the local Anvil + Python execution service. Never falls back
// to fixture data when RPC, uploads or a transaction fail.
const copy = value => structuredClone(value);
const emptyState = () => ({
  network: { mode: 'live', name: 'Anvil', connected: false, chainId: null, timestamp: 0 },
  users: [], account: {}, providers: [], jobs: [], transactions: [], blocks: [], taskTypes: [],
  telemetry: { source: 'live', tick: 0, providers: [], jobs: [] },
});

export function createRemoteClient({ fetcher = globalThis.fetch, pollMs = 1500, storage = globalThis.sessionStorage } = {}) {
  let state = emptyState();
  let accountId = '';
  try { accountId = storage?.getItem('degpu.live.account') || ''; } catch { /* storage is optional */ }
  let timer;
  let polling = false;
  let selecting = 0;
  let revision = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach(listener => listener(copy(state)));
  const remember = () => { try { storage?.setItem('degpu.live.account', accountId); } catch { /* optional */ } };

  async function request(path, { method = 'GET', body, timeout = 120000, withAccount = true } = {}) {
    const url = new URL(`/api${path}`, 'http://localhost');
    if (withAccount && accountId) url.searchParams.set('accountId', accountId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(`${url.pathname}${url.search}`, {
        method, signal: controller.signal, cache: 'no-store',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...(withAccount && accountId ? { accountId } : {}) }) }),
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`连接服务未返回有效数据（HTTP ${response.status}），请检查前端代理和 Python 服务。`); }
      if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('后端响应超时，请查看执行服务日志；请勿重复发布任务。');
      throw error;
    } finally { clearTimeout(timeoutId); }
  }

  async function refresh() {
    const requestRevision = ++revision;
    const requestedAccount = accountId;
    try {
      const next = await request('/state', { timeout: 15000 });
      if (requestRevision !== revision || requestedAccount !== accountId) return copy(state);
      if (!next.network || !Array.isArray(next.providers) || !Array.isArray(next.jobs) || !Array.isArray(next.users)) throw new Error('后端返回了不完整的网络状态。');
      if (!next.users.some(user => user.id === accountId)) accountId = next.account?.id || next.users[0]?.id || '';
      remember();
      state = { ...next, account: next.users.find(user => user.id === accountId) || next.account || {},
        network: { ...next.network, mode: 'live', connected: true, connectionError: null },
        telemetry: { source: 'live', tick: 0, providers: [], jobs: [], ...next.telemetry },
      };
      emit();
      return copy(state);
    } catch (error) {
      if (requestRevision === revision) {
        state.network = { ...state.network, connected: false, connectionError: error.message };
        emit();
      }
      throw error;
    }
  }

  async function connect() {
    await refresh();
    if (!timer && pollMs > 0) timer = setInterval(async () => {
      if (polling || selecting || globalThis.document?.hidden) return;
      polling = true;
      try { await refresh(); } catch { /* state carries the error; do not use fixtures */ }
      finally { polling = false; }
    }, pollMs);
    return copy(state);
  }

  async function mutate(path, body = {}) {
    if (!state.network.connected) throw new Error('后端未连接，暂时无法提交操作。');
    const result = await request(path, { method: 'POST', body });
    // The transaction may already be confirmed even if refreshing the view
    // fails. Do not report a refresh failure as a failed create transaction.
    try { await refresh(); } catch { /* connection status is already visible */ }
    return result;
  }

  async function uploadFile(file) {
    if (!file?.arrayBuffer || !file.name || file.size <= 0) throw new Error('请选择有效的非空文件。');
    if (file.size > 32 * 1024 * 1024) throw new Error('单个文件不能超过 32 MiB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    const result = await request('/uploads', { method: 'POST', body: { name: file.name, data: btoa(binary) } });
    if (!result.id) throw new Error('上传服务未返回文件编号。');
    return result;
  }

  const action = (id, name, body = {}) => mutate(`/jobs/${encodeURIComponent(id)}/${name}`, body);
  const providerAction = (providerId, name, body = {}) => {
    const listing = name === 'listing';
    if (state.network[listing ? 'providerListing' : 'providerAutomation'] !== true) throw new Error(listing
      ? '当前执行服务尚未支持上下架设置，请更新连接服务。' : '当前执行服务尚未支持自动处理设置，请更新连接服务。');
    const provider = state.providers.find(entry => entry.id === providerId);
    if (!accountId || !provider || provider.ownerId !== accountId) throw new Error('只能操作自己的机器。');
    return mutate(`/providers/${encodeURIComponent(providerId)}/${name}`, body);
  };
  return Object.freeze({
    connect, refresh, uploadFile,
    getState: () => copy(state),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async selectAccount(id) {
      if (!state.users.some(user => user.id === id)) throw new Error('该本地链账户不存在。');
      if (selecting) throw new Error('正在连接账户，请稍后重试。');
      const previousAccountId = accountId;
      selecting += 1;
      accountId = id;
      try {
        // A background poll must not supersede the refresh that confirms this
        // selection. Requests already in flight remain protected by revision.
        await refresh();
        if (state.account?.id !== id) throw new Error('执行服务未确认此账户连接，请重试。');
        return copy(state.account);
      } catch (error) {
        accountId = previousAccountId;
        remember();
        throw error;
      } finally { selecting -= 1; }
    },
    async createJob(input) {
      const result = await mutate('/jobs', { ...input, providerId: input.provider });
      if (!result.id) throw new Error('后端未返回已发布的任务编号。');
      return result.id;
    },
    advanceJob: id => action(id, 'advance'),
    expireJob: id => action(id, 'expire'),
    cancelJob: id => action(id, 'cancel'),
    acceptResults: id => action(id, 'accept'),
    disputeResults: (id, indices) => action(id, 'dispute', { indices, items: indices }),
    updateProviderOffers: ({ providerId, offers }) => mutate(`/providers/${encodeURIComponent(providerId)}/offers`, { offers }),
    async setProviderAutomation({ providerId, enabled }) {
      if (typeof enabled !== 'boolean') throw new Error('自动处理设置必须为布尔值。');
      return providerAction(providerId, 'automation', { enabled });
    },
    async setProviderListing({ providerId, enabled }) {
      if (typeof enabled !== 'boolean') throw new Error('上下架设置必须为布尔值。');
      return providerAction(providerId, 'listing', { enabled });
    },
    async processProvider({ providerId }) { return providerAction(providerId, 'process'); },
    getResults: id => request(`/jobs/${encodeURIComponent(id)}/results`),
    passDeadline() { throw new Error('真实链按实际时间运行，不能从此入口跳过截止时间。'); },
    reset() { throw new Error('真实链不能通过网页重置。'); },
    disconnect() { clearInterval(timer); timer = null; revision += 1; },
  });
}

// These identities are unlocked development-chain accounts. They deliberately
// do not share local demo passwords, sessions, or invented wallet addresses.
export function createLiveAccountService(client) {
  const accounts = () => client.getState().users.map(user => ({ ...user, username: user.id, selectable: true, source: 'local-chain' }));
  return Object.freeze({
    listAccounts: accounts,
    currentAccount: () => accounts().find(user => user.id === client.getState().account?.id) || null,
    selectAccount(id) {
      const account = accounts().find(user => user.id === id);
      if (!account) throw new Error('该本地链账户不存在。');
      return account;
    },
    register() { throw new Error('当前连接使用 Anvil 开发账户，尚未接入钱包注册。'); },
    login() { throw new Error('请在账号页面连接账户。'); },
    logout() { return null; },
  });
}
