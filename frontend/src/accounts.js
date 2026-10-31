// These accounts identify local workspaces. They do not prove wallet ownership,
// authorize a contract call, or provide authentication for a remote service.
export const ACCOUNT_STORAGE_KEY = 'degpu.accounts.v1';
export const SESSION_STORAGE_KEY = 'degpu.session.v1';

const ITERATIONS = 210_000;
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}$/;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i;
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
const normalizeUsername = value => String(value ?? '').trim().toLowerCase();
const error = message => new Error(message);

function validRegisteredAccount(account) {
  return account && typeof account.id === 'string' && /^u-[0-9a-f]{12}$/.test(account.id)
    && typeof account.username === 'string' && USERNAME.test(account.username)
    && typeof account.name === 'string' && account.name.length >= 2 && account.name.length <= 24
    && HEX_ADDRESS.test(account.address)
    && account.credentials?.algorithm === 'PBKDF2-SHA-256'
    && Number.isSafeInteger(account.credentials.iterations)
    && account.credentials.iterations >= 100_000 && account.credentials.iterations <= 1_000_000
    && /^[0-9a-f]{32}$/.test(account.credentials.salt)
    && /^[0-9a-f]{64}$/.test(account.credentials.hash);
}

function publicAccount(account, selectable) {
  if (!account) return null;
  return Object.freeze({
    id: account.id,
    username: account.username,
    name: account.name,
    address: account.address,
    source: account.source || 'registered',
    selectable,
  });
}

/**
 * Seed accounts are public workspace identities and require no password.
 * Registered accounts require a successful login before workspace selection.
 * Passwords use Web Crypto PBKDF2 with a fresh random salt for each account;
 * localStorage is still a local convenience, not a server security boundary.
 */
