import test from 'node:test';
import assert from 'node:assert/strict';
import { services, getService, getServiceItemLimit, validateServiceInput } from '../src/services.js';

test('live task quantities match image upload and default key-search execution budgets', () => {
  for (const [id, limit] of [['image-classify-v1', 200], ['key-search-v1', 256], ['blender-render-v1', 1000]]) {
    const service = getService(id);
    assert.equal(getServiceItemLimit(service, { live: true }), limit);
    assert.equal(validateServiceInput(service, { itemCount: limit }, { live: true }), null);
    assert.equal(validateServiceInput(service, { itemCount: limit + 1 }, { live: true }), `${service.countLabel}须为 1–${limit} 的整数。`);
  }
  assert.equal(getServiceItemLimit(getService('key-search-v1'), { live: true }) * 2 ** 12, 2 ** 20);
});

test('offline preview retains its existing 1000-item limits', () => {
  for (const service of services) {
    assert.equal(getServiceItemLimit(service), 1000);
    assert.equal(validateServiceInput(service, { itemCount: 1000 }), null);
    assert.ok(validateServiceInput(service, { itemCount: 1001 }));
  }
});

test('live quantity errors use the active execution limit for malformed and fractional values', () => {
  const service = getService('image-classify-v1');
  for (const itemCount of [0, -1, 1.5, NaN, Infinity, '2', undefined]) {
    assert.equal(validateServiceInput(service, { itemCount }, { live: true }), '图片数量须为 1–200 的整数。');
  }
  assert.equal(validateServiceInput(service, { itemCount: 1 }, { live: true }), null);
});
