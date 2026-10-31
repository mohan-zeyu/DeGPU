import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMachineOnboarding, renderSupplyOffers } from '../src/supply-view.js';
import { services } from '../src/services.js';

test('supply form selects only an owned machine and configures the three implemented services', () => {
  const providers = [{ id: 'A', offers: { 'image-classify-v1': '0.0001', 'blender-render-v1': '0', 'key-search-v1': '0.0002' } },
    { id: 'B', offers: { 'image-classify-v1': '0.0003' } }];
  const before = structuredClone(providers);
  const html = renderSupplyOffers({ providers, selectedId: 'A', services });
  assert.match(html, /id="provider-offers-form"/);
  assert.match(html, /name="providerId" value="A"/);
  assert.match(html, /value="A" selected/);
  assert.match(html, /name="enabled.image-classify-v1" value="1" checked/);
  assert.match(html, /name="enabled.blender-render-v1" value="1">/);
  assert.match(html, /name="offers.blender-render-v1" value="0"/);
  assert.match(html, /图像分类报价/);
  assert.match(html, /ETH \/ 张/);
  assert.match(html, /ETH \/ 项/);
  assert.match(html, /Blender 渲染报价/);
  assert.match(html, /ETH \/ 帧/);
  assert.doesNotMatch(html, /nonce|Nonce/);
  assert.deepEqual(providers, before);
});

test('unknown selection falls back to a supplied machine, empty ownership starts participation setup', () => {
  const html = renderSupplyOffers({ providers: [{ id: 'OWNED' }], selectedId: 'FOREIGN' });
  assert.match(html, /name="providerId" value="OWNED"/);
  assert.doesNotMatch(html, /FOREIGN/);
  const empty = renderSupplyOffers();
  assert.match(empty, /id="machine-onboarding-form"/);
  assert.match(empty, /登记机器/);
  assert.doesNotMatch(empty, /id="provider-offers-form"|name="providerId"|保存设置/);
});

test('machine onboarding defaults to one enabled service without inventing hardware verification', () => {
  const html = renderMachineOnboarding();
  assert.match(html, /name="enabled.image-classify-v1" value="1" checked/);
  assert.match(html, /name="enabled.blender-render-v1" value="1">/);
  assert.match(html, /name="enabled.key-search-v1" value="1">/);
  assert.match(html, /登记质押 0\.8 ETH/);
  assert.match(html, /<details class="supporting-details"><summary>接入说明<\/summary>/);
  assert.match(html, /从本地入门资金划入质押/);
  assert.match(html, /不会产生真实支出/);
  assert.doesNotMatch(html, /每位参与者需提供|必须提供/);
  for (const service of services.filter(entry => entry.available)) {
    assert.match(html, new RegExp(`name="offers.${service.id}" value="0\\.\\d+"`));
  }
  assert.doesNotMatch(html, /name="(?:gpu|cpu|memory|hardware|stake)"|已联网|已质押|完成硬件核验|nonce/i);
  assert.doesNotMatch(renderMachineOnboarding({ services: [{ id: 'unknown', name: 'Unknown', available: true }] }), /name="offers.unknown"/);
});

test('automation defaults on, saves separately from quotes, and is hidden without service support', () => {
  const providers = [{ id: 'A', offers: {}, autoProcess: true }];
  const html = renderSupplyOffers({ providers, automationAvailable: true });
  assert.match(html, /role="switch" aria-label="自动处理" aria-checked="true"/);
  assert.match(html, /data-action="toggle-provider-automation" data-provider-id="A"/);
  assert.doesNotMatch(html, /data-action="process-provider"/);
  const beforeForm = html.slice(0, html.indexOf('<form'));
  assert.match(beforeForm, /toggle-provider-automation/);
  assert.doesNotMatch(html.slice(html.indexOf('<form')), /toggle-provider-automation/);
  assert.doesNotMatch(renderSupplyOffers({ providers }), /role="switch"|process-provider/);
  assert.match(renderSupplyOffers({ providers: [{ id: 'A' }], automationAvailable: true }), /aria-checked="true"/);
});

test('manual handling applies to the selected owned machine', () => {
  const html = renderSupplyOffers({ providers: [{ id: 'A', autoProcess: true }, { id: 'B"', autoProcess: false }], selectedId: 'B"', automationAvailable: true });
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /data-action="process-provider" data-provider-id="B&quot;"/);
  assert.doesNotMatch(html, /data-action="process-provider" data-provider-id="A"/);
  assert.doesNotMatch(renderSupplyOffers({ automationAvailable: true }), /role="switch"|process-provider/);
});

test('supply renderer preserves editable wei precision, escapes labels, and excludes unimplemented task offers', () => {
  const html = renderSupplyOffers({ providers: [{ id: 'A"', name: '<script>name</script>', offers: { 'image-classify-v1': '0.000000000000000001' } }],
    services: [...services, { id: 'unimplemented', name: 'other', unit: '项', available: true }] });
  assert.match(html, /value="0.000000000000000001"/);
  assert.match(html, /value="A&quot;"/);
  assert.match(html, /&lt;script&gt;name&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|unimplemented/);
});
