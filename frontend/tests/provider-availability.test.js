import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderAvailability } from '../src/provider-availability.js';

const IMAGE = 'image-classify-v1';
const NONCE = 'nonce-search-v1';
const provider = overrides => ({
  id: 'A', registered: true, active: true, lockedJobs: 0,
  offers: { [IMAGE]: '0.0001', [NONCE]: '0' }, ...overrides,
});

test('registration and active stake never imply online and idle task availability', () => {
  const machine = provider();
  const before = structuredClone(machine);
  const idle = getProviderAvailability(machine, IMAGE, { connectivity: 'online' });
  assert.equal(idle.available, true);
  assert.equal(idle.label, '可接单');
  assert.match(idle.reason, /机器在线/);
  assert.match(getProviderAvailability(machine, IMAGE).reason, /在线状态未提供/);
  assert.ok(Object.isFrozen(idle));
  assert.equal(getProviderAvailability(machine, IMAGE, { connectivity: 'offline' }).label, '离线');
  assert.equal(getProviderAvailability(provider({ lockedJobs: 1 }), IMAGE).label, '任务占用');
  assert.equal(getProviderAvailability(provider({ lockedJobs: '2' }), IMAGE).available, false);
  assert.equal(getProviderAvailability(provider({ lockedJobs: 1n }), IMAGE).available, false);
  assert.equal(getProviderAvailability(provider({ lockedJobs: '0' }), IMAGE).available, true);
  assert.deepEqual(machine, before);
});

test('service availability requires a positive precise offer and uses total locks across services', () => {
  assert.equal(getProviderAvailability(provider(), NONCE).label, '暂停服务');
  assert.equal(getProviderAvailability(provider(), 'blender-render-v1').available, false);
  assert.equal(getProviderAvailability(provider({ offers: { [IMAGE]: '0.000000000000000001' } }), IMAGE).available, true);
  for (const offer of ['0', '0.000', '-1', 'NaN', '1e-4', '0.0000000000000000001', null, undefined]) {
    assert.equal(getProviderAvailability(provider({ offers: { [IMAGE]: offer } }), IMAGE).available, false);
  }
  const busy = provider({ lockedJobs: 1, offers: { [IMAGE]: '0.0001', [NONCE]: '0.0002' } });
  assert.equal(getProviderAvailability(busy, IMAGE).available, false);
  assert.equal(getProviderAvailability(busy, NONCE).available, false);
});

test('missing eligibility or assignment information stays unavailable instead of guessing', () => {
  assert.equal(getProviderAvailability(null, IMAGE).available, false);
  for (const registered of [false, null, undefined, 'true', 1]) {
    assert.equal(getProviderAvailability(provider({ registered }), IMAGE).label, '未满足接单条件');
  }
  for (const active of [false, null, undefined, 'true', 1]) {
    assert.equal(getProviderAvailability(provider({ active }), IMAGE).label, '未满足接单条件');
  }
  for (const lockedJobs of [null, undefined, -1, 0.5, NaN, 'unknown', '', Number.MAX_SAFE_INTEGER + 1]) {
    const availability = getProviderAvailability(provider({ lockedJobs }), IMAGE);
    assert.equal(availability.available, false);
    assert.equal(availability.label, '未满足接单条件');
    assert.match(availability.reason, /未知/);
  }
});
