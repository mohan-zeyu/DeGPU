import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createAccountService, ACCOUNT_STORAGE_KEY, SESSION_STORAGE_KEY } from '../src/accounts.js';
import { renderAuthPage, renderAccountSettings } from '../src/account-view.js';

const seedUsers = [
  { id: 'user01', name: '陈同学', address: '0x1111111111111111111111111111111111111111' },
  { id: 'user02', name: '林同学', address: '0x2222222222222222222222222222222222222222' },
];
function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)) };
}
const fixture = () => {
  const storage = memoryStorage();
  return { storage, service: createAccountService({ storage, crypto: webcrypto, seedUsers }) };
};
const registration = { username: 'new_user', name: '新用户', password: 'correct horse battery staple' };

test('seed workspace selection persists, and explicit logout survives service recreation', () => {
  const { storage, service } = fixture();
  assert.equal(service.currentAccount().id, 'user01');
  assert.deepEqual(service.listAccounts().map(account => account.selectable), [true, true]);
  service.selectAccount('user02');
  let reloaded = createAccountService({ storage, crypto: webcrypto, seedUsers });
  assert.equal(reloaded.currentAccount().id, 'user02');
  reloaded.logout();
  reloaded = createAccountService({ storage, crypto: webcrypto, seedUsers });
  assert.equal(reloaded.currentAccount(), null);
  assert.throws(() => reloaded.selectAccount('unknown'), /账户不存在/);
  // Public seed workspaces can still be deliberately selected after logout.
  assert.equal(reloaded.selectAccount('user01').id, 'user01');
});

test('registration stores only a salted hash, creates a local identifier, and restores the authorized session', async () => {
  const { storage, service } = fixture();
  const account = await service.register({ ...registration, username: ' New_User ', name: ' 新用户 ' });
  assert.match(account.id, /^u-[0-9a-f]{12}$/);
  assert.match(account.address, /^0x[0-9a-f]{40}$/);
  assert.equal(account.username, 'new_user');
  assert.equal(account.name, '新用户');
  assert.equal(account.source, 'registered');
  assert.equal(account.selectable, true);
  assert.equal('credentials' in account, false);
  assert.equal('password' in account, false);
  const stored = storage.getItem(ACCOUNT_STORAGE_KEY);
  assert.equal(stored.includes(registration.password), false);
  const credentials = JSON.parse(stored).accounts[0].credentials;
  assert.equal(credentials.algorithm, 'PBKDF2-SHA-256');
  assert.ok(credentials.iterations >= 100_000);
  assert.match(credentials.salt, /^[0-9a-f]{32}$/);
  assert.match(credentials.hash, /^[0-9a-f]{64}$/);
  const reloaded = createAccountService({ storage, crypto: webcrypto, seedUsers });
  assert.equal(reloaded.currentAccount().id, account.id);
  assert.equal(reloaded.listAccounts().find(entry => entry.id === account.id).selectable, true);
  assert.throws(() => { account.name = 'changed'; }, TypeError);
});

test('wrong password never changes current session, and logout prevents bypass through account selection', async () => {
  const { storage, service } = fixture();
  const account = await service.register(registration);
  service.selectAccount('user02');
  await assert.rejects(service.login(registration.username, 'wrong password'), /用户名或密码不正确/);
  assert.equal(service.currentAccount().id, 'user02');
  service.logout();
  assert.equal(service.listAccounts().find(entry => entry.id === account.id).selectable, false);
  assert.throws(() => service.selectAccount(account.id), /请先登录/);
  const reloaded = createAccountService({ storage, crypto: webcrypto, seedUsers });
  assert.throws(() => reloaded.selectAccount(account.id), /请先登录/);
  await assert.rejects(reloaded.login('missing', registration.password), /用户名或密码不正确/);
  assert.equal(reloaded.currentAccount(), null);
  assert.equal((await reloaded.login(' NEW_USER ', registration.password)).id, account.id);
  assert.equal(reloaded.currentAccount().id, account.id);
});

