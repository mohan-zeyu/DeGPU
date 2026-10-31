import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedAccountService, CONNECTED_ACCOUNT_STORAGE_KEY } from '../src/connected-account.js';

const users = [
  { id: 'user-01', name: '账户一', address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
  { id: 'user-02', name: '账户二', address: '0x2222222222222222222222222222222222222222' },
];
function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)) };
}
function fixture({ select } = {}) {
  const storage = memoryStorage();
  const state = { users: structuredClone(users), account: structuredClone(users[0]) };
  const selectedIds = [];
  const client = {
    getState: () => structuredClone(state),
    async selectAccount(id) {
      selectedIds.push(id);
      if (select) await select(id);
      state.account = structuredClone(state.users.find(user => user.id === id));
      return structuredClone(state.account);
    },
  };
  return { storage, state, client, selectedIds,
    service: createConnectedAccountService(client, { storage }) };
}

test('an existing selected backend account does not create an implicit connected session', () => {
  const { service, storage } = fixture();
  assert.equal(service.currentAccount(), null);
  assert.deepEqual(service.listAccounts(), []);
  assert.equal(storage.getItem(CONNECTED_ACCOUNT_STORAGE_KEY), null);
});

test('login connects a full known address case-insensitively and exposes only that account', async () => {
  const { service, selectedIds, storage, client } = fixture();
  const account = await service.login(` ${users[0].address.toUpperCase()} `);
  assert.equal(account.id, users[0].id);
  assert.equal(service.currentAccount().id, users[0].id);
  assert.deepEqual(selectedIds, [users[0].id]);
  assert.deepEqual(service.listAccounts().map(value => value.id), [users[0].id]);
  assert.equal(account.source, 'local-chain');
  assert.throws(() => { account.name = 'changed'; }, TypeError);
  const saved = JSON.parse(storage.getItem(CONNECTED_ACCOUNT_STORAGE_KEY));
  assert.deepEqual(saved, { version: 1, id: users[0].id, address: users[0].address });
  assert.equal(createConnectedAccountService(client, { storage }).currentAccount().id, users[0].id);
  await service.login(users[0].address);
  assert.deepEqual(selectedIds, [users[0].id]);
});

test('unknown, incomplete, or username input never selects an account or saves a session', async () => {
  const { service, selectedIds, storage } = fixture();
  for (const address of ['', 'user-01', '0xabc', {}, null]) await assert.rejects(service.login(address), /完整的以太坊账户地址/);
  await assert.rejects(service.login('0x3333333333333333333333333333333333333333'), /尚未接入/);
  assert.deepEqual(selectedIds, []);
  assert.equal(storage.getItem(CONNECTED_ACCOUNT_STORAGE_KEY), null);
  assert.throws(() => service.register(), /尚未接入钱包注册/);
});

test('another account requires logout, and logout remains disconnected after recreation', async () => {
  const { service, storage, client, selectedIds } = fixture();
  await service.login(users[0].address);
  await assert.rejects(service.login(users[1].address), /先退出当前账户/);
  assert.deepEqual(selectedIds, [users[0].id]);
  assert.equal(service.logout(), null);
  assert.equal(service.currentAccount(), null);
  assert.deepEqual(service.listAccounts(), []);
  assert.equal(createConnectedAccountService(client, { storage }).currentAccount(), null);
  assert.equal((await service.login(users[1].address)).id, users[1].id);
});

test('persisted session is hidden when the selected address or account id changes', async () => {
  const { service, storage, client, state } = fixture();
  await service.login(users[0].address);
  state.account = structuredClone(users[1]);
  assert.equal(service.currentAccount(), null);
  assert.equal(createConnectedAccountService(client, { storage }).currentAccount(), null);
  state.account = { ...users[0], address: users[1].address };
  assert.equal(service.currentAccount(), null);
  state.account = structuredClone(users[0]);
  state.users = state.users.filter(user => user.id !== users[0].id);
  assert.equal(service.currentAccount(), null);
});

test('malformed persistence never connects an account', () => {
  const { client, storage } = fixture();
  for (const saved of ['{bad', 'null', JSON.stringify({ version: 2, ...users[0] }), JSON.stringify({ version: 1, id: users[0].id, address: '0xabc' })]) {
    storage.setItem(CONNECTED_ACCOUNT_STORAGE_KEY, saved);
    assert.equal(createConnectedAccountService(client, { storage }).currentAccount(), null);
  }
});

test('failed account selection never persists a connected session', async () => {
  const { service, storage } = fixture({ select: async () => { throw new Error('network failed'); } });
  await assert.rejects(service.login(users[0].address), /network failed/);
  assert.equal(service.currentAccount(), null);
  assert.equal(storage.getItem(CONNECTED_ACCOUNT_STORAGE_KEY), null);
});

test('a synchronous selection failure clears the pending operation so login can retry', async () => {
  const { storage, client } = fixture();
  let attempts = 0;
  const service = createConnectedAccountService({ ...client, selectAccount(id) {
    if (++attempts === 1) throw new Error('selection failed');
    return client.selectAccount(id);
  } }, { storage });
  await assert.rejects(service.login(users[0].address), /selection failed/);
  assert.equal((await service.login(users[0].address)).id, users[0].id);
});

test('an unconfirmed backend selection cannot create a connected session', async () => {
  const { storage, client } = fixture();
  const service = createConnectedAccountService({ ...client, selectAccount: async () => {} }, { storage });
  await assert.rejects(service.login(users[1].address), /未确认/);
  assert.equal(service.currentAccount(), null);
  assert.equal(storage.getItem(CONNECTED_ACCOUNT_STORAGE_KEY), null);
});

test('logout cancels a pending login so its eventual response cannot restore the session', async () => {
  let finish;
  const { service, client, storage } = fixture({ select: () => new Promise(resolve => { finish = resolve; }) });
  const login = service.login(users[0].address);
  service.logout();
  finish();
  await assert.rejects(login, /连接已取消/);
  assert.equal(service.currentAccount(), null);
  assert.equal(createConnectedAccountService(client, { storage }).currentAccount(), null);
});

test('pending connection cannot be replaced by a different address', async () => {
  let finish;
  const { service, selectedIds } = fixture({ select: () => new Promise(resolve => { finish = resolve; }) });
  const login = service.login(users[0].address);
  await assert.rejects(service.login(users[1].address), /正在连接账户/);
  finish();
  assert.equal((await login).id, users[0].id);
  assert.deepEqual(selectedIds, [users[0].id]);
});
