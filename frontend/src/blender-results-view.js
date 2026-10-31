const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const short = value => value ? `${String(value).slice(0, 10)}…${String(value).slice(-6)}` : '未载入';
const PAGE_SIZE = 8;

function reviewStatus(job, index) {
  const disputed = (job.disputedItems || []).indexOf(index);
  if (disputed >= 0) {
    const verdict = job.verdicts?.[disputed];
    if (Number.isInteger(verdict)) return verdict & 1 ? '裁决接受' : '裁决否决';
    return job.closed ? '争议已结算' : '等待裁决';
  }
  if (job.review?.accepted) return '客户已接受';
  return job.closed ? '已结算' : job.phase === 'TieBreak' ? '未提出争议' : '待验收';
}

/** Delivery metadata never stands in for a downloaded PNG or a pixel comparison. */
export function renderBlenderResults(job, { canReview = false, page = 1, baseHref = '#/jobs' } = {}) {
  const canAccept = canReview && !job.closed && job.phase === 'Disputing';
  const canDispute = canAccept && !job.deadlinePassed;
  const count = Math.max(0, Number.isInteger(job.itemCount) ? job.itemCount : 0);
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const currentPage = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
  const start = (currentPage - 1) * PAGE_SIZE;
  const samples = new Map((job.results || []).map(result => [result.index, result]));
  const rows = Array.from({ length: Math.min(PAGE_SIZE, count - start) }, (_, offset) => {
    const index = start + offset;
    const result = samples.get(index);
    const frame = job.frames?.[index] ?? result?.frame ?? '—';
    const download = typeof result?.downloadUrl === 'string' && result.downloadUrl.startsWith('/api/jobs/')
      ? `<a class="link" href="${esc(result.downloadUrl)}" download>${esc(result.filename || `frame-${frame}.png`)}</a>` : esc(result?.filename || '未载入');
    return `<tr>${canDispute ? `<td><input type="checkbox" name="disputedItems" value="${index}" aria-label="争议项 ${index} · 帧 ${esc(frame)}"></td>` : ''}<td>${index}</td><td>${esc(frame)}</td><td>${download}</td><td class="mono" title="${esc(result?.digest || '')}">${esc(short(result?.digest))}</td><td>${reviewStatus(job, index)}</td></tr>`;
  }).join('');
  const link = target => `${baseHref}${baseHref.includes('?') ? '&' : '?'}resultPage=${target}`;
  const pagination = pages > 1 ? `<nav class="table-pagination" aria-label="渲染记录分页">${currentPage > 1 ? `<a class="btn" href="${esc(link(currentPage - 1))}">上一页</a>` : '<button type="button" class="btn" disabled>上一页</button>'}<span>${currentPage} / ${pages}</span>${currentPage < pages ? `<a class="btn" href="${esc(link(currentPage + 1))}">下一页</a>` : '<button type="button" class="btn" disabled>下一页</button>'}</nav>` : '';
  const boundary = job.resultFilesAvailable !== true ? '<p class="note">尚未取得完整输出文件，当前仅展示交付记录。</p>' : job.review?.compared !== true ? '<p class="note">尚未确认文件相似度比较。</p>' : '';
  const controls = canAccept ? `<div class="form-footer"><div class="row"><button type="button" class="btn primary" data-action="accept-render" data-job="${esc(job.id)}">接受结果并结算</button>${canDispute ? '<button type="submit" class="btn">提交争议 · 0.002 ETH</button>' : '<span class="muted">争议期已结束，仍可接受结果。</span>'}</div></div>${canDispute ? '<details class="supporting-details"><summary>指定其他争议项</summary><label>争议项编号<input name="disputedIndices" placeholder="如 0,2-4；可跨页指定" autocomplete="off"></label><p>按项编号选择；重复帧也有独立的项编号。翻页会清除本页勾选。</p></details><p class="form-error" data-render-error role="alert" hidden></p>' : ''}` : '';
  const table = `<div class="table-wrap"><table class="results-table"><thead><tr>${canDispute ? '<th>争议</th>' : ''}<th>项编号</th><th>帧号</th><th>输出文件</th><th>承诺记录</th><th>验收状态</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const details = '<details class="supporting-details"><summary>验收规则</summary><p>文件 Keccak 用于核对交付完整性；渲染一致性通过同尺寸图像的 8×8 分块比较判断，各块整数 MSE×1000 不超过 65025。此阈值仍待校准。</p><p>接受结果后付款并关闭任务；争议需追加 0.002 ETH 保证金，由裁决方重算争议项并提交判定。承诺记录不代表执行过像素比较。</p></details>';
  const body = table + pagination + controls;
  return `<div class="panel-head"><h3 class="section-title">渲染交付 · ${count} 帧</h3><span class="muted">${esc(job.sceneName || '')}</span></div>${boundary}${canAccept ? `<form id="render-dispute-form" data-job="${esc(job.id)}">${body}</form>` : body}${details}`;
}
