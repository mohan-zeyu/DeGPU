const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const providerBehaviors = [
  { id: 'honest', label: '正常计算', description: '按任务要求计算和复核，正常提交结果。' },
  { id: 'cheat', label: '提供方造假', description: '作为提供方伪造结果。图像任务开启复核可展示争议与罚没；密钥错误答案会被合约拒绝，随后超时。' },
  { id: 'liar', label: '复核方造假', description: '被抽中为复核方时提交随机结果。请让其他人租赁另一台机器并开启复核；本机作为主计算方时仍正常计算。' },
  { id: 'offline', label: '接单后离线', description: '接单后不计算、不提交结果，也不响应复核。截止后由任务参与者处理超时。' },
];

// Changes the actual local provider agent; state is refreshed by the live client
// only after the server acknowledges the change. No synthetic jobs or events.
export async function applyProviderBehavior(client, provider, behavior, { exit = false } = {}) {
  if (!provider?.registered || typeof client.setProviderServing !== 'function') throw new Error('请先连接钱包并登记本机。');
  if (!providerBehaviors.some(entry => entry.id === behavior)) throw new Error('未知的接单行为。');
  return client.setProviderServing({ providerId: provider.id, on: exit ? Boolean(provider.autoProcess) : true, behavior });
}

export function renderProviderPresentation(provider) {
  if (!provider?.registered) return '';
  const selected = providerBehaviors.find(entry => entry.id === provider.behavior);
  const locked = Number(provider.lockedJobs) > 0;
  const offering = Object.values(provider.offers || {}).some(value => Number(value) > 0);
  return `<section class="panel provider-behavior" aria-label="真实接单演示">
    <div class="provider-behavior-head"><h2>真实接单行为</h2><span role="status">${provider.autoProcess ? '接单中' : '未接单'} · 当前：${esc(selected?.label || '未知')}</span></div>
    <div class="provider-behavior-options" role="group" aria-label="接单行为">${providerBehaviors.map(entry => `<button type="button" class="btn${entry.id === provider.behavior ? ' primary' : ''}" data-action="provider-behavior" data-behavior="${entry.id}" aria-pressed="${entry.id === provider.behavior}">${entry.label}</button>`).join('')}<span>选择后立即生效，其他人可租赁本机。</span></div>
    <p class="provider-behavior-description">${locked ? '当前有任务进行中，行为修改由原后端执行；进行中的计算可能先完成。' : esc(selected?.description || '请重新选择接单行为。')}${!offering ? ' 请先在下方设置非零报价。' : ''}</p>
  </section>`;
}
