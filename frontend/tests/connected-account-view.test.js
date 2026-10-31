import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectedAuthPage, renderAccountSettings } from '../src/account-view.js';

test('account connection accepts an address without presenting other identities or password authentication', () => {
  const html = renderConnectedAuthPage('<error>', { address: '" onfocus="bad' });
  assert.match(html, /name="address"/);
  assert.match(html, /minlength="42" maxlength="42"/);
  assert.match(html, /尚未接入钱包签名认证/);
  assert.match(html, /role="alert">&lt;error&gt;/);
  assert.match(html, /aria-describedby="account-connection-error"/);
  assert.doesNotMatch(html, /<select|type="password"|name="username"|href="#\/register"|value="" onfocus=/);
});

test('connected account settings show only the active address with an exit action', () => {
  const current = { id: 'user-01', name: '<one>', address: '0x' + '1'.repeat(40) };
  const html = renderAccountSettings(current, [{ id: 'user-02', name: 'other', selectable: true }], { connected: true });
  assert.match(html, /&lt;one&gt;/);
  assert.match(html, new RegExp(current.address));
  assert.match(html, /data-action="logout">退出账户/);
  assert.doesNotMatch(html, /<select|other|注册账号|@undefined/);
});
