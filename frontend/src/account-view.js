const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/** Connect one account exposed by the existing local execution service. */
export function renderConnectedAuthPage(error = '', values = {}) {
  return `<div class="head auth-head"><h1>连接账户</h1></div><section class="panel auth-panel"><p class="auth-intro">使用账户地址进入 DeGPU。</p><form id="connected-account-form"><div class="fields auth-fields"><label for="account-address">账户地址<input id="account-address" name="address" type="text" class="mono" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="42" maxlength="42" pattern="0[xX][0-9a-fA-F]{40}" placeholder="0x…" value="${esc(values.address || '')}" required${error ? ' aria-describedby="account-connection-error"' : ''}></label></div>${error ? `<p class="form-error" id="account-connection-error" role="alert">${esc(error)}</p>` : ''}<div class="form-footer"><span>本地执行服务账户</span><button type="submit" class="btn primary">连接账户</button></div></form><details class="supporting-details"><summary>连接说明</summary><p>目前仅支持已接入执行服务的账户地址，尚未接入钱包签名认证。</p></details></section>`;
}

/** Render a local account form; the host handles submit with the account service. */
export function renderAuthPage(mode = 'login', error = '', values = {}) {
  const registering = mode === 'register';
  mode = registering ? 'register' : 'login';
  const title = registering ? '注册账号' : '账号登录';
  return `<div class="head auth-head"><h1>${title}</h1></div><section class="panel auth-panel"><form id="auth-form" data-auth-mode="${mode}" data-mode="${mode}"><div class="fields auth-fields"><label for="auth-username">用户名<input id="auth-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,23}" value="${esc(values.username || '')}" required></label>${registering ? `<label for="auth-name">昵称<input id="auth-name" name="name" type="text" autocomplete="nickname" minlength="2" maxlength="24" value="${esc(values.name || '')}" required></label>` : ''}<label for="auth-password">密码<input id="auth-password" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" required${error ? ' aria-describedby="auth-error"' : ''}></label></div>${error ? `<p class="form-error" id="auth-error" role="alert">${esc(error)}</p>` : ''}<div class="form-footer"><a class="link" href="#/${registering ? 'login' : 'register'}">${registering ? '账号登录' : '注册账号'}</a><button type="submit" class="btn primary">${registering ? '注册并登录' : '登录'}</button></div></form></section>`;
}

/** No password fields or credential material are included in account settings. */
export function renderAccountSettings(account, accounts = [], { machineCount = null, connected = false } = {}) {
  if (!account) return '<section class="panel"><div class="panel-head"><h2>我的账户</h2><div class="row"><a class="btn" href="#/login">账号登录</a><a class="btn primary" href="#/register">注册账号</a></div></div></section>';
  const withoutMachine = machineCount === 0;
  return `<section class="panel account-settings"><div class="panel-head"><div><h2>${esc(account.name)}</h2><span class="muted">${connected ? '账户已连接' : `@${esc(account.username)}`}</span></div><div class="row"><a class="link" href="#/supply">${withoutMachine ? '提供我的机器' : '我的机器'}</a>${connected ? '' : '<a class="link" href="#/register">注册账号</a>'}<button type="button" class="btn" data-action="logout">${connected ? '退出账户' : '退出登录'}</button></div></div><div class="account-address"><span>账户地址</span><p class="mono">${esc(account.address)}</p></div></section>`;
}
