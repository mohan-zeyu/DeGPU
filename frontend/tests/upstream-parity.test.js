import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleProviders, readTaskInput, estimateTask, renderLivePublish } from '../src/live-publish.js';
import { jobActions, renderParties, exactMoney, renderActivity } from '../src/parity-view.js';
import { getProviderAvailability } from '../src/provider-availability.js';

const image = { id: 'image-classify-v1', name: '图像分类', mode: 'replicated', fields: [
  { name: 'model', type: 'file', default: '/assets/model.onnx' },
  { name: 'images', type: 'files', default: '/assets/images' },
  { name: 'limit', type: 'int', default: 200 },
] };
const provider = { id: '0xBB', address: '0xBB', active: true, registered: true, concurrentJobs: true, lockedJobs: 2,
  offers: { [image.id]: '0.0001' }, prices_wei: { [image.id]: '100000000000000' } };

test('upstream eligibility permits repeat and concurrent rentals but excludes own, inactive and zero quotes', () => {
  const state = { account: { address: '0xAA' }, providers: [provider, { ...provider, id: 'self', address: '0xaa' },
    { ...provider, id: 'inactive', active: false }, { ...provider, id: 'zero', prices_wei: { [image.id]: '0' } }] };
  assert.deepEqual(eligibleProviders(state, image).map(p => p.id), ['0xBB']);
  assert.equal(getProviderAvailability(provider, image.id).available, true);
});

test('default uploads are omitted and an explicit image limit selects a subset', () => {
  const form = new FormData();
  form.append('limit', '2');
  form.append('model', new File([], ''));
  let input = readTaskInput(image, form);
  assert.deepEqual(input.files, {});
  assert.equal(estimateTask(image, input, provider, '2').upperBound, true);
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) form.append('images', new File(['image'], name));
  input = readTaskInput(image, form);
  assert.equal(input.files.images.length, 3);
  assert.deepEqual(estimateTask(image, input, provider, '0.0004'), { total: 2, upperBound: false, deposit: '0.0004', valid: true, sufficient: true });
});

test('dynamic plugins retain all declared fields, files, bool and unknown deposits', () => {
  const task = { id: 'new-plugin', name: '自定义任务', mode: 'checked', fields: [
    { name: 'scale', type: 'float', default: 1.5 }, { name: 'title', type: 'str' },
    { name: 'enabled', type: 'bool' }, { name: 'inputs', type: 'files' }] };
  const form = new FormData();
  form.append('scale', '2.75'); form.append('title', 'test'); form.append('enabled', 'on');
  form.append('inputs', new File(['x'], 'x.bin'));
  const input = readTaskInput(task, form);
  assert.deepEqual(input.fields, { scale: '2.75', title: 'test', enabled: true });
  assert.equal(input.files.inputs.length, 1);
  assert.equal(estimateTask(task, input, provider, '0').deposit, null);
  const html = renderLivePublish({ account: { address: '0xAA', balance: '2' }, providers: [], taskTypes: [task] }, new URLSearchParams());
  assert.match(html, /name="scale" type="number" step="any"/);
  assert.match(html, /name="inputs" type="file" multiple/);
});

test('published default verify is false and files may use backend defaults', () => {
  const html = renderLivePublish({ account: { address: '0xAA', balance: '2' }, providers: [provider], taskTypes: [image] }, new URLSearchParams());
  assert.match(html, /<option value="false">不要求复核/);
  assert.match(html, /留空使用本机默认文件/);
  assert.doesNotMatch(html, /type="file"[^>]*required/);
  assert.match(html, /name="limit" type="number"/);
});

test('checked totals, frame parsing, invalid counts and one wei balances match backend deposit semantics', () => {
  const checked = { id: 'key-search-v1', mode: 'checked', fields: [] };
  const p = { offers: { [checked.id]: '0.000000000000000001' } };
  const result = estimateTask(checked, { fields: { keys: '3', impossible: '5' } }, p, '0.000000000000000007');
  assert.equal(result.total, 8); assert.equal(result.deposit, '0.000000000000000008'); assert.equal(result.sufficient, false);
  assert.equal(estimateTask(checked, { fields: { keys: '0', impossible: '2' } }, p, '1').total, 2);
  assert.equal(estimateTask(checked, { fields: { keys: '1.5' } }, p, '1').valid, false);
  assert.equal(estimateTask({ id: 'blender-render-v1', mode: 'replicated', fields: [] }, { fields: { frames: '1-3,8' } }, provider, '1').total, 4);
  assert.equal(estimateTask({ id: 'blender-render-v1', mode: 'replicated', fields: [] }, { fields: { frames: '1-1001' } }, provider, '1').total, 1001);
  assert.equal(exactMoney('1234567890123456.000000000000000001'), '1234567890123456.000000000000000001');
});

test('original API without chain clock retains contract adjudicated timeout action', () => {
  const job = { phase: 'Working', closed: false, deadline: 100, chainClockKnown: false, observedChainTimestamp: 80 };
  assert.equal(jobActions(job, true).expire, true);
  assert.equal(jobActions(job, true).expireLabel, '检查并处理超时');
  assert.equal(jobActions({ ...job, chainClockKnown: true }, true).expire, false);
  assert.equal(jobActions({ ...job, closed: true }, true).expire, false);
  assert.equal(jobActions({ ...job, phase: 'Open', deadlinePassed: true }, false).cancel, true);
});

test('parties preserve verifier states, assigned item ranges and dropped verification reason', () => {
  const html = renderParties({ mode: 'replicated', clientAddress: '<client>', provider: 'main', dropped: 'no_eligible_verifier', verifierDetails: [{ address: 'check', items: [2, 5], state: 'missed' }], disputedItems: [3], tieProvider: 'tie' });
  assert.match(html, /&lt;client&gt;/); assert.match(html, /项目 2–4/); assert.match(html, /超时/);
  assert.match(html, /符合条件的复核方不足/); assert.match(html, /裁决方/);
  assert.match(renderActivity({ activity: [{ seq: 1, message: '<script>' }] }), /&lt;script&gt;/);
});
