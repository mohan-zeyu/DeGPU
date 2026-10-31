import { ethToWei, weiToEth } from './network-client.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { model: 'ONNX 模型', images: '图片', limit: '最多处理图片数', keys: '可解挑战数量', bits: '搜索位数', impossible: '额外无解挑战', scene: 'Blender 场景', frames: '渲染帧号' };
const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

// Match upstream Post.tsx: open jobs do not remove a provider from eligibility.
export function eligibleProviders(state, task) {
  return state.providers.filter(p => p.active && !same(p.address || p.id, state.account.address)
    && BigInt(p.prices_wei?.[task.id] ?? ethToWei(p.offers?.[task.id] || '0')) > 0n)
    .sort((a, b) => {
      const price = p => BigInt(p.prices_wei?.[task.id] ?? ethToWei(p.offers?.[task.id] || '0'));
      return price(a) < price(b) ? -1 : price(a) > price(b) ? 1 : 0;
    });
}

export function readTaskInput(task, data) {
  const fields = {}, files = {};
  for (const field of task.fields || []) {
    if (['file', 'files'].includes(field.type)) {
      const selected = data.getAll(field.name).filter(f => f?.name && f.size > 0);
      if (selected.length) files[field.name] = selected;
    } else if (field.type === 'bool') {
      if (data.has(field.name)) fields[field.name] = true;
    } else {
      const value = data.get(field.name);
      if (value !== null && value !== '') fields[field.name] = String(value);
    }
  }
  return { fields, files };
}

export function estimateTask(task, input, provider, balance = '0') {
  const values = Object.fromEntries((task.fields || []).filter(f => !['file', 'files'].includes(f.type)).map(f => [f.name, f.default]));
  Object.assign(values, input.fields);
  let total = null, upperBound = false;
  try {
    const integer = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('数量须为非负整数。'); return n; };
    if (task.id === 'key-search-v1') total = integer(values.keys) + integer(values.impossible || 0);
    if (task.id === 'blender-render-v1') {
      total = 0;
      for (const part of String(values.frames || '').split(',')) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
        if (!match) { total = null; break; }
        total += match[2] ? Math.max(0, Number(match[2]) - Number(match[1]) + 1) : 1;
      }
    }
    if (task.id === 'image-classify-v1') {
      const limit = integer(values.limit);
      const files = input.files?.images;
      total = files?.length ? Math.min(files.filter(f => f.name.endsWith('.jpg')).length, limit) : limit;
      upperBound = !files?.length;
    }
    if (total !== null && (!Number.isSafeInteger(total) || total < 1)) throw new Error('任务工作量须大于零。');
    const quote = BigInt(provider?.prices_wei?.[task.id] ?? ethToWei(provider?.offers?.[task.id] || '0'));
    const cost = total === null ? null : BigInt(total) * quote * (task.mode === 'replicated' ? 2n : 1n);
    return { total, upperBound, deposit: cost === null ? null : weiToEth(cost), valid: true,
      sufficient: cost === null || cost <= BigInt(ethToWei(balance)) };
  } catch (error) { return { total, valid: false, sufficient: false, error: error.message }; }
}

function renderField(field) {
  const label = esc(labels[field.name] || field.name);
  const name = esc(field.name);
  const help = esc(field.help || '');
  if (['file', 'files'].includes(field.type)) {
    const accept = { images: '.jpg', model: '.onnx', scene: '.blend' }[field.name];
    const fallback = field.default ? `留空使用本机默认文件：${esc(String(field.default).split(/[\\/]/).pop())}` : '请选择文件';
    return `<label>${label}<input name="${name}" type="file"${field.type === 'files' ? ' multiple' : ''}${accept ? ` accept="${accept}"` : ''}><small>${help} · ${fallback}</small></label>`;
  }
  if (field.type === 'bool') return `<label class="checkbox"><input name="${name}" type="checkbox"${field.default ? ' checked' : ''}>${label}<small>${help}</small></label>`;
  return `<label>${label}<input name="${name}" type="${field.type === 'str' ? 'text' : 'number'}"${field.type === 'str' ? '' : ` step="${field.type === 'float' ? 'any' : '1'}"`} value="${esc(field.default ?? '')}"><small>${help}</small></label>`;
}

export function renderLivePublish(state, params) {
  const task = state.taskTypes.find(t => t.id === params.get('type')) || state.taskTypes.find(t => t.runs_here) || state.taskTypes[0];
  if (!task) return '<div class="head"><h1>任务发布</h1></div><p>当前网络没有可发布的任务类型。</p>';
  const providers = eligibleProviders(state, task);
  const selected = providers.find(p => same(p.id, params.get('provider'))) || providers[0];
  const estimate = estimateTask(task, {}, selected, state.account.balance);
  const others = Math.max(0, providers.length - 1);
  const record = p => Number(p.record?.replicated?.outvoted || 0) + Number(p.record?.replicated?.checks_outvoted || 0);
  return `<div class="head"><h1>任务发布</h1></div><form id="new-job-form" class="panel publish-panel"><div class="fields">
    <label>任务类型<select name="taskType" id="task-type">${state.taskTypes.map(t => `<option value="${esc(t.id)}"${t.id === task.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>提供机器<select name="provider" id="new-provider" required>${providers.map(p => `<option value="${esc(p.id)}"${p === selected ? ' selected' : ''}>${esc(p.address || p.id)} · ${esc(p.offers?.[task.id])} ETH / 项 · ${Number(p.open_jobs || 0)} 个进行中 · ${record(p)} 次被否决</option>`).join('')}</select></label>
    ${task.fields.map(renderField).join('')}
    ${task.mode === 'replicated' ? '<label>结果复核<select name="verify" id="new-verify"><option value="false">不要求复核</option><option value="true">要求复核</option></select></label>' : ''}
    </div><p>${esc(task.description)}</p>${task.mode === 'replicated' ? '<p class="muted">复核决定在主计算提交承诺后公开。两种选择预存相同，未复核时退回一半预存。</p>' : ''}
    <div class="publish-feedback"><span id="publish-balance">余额 ${esc(state.account.balance)} ETH</span><span id="publish-capacity" data-others="${others}" hidden>${others < 2 ? '可用复核方不足，本次将按未复核任务执行。' : others === 2 ? '可进行双重复核，暂无备用裁决方。' : '可进行双重复核与争议裁决。'}</span></div>
    <div class="form-footer"><strong id="deposit-preview">${estimate.upperBound ? '最多预存' : '预存'} ${esc(estimate.deposit ?? '取决于输入')} ${estimate.deposit === null ? '' : 'ETH'}</strong><button class="btn primary" type="submit"${!selected || !estimate.valid || !estimate.sufficient ? ' disabled' : ''}>发布任务</button></div>
    <p class="form-error" id="publish-validation">${!selected ? '当前没有提供此任务的可用机器。' : !estimate.valid ? esc(estimate.error) : !estimate.sufficient ? '余额不足以支付预存。' : ''}</p>${task.code_matches === false ? '<p class="form-error">任务代码与网络版本不一致，提供方会拒绝任务，请先更新。</p>' : ''}<p class="form-error" id="form-error" role="alert" hidden></p></form>`;
}
