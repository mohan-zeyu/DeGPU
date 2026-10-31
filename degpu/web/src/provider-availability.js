import { getProviderOffer } from './services.js';

const result = (available, label, reason) => Object.freeze({ available, label, reason });
const unmet = reason => result(false, '未满足接单条件', reason);

function positiveQuote(value) {
  if (!['string', 'number'].includes(typeof value)) return false;
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  return Boolean(match && /[1-9]/.test(`${match[1]}${match[2] ?? ''}`));
}

function lockedCount(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return BigInt(value);
}

// Registry eligibility, the selected service's offer, public connectivity and
// total assignment locks are separate facts. An active stake does not attest
// that a machine is online or free to accept another task.
export function getProviderAvailability(provider, taskType, { connectivity } = {}) {
  if (!provider || provider.registered !== true) return unmet('机器尚未完成注册或注册状态未知。');
  if (provider.active !== true) return unmet('机器未满足接单条件或资格状态未知。');
  if (provider.listed === false) return result(false, '已下架', '机器已停止接受新任务。');
  if (!positiveQuote(getProviderOffer(provider, taskType))) {
    return result(false, '暂停服务', '机器尚未开启此服务的正报价。');
  }
  if (connectivity === 'offline') return result(false, '离线', '机器当前离线。');
  const locks = lockedCount(provider.lockedJobs);
  if (locks === null) return unmet('机器任务占用状态未知。');
  if (locks > 0n && !provider.concurrentJobs) return result(false, '任务占用', '机器仍有进行中的任务。');
  return result(true, '可接单', connectivity === 'online'
    ? '机器在线，链上资格与报价符合接单条件。'
    : '链上资格与报价符合接单条件；在线状态未提供。');
}