test('registration validates user fields and rejects duplicate names including seed workspaces and case changes', async () => {
  const { service } = fixture();
  await assert.rejects(service.register({ ...registration, username: 'a' }), /用户名需/);
  await assert.rejects(service.register({ ...registration, username: 'a<script>' }), /用户名需/);
  await assert.rejects(service.register({ ...registration, name: '字' }), /昵称需/);
  await assert.rejects(service.register({ ...registration, password: 'short' }), /密码需/);
  await assert.rejects(service.register({ ...registration, username: 'USER01' }), /用户名已被使用/);
  await service.register(registration);
  await assert.rejects(service.register({ ...registration, username: ' NEW_USER ' }), /用户名已被使用/);
});

test('accounts with the same password receive independent salts and sessions do not leak between storage instances', async () => {
  const { storage, service } = fixture();
  const first = await service.register(registration);
  const second = await service.register({ ...registration, username: 'another', name: '另一个用户' });
  const records = JSON.parse(storage.getItem(ACCOUNT_STORAGE_KEY)).accounts;
  assert.notEqual(records[0].credentials.salt, records[1].credentials.salt);
  assert.notEqual(records[0].credentials.hash, records[1].credentials.hash);
  assert.equal(service.selectAccount(first.id).id, first.id);
  assert.equal(service.selectAccount(second.id).id, second.id);
  const separate = fixture().service;
  assert.equal(separate.currentAccount().id, 'user01');
  assert.equal(separate.listAccounts().length, 2);
});

test('malformed persistence never grants a registered session or exposes credentials', async () => {
  const { storage, service } = fixture();
  const account = await service.register(registration);
  storage.setItem(SESSION_STORAGE_KEY, '{invalid');
  const reloaded = createAccountService({ storage, crypto: webcrypto, seedUsers });
  assert.equal(reloaded.currentAccount(), null);
  assert.throws(() => reloaded.selectAccount(account.id), /请先登录/);
  storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({ version: 1, accounts: [{ ...account, password: 'bad' }] }));
  assert.equal(reloaded.listAccounts().length, 2);
  await assert.rejects(reloaded.login(registration.username, registration.password), /用户名或密码不正确/);
});

test('views escape user content, do not render locked registered accounts as choices, and set useful form semantics', () => {
  const form = renderAuthPage('register', '<bad>', { username: '" onfocus="bad', name: '<script>bad</script>' });
  assert.match(form, /id="auth-form" data-auth-mode="register"/);
  assert.match(form, /autocomplete="new-password"/);
  assert.match(form, /role="alert">&lt;bad&gt;/);
  assert.equal(form.includes('<script>bad</script>'), false);
  assert.equal(form.includes('value="" onfocus='), false);
  assert.equal(form.includes('value="correct horse'), false);
  assert.doesNotMatch(form, /每位参与者均提供一台机器/);
  const html = renderAccountSettings({ id: 'one', name: '<unsafe>', username: 'one', address: '0x1' }, [
    { id: 'one', name: '<unsafe>', selectable: true },
    { id: 'two', name: '可切换', selectable: true },
    { id: 'locked', name: '需登录', selectable: false },
  ]);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<select|切换账户|account-workspace/);
  assert.equal(html.includes('value="locked"'), false);
  assert.match(html, /data-action="logout"/);
  assert.match(renderAccountSettings(null), /href="#\/login"/);
  assert.doesNotMatch(html, /先提供一台机器/);
  const account = { id: 'one', name: '参与者', username: 'one', address: '0x1' };
  assert.doesNotMatch(renderAccountSettings(account, [], { machineCount: 0 }), /先提供一台机器/);
  assert.match(renderAccountSettings(account, [], { machineCount: 0 }), /href="#\/supply">提供我的机器/);
  assert.doesNotMatch(renderAccountSettings(account, [], { machineCount: 1 }), /先提供一台机器/);
});
