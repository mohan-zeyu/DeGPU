import { services as registeredServices } from './services.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const implemented = new Set(registeredServices.filter(service => service.available).map(service => service.id));
const offered = value => typeof value === 'string' && /^\d+(?:\.\d{1,18})?$/.test(value)
  && /[1-9]/.test(value);

function renderOfferRows(available, offers, enabledServices = null) {
  return available.map(service => {
    const quote = String(offers[service.id] ?? '0');
    const enabled = enabledServices ? enabledServices.has(service.id) : offered(quote);
    return `<div class="supply-offer-row"><label class="checkbox"><input type="checkbox" name="enabled.${service.id}" value="1"${enabled ? ' checked' : ''}>${esc(service.name)}</label><label class="supply-price"><span>ETH / ${esc(service.unit)}</span><input type="text" inputmode="decimal" name="offers.${service.id}" value="${esc(quote)}" pattern="[0-9]+(\\.[0-9]{1,18})?" aria-label="${esc(service.name)}报价" autocomplete="off" required></label></div>`;
  }).join('');
}

/** Local participation setup; it does not attest hardware, connectivity or stake. */
export function renderMachineOnboarding({ services = registeredServices } = {}) {
  const available = services.filter(service => service.available && implemented.has(service.id));
  const quotes = { 'image-classify-v1': '0.0001', 'blender-render-v1': '0.0003', 'key-search-v1': '0.0002' };
  return `<section class="panel" aria-label="登记机器"><div class="panel-head"><h2>提供我的机器</h2></div><form id="machine-onboarding-form"><div class="supply-offers">${renderOfferRows(available, quotes, new Set(['image-classify-v1']))}</div><details class="supporting-details"><summary>接入说明</summary><p>0.8 ETH 从本地入门资金划入质押。登记与资金仅保存在本机内存，未连接真实机器，也不发送链上交易，不会产生真实支出。</p></details><div class="form-footer"><span>登记质押 0.8 ETH</span><button class="btn primary" type="submit">登记机器</button></div><p class="form-error" id="machine-onboarding-error" role="alert" hidden></p></form></section>`;
}

// The caller supplies only machines owned by the signed-in account. Ownership
// must also be enforced when saving; rendering does not authorize a write.
export function renderSupplyOffers({ providers = [], selectedId = null, services = registeredServices, showMachineSelector = true, automationAvailable = false, listingAvailable = false } = {}) {
  const provider = providers.find(entry => entry.id === selectedId) ?? providers[0];
  if (!provider) return renderMachineOnboarding({ services });
  const available = services.filter(service => service.available && implemented.has(service.id));
  const machineOptions = providers.map(entry => `<option value="${esc(entry.id)}"${entry.id === provider.id ? ' selected' : ''}>${esc(entry.name || `机器 ${entry.id}`)}</option>`).join('');
  const listed = provider.listed ?? Object.values(provider.offers || {}).some(offered);
  const rows = renderOfferRows(available, !listed && provider.savedOffers ? provider.savedOffers : provider.offers || {});
  const selector = showMachineSelector ? `<label class="supply-machine">我的机器<select id="supply-provider-select" aria-label="我的机器">${machineOptions}</select></label>` : '';
  const automatic = provider.autoProcess !== false;
  const listingBusy = provider.listingBusy === true || Number(provider.lockedJobs) > 0;
  const listing = listingAvailable ? `<div class="supply-control"${listed && listingBusy ? ' title="任务结束后可下架"' : ''}><span>上架接单</span><button type="button" class="automation-toggle" role="switch" aria-label="上架接单" aria-checked="${listed}"${listed && listingBusy ? ' aria-description="任务结束后可下架"' : ''} data-action="toggle-provider-listing" data-provider-id="${esc(provider.id)}"${listed && listingBusy ? ' disabled' : ''}></button></div>` : '';
  const automation = automationAvailable ? `<div class="supply-control"><span>自动处理</span><button type="button" class="automation-toggle" role="switch" aria-label="自动处理" aria-checked="${automatic}" data-action="toggle-provider-automation" data-provider-id="${esc(provider.id)}"></button></div>` : '';
  const retry = listingAvailable && provider.listingPending ? `<span role="status">下架未完成</span><button type="button" class="btn" data-action="retry-provider-unlisting" data-provider-id="${esc(provider.id)}"${listingBusy ? ' disabled' : ''}>重试下架</button>` : '';
  const manual = automationAvailable && !automatic ? `<button type="button" class="btn" title="手动处理待办，超时规则仍生效" data-action="process-provider" data-provider-id="${esc(provider.id)}">处理待办</button>` : '';
  const controls = listing || automation ? `<div class="supply-controls">${listing}${automation}</div>${retry || manual ? `<div class="supply-control-actions">${retry}${manual}</div>` : ''}` : '';
  return `<section class="panel" aria-label="机器报价"><div class="panel-head"><h2>任务与报价</h2>${selector}</div>${controls}<form id="provider-offers-form"><input type="hidden" name="providerId" value="${esc(provider.id)}"><div class="supply-offers">${rows}</div><div class="form-actions"><button class="btn primary" type="submit" data-action="save-offers">保存设置</button></div></form></section>`;
}
