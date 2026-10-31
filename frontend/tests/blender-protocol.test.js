import test from 'node:test';
import assert from 'node:assert/strict';
import { BLENDER_RUNNER, parseBlenderFrames, validateBlenderSceneName } from '../src/blender-protocol.js';
import { services, getService, modeLabel } from '../src/services.js';

test('Blender frame inputs follow Python order, ranges and duplicate semantics', () => {
  assert.deepEqual(parseBlenderFrames('1-3, 10,2'), [1, 2, 3, 10, 2]);
  assert.deepEqual(parseBlenderFrames('0,4-4'), [0, 4]);
  assert.equal(parseBlenderFrames('1-1000').length, 1000);
  assert.deepEqual(parseBlenderFrames('9007199254740991'), [Number.MAX_SAFE_INTEGER]);
  assert.ok(Object.isFrozen(parseBlenderFrames('1')));
});

test('invalid or oversized Blender frame specifications fail before allocation or submission', () => {
  for (const spec of ['', ' ', '1,', '3-1', '1-2-3', '-1', '1.5', '1e5', 'NaN', '9007199254740992', '1-1001', '1-1000,1', '0-999999999999']) {
    assert.throws(() => parseBlenderFrames(spec), spec);
  }
  for (const value of [null, undefined, 12, []]) assert.throws(() => parseBlenderFrames(value));
  for (const name of ['../scene.blend', 'C:/scene.blend', 'scene.png', '', 'scene\u0000.blend']) {
    assert.throws(() => validateBlenderSceneName(name));
  }
  assert.equal(validateBlenderSceneName('我的场景.blend'), '我的场景.blend');
});

test('installed services match v4 tasks and keep exact, similar and checked verification separate', () => {
  assert.deepEqual(services.map(service => service.id), ['image-classify-v1', 'blender-render-v1', 'key-search-v1']);
  assert.ok(services.every(service => service.available && !service.protocolOnly));
  assert.equal(getService('nonce-search-v1'), undefined);
  assert.equal(BLENDER_RUNNER.blenderVersion, '5.2');
  assert.equal(BLENDER_RUNNER.secondsPerItem, 30);
  assert.equal(BLENDER_RUNNER.grid, 8);
  assert.equal(BLENDER_RUNNER.maxTileMseX1000, 65025);
  assert.equal(modeLabel('replicated', 'exact'), '精确结果复核');
  assert.equal(modeLabel('replicated', 'similar'), '相似度复核');
  assert.equal(modeLabel('checked'), '合约直接检验');
});
