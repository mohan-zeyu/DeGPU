// A single connected address for the local execution service. Selecting an
// unlocked development-chain account does not prove wallet ownership.
export const CONNECTED_ACCOUNT_STORAGE_KEY = 'degpu.connected-account.v1';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const normalizedAddress = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function createConnectedAccountService(client, { storage = globalThis.sessionStorage } = {}) {
  let session = readSession();
  let generation = 0;
  let pendingLogin = null;

  function readSession() {
    try {
      const saved = JSON.parse(storage?.getItem(CONNECTED_ACCOUNT_STORAGE_KEY) || 'null');
      if (saved?.version !== 1 || typeof saved.id !== 'string' || !saved.id || !ADDRESS.test(saved.address)) return null;
      return { id: saved.id, address: normalizedAddress(saved.address) };
    } catch { return null; }
  }

  function persist(next) {
    try { storage?.setItem(CONNECTED_ACCOUNT_STORAGE_KEY, JSON.stringify(next ? { version: 1, ...next } : null)); }
    catch { throw new Error('无法保存账户连接，请检查浏览器存储设置。'); }
  }

  function matchingAccount(connection) {
    if (!connection) return null;
    const state = client.getState();
    const selected = state.account;
    if (selected?.id !== connection.id || normalizedAddress(selected.address) !== connection.address) return null;
    const account = state.users?.find(user => user.id === connection.id && normalizedAddress(user.address) === connection.address);
    return account ? Object.freeze({ id: account.id, name: account.name, address: account.address,
      username: account.username || account.id, source: 'local-chain', selectable: true }) : null;
  }

  function currentAccount() { return matchingAccount(session); }

  function listAccounts() {
    const account = currentAccount();
    return Object.freeze(account ? [account] : []);
  }

  async function login(address) {
    address = normalizedAddress(address);
    if (!ADDRESS.test(address)) throw new Error('请输入完整的以太坊账户地址。');
    if (session && session.address !== address) throw new Error('请先退出当前账户，再连接其他账户。');
    const existing = currentAccount();
    if (existing) return existing;
    if (pendingLogin) {
      if (pendingLogin.address !== address) throw new Error('正在连接账户，请先退出后再连接其他账户。');
      return pendingLogin.promise;
    }
    const account = client.getState().users?.find(user => normalizedAddress(user.address) === address);
    if (!account) throw new Error('此地址尚未接入当前执行服务。');
    if (typeof client.selectAccount !== 'function') throw new Error('当前执行服务不支持账户连接。');

    const token = ++generation;
    const connection = { id: account.id, address };
    const pending = { token, address, promise: null };
    pendingLogin = pending;
    const promise = (async () => {
      try {
        await client.selectAccount(account.id);
        if (token !== generation) throw new Error('账户连接已取消。');
        const connected = matchingAccount(connection);
        if (!connected) throw new Error('执行服务未确认此账户连接，请重试。');
        persist(connection);
        session = connection;
        return connected;
      } finally {
        if (pendingLogin?.token === token) pendingLogin = null;
      }
    })();
    pending.promise = promise;
    return promise;
  }

  function logout() {
    generation += 1;
    pendingLogin = null;
    session = null;
    persist(null);
    return null;
  }

  function register() { throw new Error('当前执行服务尚未接入钱包注册。'); }

  return Object.freeze({ currentAccount, listAccounts, login, logout, register });
}
