import { services } from './services.js';
import { taskRuntimeLabel } from './task-runtime.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderProviderSettings(state, provider, { live = true } = {}) {
  const behaviors = { cheat: '提供方造假', liar: '复核方造假', offline: '接单后不执行任务' };
  const servingLabel = live && behaviors[provider?.behavior] ? `接单中 · ${behaviors[provider.behavior]}` : '接单中 · 自动执行任务';
  const rows = (live ? state.taskTypes : services).map(service => {
    const task = (state.taskTypes || []).find(task => task.id === service.id);
    const supported = !live || task?.runs_here === true;
    const value = provider?.offers?.[service.id] ?? (supported ? task?.defaultPrice || (service.id === 'blender-render-v1' ? '0.001' : '0.0001') : '0');
    const enabled = Number(value) > 0;
    const runtimeHint = !supported || (live && service.id === 'blender-render-v1');
    return `<div class="provider-price-row"><label class="checkbox"><input name="enabled.${service.id}" type="checkbox"${enabled ? ' checked' : ''}${supported || enabled ? '' : ' disabled'}>${esc(service.name)}</label><label><span>ETH / ${service.unit || '项'}</span><input name="offers.${service.id}" inputmode="decimal" type="text" value="${esc(value)}" pattern="[0-9]+(\\.[0-9]{1,18})?" aria-label="${esc(service.name)}报价" required${supported || enabled ? '' : ' disabled'}></label>${runtimeHint ? `<span class="provider-unsupported">${esc(taskRuntimeLabel(task))}${!supported && enabled ? '；可取消勾选将现有报价设为零' : ''}</span>` : ''}</div>`;
  }).join('');
  const active = live ? provider?.autoProcess : provider?.listed;
  return `<section class="panel provider-settings"><div class="panel-head"><h2>${provider ? '任务与报价' : '登记我的机器'}</h2>${provider ? `<button class="btn${active ? '' : ' primary'}" data-action="serve">${active ? '停止提供' : '开始提供'}</button>` : ''}</div>${provider ? `<div class="provider-serve-state"><span class="state-dot${active ? ' is-complete' : ''}"></span>${active ? servingLabel : '未接单'}</div>` : ''}<form id="${provider ? 'provider-offers-form' : 'machine-onboarding-form'}">${provider ? '' : '<label class="register-stake">登记质押 · ETH<input name="stake" value="1" inputmode="decimal" type="text" pattern="[0-9]+(\\.[0-9]{1,18})?" required></label>'}<div class="provider-price-list">${rows}</div><div class="form-actions"><button class="btn primary" type="submit">${provider ? '保存报价' : '登记、质押并开始提供'}</button></div></form>${provider && live ? `<form id="stake-form" class="stake-inline"><label>质押金额 · ETH<input name="amount" placeholder="0.5" inputmode="decimal" type="text" pattern="[0-9]+(\\.[0-9]{1,18})?" required></label><label>操作<select name="operation"><option value="add">追加质押</option><option value="withdraw"${Number(provider.lockedJobs) > 0 ? ' disabled' : ''}>取回质押</option></select></label><button class="btn" type="submit">确认</button></form>` : ''}${provider && live ? '<p class="muted">运行服务与链上报价独立。停止运行后若仍有报价，仍可能被抽中复核并因不响应受罚。</p><button class="btn" data-action="stop-offering">停止报价（全部设为零）</button>' : ''}${provider?.warning ? `<p class="form-error" role="status">${esc(provider.warning)}</p>` : ''}</section>`;
}
