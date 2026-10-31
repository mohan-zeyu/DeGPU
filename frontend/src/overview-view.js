const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderOverview(state) {
  const live = state.network?.mode === 'live';
  const wallet = live ? state.unlocked ? state.account : null : state.account;
  const running = (state.jobs || []).filter(job => !job.closed && (live || job.clientId === wallet?.id));
  const serving = state.selfProvider?.serving;
  return `<section class="home-hero" aria-label="平台简介"><h2>让算力自由流动。</h2><p>租用算力完成任务，或提供机器赚取 ETH；使用测试 ETH 网络。</p><div class="home-actions"><a class="btn primary" href="#/providers">租用算力 <span aria-hidden="true">↗</span></a><a class="btn" href="#/supply">提供我的机器</a></div></section><div class="home-services" hidden aria-label="支持的任务"><span>图像分类</span><span>Blender 渲染</span><span>密钥搜索</span></div>${wallet ? `<section class="panel home-current"><div class="panel-head"><h2>当前状态</h2><a class="link" href="#/jobs">查看任务</a></div><div class="home-current-grid"><div><span>钱包余额</span><strong>${esc(Number(wallet.balance || 0).toLocaleString('en-US', { maximumFractionDigits: 6 }))} ETH</strong></div><div><span>运行中的任务</span><strong>${running.length}</strong></div><div><span>机器接单</span><strong>${serving ? '已开启' : '未开启'}</strong></div></div></section>` : '<p class="home-note"><a class="link" href="#/account">连接钱包与网络</a></p>'}${running.length || serving ? '<p class="home-note">任务运行期间请保持本机 DeGPU 服务开启。</p>' : ''}`;
}
