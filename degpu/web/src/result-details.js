import labels from './imagenet-classes.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const resultUrl = value => typeof value === 'string' && (/^\/(?!\/)/.test(value) || /^https?:\/\//i.test(value)) ? esc(value) : '';

function resultStatus(job, result) {
  if (result.found === false || result.available === false) {
    return job.mode === 'checked'
      ? job.closed ? '未找到 · 已退款' : '未找到 · 待结算'
      : '结果缺失或无法解码';
  }
  if (result.mismatched || result.disputed) {
    const outcome = String(job.chainOutcome || job.outcome || '').replace(/_/g, '').toLowerCase();
    const outcomes = {
      mainoutvoted: '原始结果错误 · 提供方被否决',
      verifieroutvoted: '结果有效 · 复核方被否决',
      bothoutvoted: '双方被否决 · 结果存疑',
      nomajority: '未形成多数 · 结果存疑',
    };
    return outcomes[outcome] || (job.closed ? '存在差异 · 已结算' : '存在差异 · 等待裁决');
  }
  if (job.compare === 'similar' && !result.previewUrl && !result.downloadUrl) return '仅有交付记录';
  return job.closed ? result.verified ? '已复核交付' : '已交付' : '待结算';
}

function classificationValue(result) {
  const value = result.value ?? result.labelId ?? result.classId;
  if (value === undefined || value === null) return '—';
  const name = Number.isInteger(value) && labels[value] ? labels[value] : '未知类别';
  return `${esc(name)}（${esc(value)}）`;
}

/** Rows are the current page; status reflects the stored provider output and its actual verdict. */
export function renderResultTable(job, rows) {
  const file = job.resultKind === 'file' || job.compare === 'similar';
  const checked = job.mode === 'checked';
  return `<div class="table-wrap"><table class="results-table result-details-table"><thead><tr><th>${file && rows.every(row => row.frame != null) ? '帧号' : '序号'}</th><th>${file ? '输出文件' : checked ? '密钥' : job.taskType && job.taskType !== 'image-classify-v1' ? '结果' : '分类结果'}</th><th>状态</th>${file ? '<th>查看与下载</th>' : ''}</tr></thead><tbody>${rows.map((result, index) => {
    const preview = resultUrl(result.previewUrl);
    const download = resultUrl(result.downloadUrl);
    const value = file ? esc(result.filename || '未交付') : checked ? esc(result.key ?? result.value ?? '—') : job.taskType && job.taskType !== 'image-classify-v1' ? esc(typeof result.value === 'object' ? JSON.stringify(result.value) : result.value ?? '—') : classificationValue(result);
    const actions = file ? `<td><div class="result-file-actions">${preview ? `<a class="link" href="${preview}" target="_blank" rel="noopener noreferrer">预览</a>` : ''}${download ? `<a class="link" href="${download}" download="${esc(result.filename || 'result.png')}">下载</a>` : ''}${!preview && !download ? '—' : ''}</div></td>` : '';
    return `<tr><td>${esc(result.frame ?? result.index ?? index)}</td><td>${value}</td><td>${esc(resultStatus(job, result))}</td>${actions}</tr>`;
  }).join('')}</tbody></table></div>`;
}