export function createAccountService({ storage = globalThis.localStorage, crypto = globalThis.crypto, seedUsers = [] } = {}) {
  if (!storage?.getItem || !storage?.setItem) throw error('当前环境无法保存账户数据。');
  const seeds = [];
  for (const user of seedUsers) {
    if (!user || !user.id || !user.address) continue;
    const id = String(user.id);
    const username = normalizeUsername(user.username || id);
    if (seeds.some(account => account.id === id || account.username === username)) continue;
    seeds.push(Object.freeze({ id, username, name: String(user.name || username), address: String(user.address), source: 'workspace' }));
  }

  function read(key) {
    try { return storage.getItem(key); }
    catch { throw error('无法读取账户数据，请检查浏览器存储设置。'); }
  }

  function write(key, value) {
    try { storage.setItem(key, JSON.stringify(value)); }
    catch { throw error('无法保存账户数据，请检查浏览器存储空间。'); }
  }

  function registeredAccounts() {
    let record;
    try { record = JSON.parse(read(ACCOUNT_STORAGE_KEY) || 'null'); }
    catch (cause) {
      if (cause instanceof SyntaxError) return [];
      throw cause;
    }
    if (record?.version !== 1 || !Array.isArray(record.accounts)) return [];
    const accounts = [];
    for (const account of record.accounts) {
      if (!validRegisteredAccount(account)) continue;
      const candidate = { ...account, username: normalizeUsername(account.username), source: 'registered' };
      if ([...seeds, ...accounts].some(existing => existing.id === candidate.id || existing.username === candidate.username || existing.address.toLowerCase() === candidate.address.toLowerCase())) continue;
      accounts.push(candidate);
    }
    return accounts;
  }

  function readSession() {
    let session;
    try { session = JSON.parse(read(SESSION_STORAGE_KEY) || 'null'); }
    catch (cause) {
      if (cause instanceof SyntaxError) return { currentId: null, authorizedIds: [] };
      throw cause;
    }
    if (session?.version !== 1) return { currentId: null, authorizedIds: [] };
    return {
      currentId: typeof session.currentId === 'string' ? session.currentId : null,
      authorizedIds: Array.isArray(session.authorizedIds) ? [...new Set(session.authorizedIds.filter(id => typeof id === 'string'))] : [],
    };
  }

  function saveSession(currentId, authorizedIds) {
    write(SESSION_STORAGE_KEY, { version: 1, currentId, authorizedIds: [...new Set(authorizedIds)] });
  }

  // Only the first visit gets a default workspace; logout remains logged out on reload.
  if (read(SESSION_STORAGE_KEY) === null) saveSession(seeds[0]?.id || null, []);

  function selectable(account, session) {
    return account.source === 'workspace' || session.authorizedIds.includes(account.id);
  }

  function listAccounts() {
    const session = readSession();
    return Object.freeze([...seeds, ...registeredAccounts()].map(account => publicAccount(account, selectable(account, session))));
  }

  function currentAccount() {
    const session = readSession();
    const account = [...seeds, ...registeredAccounts()].find(candidate => candidate.id === session.currentId);
    return account && selectable(account, session) ? publicAccount(account, true) : null;
  }

  function selectAccount(id) {
    const session = readSession();
    const account = [...seeds, ...registeredAccounts()].find(candidate => candidate.id === id);
    if (!account) throw error('账户不存在。');
    if (!selectable(account, session)) throw error('请先登录此账户。');
    saveSession(account.id, session.authorizedIds);
    return publicAccount(account, true);
  }

  function requireCrypto() {
    if (!crypto?.subtle || !crypto?.getRandomValues) throw error('当前环境不支持安全登录，请使用本机地址或 HTTPS。');
  }

  function randomHex(length) {
    requireCrypto();
    return hex(crypto.getRandomValues(new Uint8Array(length)));
  }

  async function hashPassword(password, salt, iterations = ITERATIONS) {
    requireCrypto();
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, material, 256);
    return new Uint8Array(bits);
  }

  function equalHash(left, right) {
    let difference = left.length ^ right.length;
    for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] || 0) ^ (right[index] || 0);
    return difference === 0;
  }

  async function register({ username, name, password } = {}) {
    username = normalizeUsername(username);
    name = String(name ?? '').trim();
    if (!USERNAME.test(username)) throw error('用户名需为 3–24 位字母、数字、下划线、点或短横线，并以字母或数字开头。');
    if (name.length < 2 || name.length > 24) throw error('昵称需为 2–24 个字符。');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw error('密码需为 8–128 个字符。');
    const duplicate = () => [...seeds, ...registeredAccounts()].some(account => account.username === username);
    if (duplicate()) throw error('此用户名已被使用。');
    const salt = randomHex(16);
    const hash = hex(await hashPassword(password, salt));
    // Check again after the asynchronous derivation, including other service instances.
    if (duplicate()) throw error('此用户名已被使用。');
    const accounts = registeredAccounts();
    let id;
    do { id = `u-${randomHex(6)}`; } while ([...seeds, ...accounts].some(account => account.id === id));
    let address;
    do { address = `0x${randomHex(20)}`; } while ([...seeds, ...accounts].some(account => account.address.toLowerCase() === address));
    const account = { id, username, name, address, source: 'registered', credentials: { algorithm: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt, hash } };
    write(ACCOUNT_STORAGE_KEY, { version: 1, accounts: [...accounts, account] });
    const session = readSession();
    saveSession(account.id, [...session.authorizedIds, account.id]);
    return publicAccount(account, true);
  }

  async function login(username, password) {
    username = normalizeUsername(username);
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw error('用户名或密码不正确。');
    const account = registeredAccounts().find(candidate => candidate.username === username);
    // Unknown names follow the same derivation path; seed workspaces have no passwords.
    const credentials = account?.credentials || { salt: '00000000000000000000000000000000', iterations: ITERATIONS, hash: '0'.repeat(64) };
    const candidate = await hashPassword(password, credentials.salt, credentials.iterations);
    if (!equalHash(candidate, unhex(credentials.hash)) || !account) throw error('用户名或密码不正确。');
    const session = readSession();
    saveSession(account.id, [...session.authorizedIds, account.id]);
    return publicAccount(account, true);
  }

  function logout() {
    saveSession(null, []);
    return null;
  }

  return Object.freeze({ listAccounts, currentAccount, selectAccount, register, login, logout });
}
