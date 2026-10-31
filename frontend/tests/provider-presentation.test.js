import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProviderBehavior, providerBehaviors, renderProviderPresentation } from '../src/provider-presentation.js';

const provider = { id: 'OWN', registered: true, behavior: 'honest', autoProcess: true, lockedJobs: 0, offers: { 'image-classify-v1': '0.0001' } };

test('all four choices change the actual serving agent and start serving', async () => {
  const calls = [];
  const client = { async setProviderServing(input) { calls.push(input); return { behavior: input.behavior }; } };
  for (const behavior of providerBehaviors) {
    const response = await applyProviderBehavior(client, { ...provider, autoProcess: false }, behavior.id);
    assert.equal(response.behavior, behavior.id);
  }
  assert.deepEqual(calls, ['honest', 'cheat', 'liar', 'offline'].map(behavior => ({ providerId: 'OWN', on: true, behavior })));
  assert.equal(provider.behavior, 'honest', 'do not optimistically mutate the displayed server state');
});

test('exit restores honest behavior without starting a stopped provider', async () => {
  const calls = [];
  const client = { async setProviderServing(input) { calls.push(input); } };
  for (const autoProcess of [true, false]) await applyProviderBehavior(client, { ...provider, behavior: 'offline', autoProcess }, 'honest', { exit: true });
  assert.deepEqual(calls, [true, false].map(on => ({ providerId: 'OWN', on, behavior: 'honest' })));
});

test('invalid choices cannot change the running agent', async () => {
  const client = { async setProviderServing() { assert.fail('must not send a request'); } };
  await assert.rejects(applyProviderBehavior(client, null, 'cheat'), /登记本机/);
  await assert.rejects(applyProviderBehavior({}, provider, 'cheat'), /登记本机/);
  await assert.rejects(applyProviderBehavior(client, provider, 'made-up'), /未知/);
});

test('a rejected backend change remains an error instead of a simulated success', async () => {
  const client = { async setProviderServing() { throw new Error('服务未连接'); } };
  await assert.rejects(applyProviderBehavior(client, provider, 'cheat'), /服务未连接/);
  assert.equal(provider.behavior, 'honest');
});

test('the panel reflects server behavior, explains verifier selection and has no fictional task', () => {
  const html = renderProviderPresentation({ ...provider, behavior: 'liar' });
  assert.match(html, /当前：复核方造假/);
  assert.match(html, /data-behavior="liar" aria-pressed="true"/);
  assert.match(html, /被抽中为复核方/);
  assert.match(html, /租赁另一台机器并开启复核/);
  assert.doesNotMatch(html, /模拟耗时|模拟情景|演示工作站|presentation-next|不提交交易|演示罚没/);
  assert.match(renderProviderPresentation({ ...provider, behavior: 'cheat' }), /密钥错误答案会被合约拒绝/);
  const locked = renderProviderPresentation({ ...provider, lockedJobs: 1, offers: {} });
  assert.equal((locked.match(/aria-pressed="(?:true|false)" disabled/g) || []).length, 0);
  assert.match(locked, /非零报价/);
  assert.equal(renderProviderPresentation(null), '');
});

test('active jobs can change behavior through upstream serve API', async () => {
  let sent;
  await applyProviderBehavior({ async setProviderServing(input) { sent = input; } }, { ...provider, lockedJobs: 1 }, 'honest');
  assert.equal(sent.behavior, 'honest');
  assert.equal(sent.on, true);
});
