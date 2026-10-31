import { services, getService, getProviderOffer } from './services.js';
import { getProviderAvailability } from './provider-availability.js';
import { ethToWei, weiToEth } from './network-client.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = value => value?.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value || '—';
export function estimatePublish(taskType, { count = 1, impossible = 0, quote = '0', balance = '0' } = {}) {
  const task = getService(taskType);
  if (!task || !Number.isSafeInteger(Number(count)) || Number(count) < 0 || (task.mode === 'checked' && (!Number.isSafeInteger(Number(impossible)) || Number(impossible) < 0))) return { valid: false, total: null, deposit: null, sufficient: false };
  const total = Number(count) + (task?.mode === 'checked' ? Number(impossible) : 0);
  if (!Number.isInteger(total) || total < 1 || total > 1000) return { valid: false, total, deposit: null, sufficient: false };
  try {
    const depositWei = BigInt(ethToWei(quote));
    const cost = BigInt(depositWei) * BigInt(total) * (task?.mode === 'checked' ? 1n : 2n);
    return { valid: true, total, deposit: weiToEth(cost), sufficient: cost <= BigInt(ethToWei(balance)) };
  } catch { return { valid: false, total, deposit: null, sufficient: false }; }
}
export function renderPublishPage(state, params, { live, account, mine }) {
  const taskType = getService(params.get('type'))?.id || 'image-classify-v1';
  const task = getService(taskType);
  const plugin = state.taskTypes.find(type => type.id === taskType);
  const providers = state.providers.filter(provider => !mine(provider) && getProviderAvailability(provider, taskType).available)
    .sort((a, b) => { const left = BigInt(ethToWei(getProviderOffer(a, taskType))); const right = BigInt(ethToWei(getProviderOffer(b, taskType))); return left < right ? -1 : left > right ? 1 : 0; });
  const selected = providers.find(provider => provider.id === params.get('provider')) || providers[0];
  const checked = task.mode === 'checked';
  const rendering = task.compare === 'similar';
  const count = checked ? 8 : rendering ? 12 : 1;
  const estimate = estimatePublish(taskType, { count, quote: getProviderOffer(selected, taskType) || '0', balance: account.balance });
  const others = Math.max(0, providers.length - 1);
  const [balanceWhole, balanceFraction = ''] = String(account.balance || '0').split('.');
  const shortFraction = balanceFraction.slice(0, 8).replace(/0+$/, '');
  const shortBalance = `${balanceWhole}${shortFraction ? `.${shortFraction}` : ''}`;
  const displayBalance = shortBalance === '0' && /[1-9]/.test(balanceFraction) ? '<0.00000001' : shortBalance;
  const disabled = !selected || !estimate.sufficient || plugin?.code_matches === false;
  return `<div class="head"><h1>任务发布</h1></div><form id="new-job-form" class="panel publish-panel"><div class="fields"><label>任务类型<select name="taskType" id="task-type">${services.map(service => `<option value="${service.id}"${service.id === taskType ? ' selected' : ''}>${service.name}</option>`).join('')}</select></label><label>提供机器<select name="provider" id="new-provider" required>${providers.map(provider => `<option value="${esc(provider.id)}"${provider.id === selected?.id ? ' selected' : ''}>${esc(short(provider.id))} · ${esc(getProviderOffer(provider, taskType))} ETH / ${task.unit}</option>`).join('')}</select></label><label>${checked ? '可解挑战数量' : task.countLabel}<input name="itemCount" id="item-count" type="number" min="${checked ? '0' : '1'}" max="1000" value="${count}"${checked ? '' : ' readonly'} required></label>${checked ? '<label>搜索位数<input name="bits" type="number" value="12" min="1" max="24" required></label><label>额外无解挑战<input name="impossible" type="number" value="0" min="0" max="1000" required></label>' : '<label>结果复核<select name="verify" id="new-verify"><option value="true">要求复核</option><option value="false">不要求复核</option></select></label>'}${rendering ? '<label class="full">渲染帧号<input name="frames" id="frame-spec" value="1-12" required></label><label class="full">Blender 场景<input name="scene" type="file" accept=".blend" required></label>' : checked ? '' : '<label>ONNX 模型<input name="model" type="file" accept=".onnx" required></label><label>图片<input name="images" id="image-files" type="file" accept=".jpg" multiple required></label>'}</div><div class="publish-feedback"><span id="publish-balance" title="余额 ${esc(account.balance)} ETH">余额 ${esc(displayBalance)} ETH</span><span id="publish-capacity" data-others="${others}"${checked ? ' hidden' : ''}>${others < 2 ? '可用复核方不足，本次将按未复核任务执行。' : others === 2 ? '可进行双重复核，暂无备用裁决方。' : '可进行双重复核与争议裁决。'}</span></div><div class="form-footer"><strong id="deposit-preview">预存 ${esc(estimate.deposit || '0')} ETH</strong><button class="btn primary" type="submit"${disabled ? ' disabled' : ''}>发布任务</button></div><p class="form-error" id="publish-validation">${!selected ? '当前没有提供此任务的可用机器。' : plugin?.code_matches === false ? '任务代码与网络版本不一致，请先更新。' : !estimate.sufficient ? '余额不足以支付预存。' : ''}</p><p class="form-error" id="form-error" role="alert" hidden></p></form>`;
}
