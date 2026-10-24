import { OidcClient, decodeJwt } from './oidc.js';

const cfg = window.SYSTEM_CONFIG;
const oidc = new OidcClient(cfg, { onEvent: () => {} });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
    session: null,
    idClaims: null,
    accessClaims: null,
    roles: [],
    dashboard: null,
    admin: null,
    countdownTimer: null
};

const ICONS = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    admin: '<path d="M12 3l7 2.8v5.1c0 4.4-2.9 7.5-7 9.1-4.1-1.6-7-4.7-7-9.1V5.8L12 3z"/><path d="M9.2 11.9l2 2 3.7-3.9"/>',
    other: '<circle cx="8" cy="15" r="4"/><path d="M11 12l7-7 3 3-2 2-2-2-3 3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>'
};

/* ============================== boot ============================== */

export function boot() {
    applyConfig();
    bindEvents();

    const params = new URLSearchParams(window.location.search);

    if (params.has('error')) {
        const error = params.get('error');
        const description = params.get('error_description') || '';
        cleanAuthParams();
        showLanding();
        toast(`统一登录未完成：${error}${description ? `（${description}）` : ''}`, 'error', 6000);
        return;
    }

    if (params.get('login') === '1') {
        cleanAuthParams();
        startLogin();
        return;
    }

    if (params.has('code')) {
        completeLogin();
        return;
    }

    restoreSession();
}

function applyConfig() {
    const theme = cfg.theme;
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-strong', theme.accentStrong);
    root.style.setProperty('--accent-soft', theme.accentSoft);
    root.style.setProperty('--accent-border', theme.accentBorder);
    root.style.setProperty('--accent-gradient', theme.accentGradient);

    document.body.dataset.system = cfg.systemId;
    document.title = `${cfg.systemFullName} · UniAuth SSO`;

    text('system-mark', cfg.mark);
    text('system-name', cfg.systemName);
    text('system-subtitle', cfg.subtitle);
    text('landing-title', cfg.landingTitle);
    text('landing-highlight', cfg.landingHighlight);
    text('landing-lead', cfg.landingLead);
    text('welcome-system', cfg.systemFullName);
    text('data-title', cfg.dataTitle);
    text('data-sub', cfg.dataSub);
    text('table-title', cfg.tableTitle);
    text('business-scope', cfg.businessScope);
    text('admin-sub', cfg.adminSub);
    text('footer-system', cfg.systemFullName);
    text('footer-issuer', cfg.issuer);

    for (const anchor of [$('#portal-link'), $('#footer-portal')]) {
        if (anchor) anchor.href = cfg.portalUrl;
    }
    const oidcPortal = $('.footer a[href="http://localhost:3000/"]');
    if (oidcPortal) oidcPortal.href = cfg.portalUrl;
}

/* ============================== auth lifecycle ============================== */

async function restoreSession() {
    if (!oidc.getSession()) {
        showLanding();
        return;
    }
    showLoading('正在恢复登录会话…');
    try {
        const session = await oidc.ensureToken();
        setSession(session);
        showDashboard();
        await loadDashboard();
    } catch (error) {
        oidc.clearSession();
        showLanding();
        toast(`会话已失效：${error.message}`, 'error', 6000);
    } finally {
        hideLoading();
    }
}

async function startLogin() {
    try {
        showLoading('正在跳转 Keycloak 统一登录…');
        await oidc.login();
    } catch (error) {
        hideLoading();
        toast(error.message, 'error', 6000);
    }
}

async function completeLogin() {
    showLoading('正在完成统一登录…');
    try {
        const result = await oidc.handleCallback();
        if (!result) {
            cleanAuthParams();
            showLanding();
            return;
        }
        cleanAuthParams();
        setSession(result.session, result.claims);
        showDashboard();
        await loadDashboard();
        toast('登录成功，已通过 Keycloak 身份认证');
    } catch (error) {
        oidc.clearSession();
        showLanding();
        toast(error.message || '登录失败，请重试', 'error', 6500);
    } finally {
        hideLoading();
    }
}

function setSession(session, idClaims) {
    state.session = session;
    try {
        const id = decodeJwt(session.id_token);
        const access = decodeJwt(session.access_token);
        state.idClaims = idClaims || id.payload;
        state.accessClaims = access.payload;
        state.roles = access.payload.realm_access?.roles || [];
        renderNavFromClaims(state.idClaims);
        renderRole(state.roles);
    } catch (error) {
        console.warn('cannot decode tokens', error);
    }
}

function ensureSession() {
    return oidc.ensureToken().then((session) => {
        if (session.access_token !== state.session?.access_token) setSession(session);
        return session;
    });
}

async function refreshSession() {
    const button = $('#refresh-btn');
    if (button) {
        button.disabled = true;
        button.textContent = '刷新中…';
    }
    try {
        const session = await oidc.refresh();
        setSession(session);
        await loadDashboard();
        toast('Access Token 已刷新，有效期已重置');
    } catch (error) {
        toast(error.message, 'error', 6000);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '刷新';
        }
    }
}

async function logout() {
    try {
        await oidc.logout();
    } catch (error) {
        toast(`退出失败：${error.message}`, 'error');
    }
}

/* ============================== data loading ============================== */

async function requestApi(path, retry = true) {
    let session = await ensureSession();
    let response = await fetch(path, {
        headers: {
            Authorization: `Bearer ${session.access_token}`,
            Accept: 'application/json'
        }
    });

    if (response.status === 401 && retry) {
        session = await oidc.refresh();
        setSession(session);
        response = await fetch(path, {
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                Accept: 'application/json'
            }
        });
    }

    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
}

async function loadDashboard() {
    showInlineError('');
    const result = await requestApi(cfg.dashboardPath);

    if (!result.ok) {
        renderRole(state.roles);
        showInlineError(`业务接口返回 ${result.status}：${result.body?.message || '无法读取业务数据'}`);
        renderAdminLocked();
        return;
    }

    state.dashboard = result.body;
    state.roles = result.body.user?.roles || state.roles;
    renderRole(state.roles);
    renderNavFromClaims(state.idClaims);
    renderProfile(result.body.user);
    renderStats(result.body.data?.stats);
    renderTable(result.body.data);
    renderClaims();
    startCountdown();

    if (state.roles.includes('admin')) {
        await loadAdmin(true);
    } else {
        renderAdminLocked();
    }
}

async function loadAdmin(auto = false) {
    const button = $('#admin-btn');
    if (button && !auto) {
        button.disabled = true;
        button.textContent = '调用中…';
    }
    try {
        const result = await requestApi(cfg.adminPath);
        if (result.status === 200) {
            state.admin = result.body;
            renderAdminSuccess(result.body);
        } else if (result.status === 403) {
            renderAdminDenied(result.body);
        } else if (result.status === 401) {
            renderAdminDenied({
                error: 'unauthorized',
                message: 'Access Token 无效或已过期',
                requiredRole: 'admin',
                yourRoles: state.roles
            });
        } else {
            renderAdminDenied({
                error: `HTTP ${result.status}`,
                message: result.body?.message || '管理接口暂时不可用',
                requiredRole: 'admin',
                yourRoles: state.roles
            });
        }
    } catch (error) {
        renderAdminDenied({
            error: 'NETWORK',
            message: error.message,
            requiredRole: 'admin',
            yourRoles: state.roles
        });
    } finally {
        if (button) button.disabled = false;
    }
}

/* ============================== rendering ============================== */

function renderNavFromClaims(claims) {
    if (!claims) return;
    const name = claims.name || claims.preferred_username || '已认证用户';
    const initial = Array.from(name.trim())[0]?.toUpperCase() || 'U';
    text('nav-user-name', claims.preferred_username || name);
    text('nav-avatar', initial);
    text('welcome-name', name.split(' ')[0] || name);
}

function renderRole(roles) {
    const normalized = Array.isArray(roles) ? roles : [];
    const isAdmin = normalized.includes('admin');
    const isUser = normalized.includes('user') || isAdmin;
    const key = isAdmin ? 'admin' : (isUser ? 'user' : 'other');
    const name = isAdmin ? '管理员' : (isUser ? '普通用户' : (normalized[0] || '已认证用户'));
    const code = isAdmin ? 'ADMIN' : (isUser ? 'USER' : 'MEMBER');
    const summary = isAdmin
        ? '你拥有 admin 角色，可以访问业务数据，也可以进入管理接口。'
        : isUser
            ? '你拥有 user 角色，可以访问业务数据；管理接口需要 admin 角色。'
            : '身份已通过 Keycloak 认证，但当前没有 user / admin 业务角色。';

    state.roles = normalized;
    document.body.dataset.role = key;

    const roleCard = $('#role-card');
    roleCard.dataset.role = key;
    $('#role-icon').innerHTML = ICONS[key];
    text('role-name', name);
    text('role-code', code);
    text('role-summary', summary);

    $('#role-chips').innerHTML = normalized.length
        ? normalized.map((role) => `<span class="role-chip ${role === 'admin' ? 'is-admin' : ''}">${escapeHtml(role)}</span>`).join('')
        : '<span class="role-chip">no realm role</span>';

    const pill = $('#role-pill');
    pill.hidden = false;
    pill.dataset.role = isAdmin ? 'admin' : 'user';
    text('role-pill-text', name);

    setPermission('perm-business', isUser, isUser ? '已授权' : '未授权');
    setPermission('perm-admin', isAdmin, isAdmin ? '已授权' : '未授权');
    text('permission-note', isAdmin
        ? 'admin 角色包含业务数据与管理接口权限。管理接口将被自动加载。'
        : '普通用户只能访问业务数据；管理接口会返回 403，这是正常的授权结果。');

    const adminBadge = $('#admin-badge');
    const adminCard = $('#admin-card');
    if (isAdmin) {
        adminBadge.className = 'admin-badge is-granted';
        adminBadge.textContent = '已授权 · admin';
        adminCard.classList.add('is-granted');
        adminCard.classList.remove('is-locked');
        $('#admin-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS.admin}</svg>`;
        text('admin-title', '管理接口已开放');
        text('admin-desc', '当前 token 携带 admin 角色，系统已准备好读取管理数据。');
        if (state.admin) renderAdminSuccess(state.admin);
        else {
            $('#admin-result').innerHTML = '<span class="admin-empty">正在加载管理数据…</span>';
            $('#admin-btn').textContent = '刷新管理数据';
        }
    } else {
        adminBadge.className = 'admin-badge';
        adminBadge.textContent = '需要 admin';
        adminCard.classList.remove('is-granted');
        adminCard.classList.add('is-locked');
        $('#admin-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS.lock}</svg>`;
        text('admin-title', '当前角色无法访问');
        text('admin-desc', `你当前的角色是 ${normalized.join(', ') || '无'}；该接口要求 admin。登录后角色不正确时，服务端会返回 403。`);
        renderAdminLocked();
        $('#admin-btn').textContent = '尝试访问（预期 403）';
    }
}

function setPermission(id, granted, label) {
    const row = $(`#${id}`);
    const stateEl = row.querySelector('.permission-state');
    const iconEl = row.querySelector('.permission-icon');
    row.classList.toggle('is-granted', granted);
    row.classList.toggle('is-locked', !granted);
    stateEl.textContent = label;
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${granted ? ICONS.check : ICONS.lock}</svg>`;
}

function renderProfile(user) {
    if (!user) return;
    const name = user.name || user.username || '未知用户';
    const initial = Array.from(name.trim())[0]?.toUpperCase() || 'U';
    text('profile-avatar', initial);
    text('profile-name', name);
    text('profile-email', user.email || '—');
    text('profile-username', user.username || '—');
    text('profile-dept', user.department || '—');
    text('profile-emp', user.employeeNo || '—');
    text('profile-subject', user.subject || '—');
    $('#profile-subject').title = user.subject || '';
    text('nav-user-name', user.username || name);
    text('nav-avatar', initial);
    text('welcome-name', name.split(' ')[0] || name);
}

function renderStats(stats) {
    const container = $('#stats');
    if (!Array.isArray(stats) || stats.length === 0) {
        container.innerHTML = '<div class="stat"><span class="stat-label">暂无数据</span><strong class="stat-value">—</strong></div>';
        return;
    }
    container.innerHTML = stats.map((stat) => `
        <div class="stat">
            <div class="stat-label">${escapeHtml(stat.label || '')}<span class="stat-trend ${String(stat.trend || '').startsWith('-') ? 'is-down' : ''}">${escapeHtml(stat.trend || '')}</span></div>
            <div class="stat-value">${escapeHtml(stat.value ?? '—')}<small>${escapeHtml(stat.unit || '')}</small></div>
        </div>`).join('');
}

function renderTable(data) {
    if (!data) return;
    const table = $('#data-table');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    const isOrder = cfg.systemId === 'system1';
    const rows = isOrder ? (data.orders || []) : (data.messages || []);

    text('table-count', `共 ${rows.length} 条 · 服务端已验签`);

    if (isOrder) {
        thead.innerHTML = '<tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th></tr>';
        tbody.innerHTML = rows.map((row) => `<tr>
            <td>${escapeHtml(row.orderNo || '—')}</td>
            <td>${escapeHtml(row.customer || '—')}</td>
            <td>${escapeHtml(row.amount || '—')}</td>
            <td><span class="table-status ${row.status === '待发货' ? 'is-wait' : row.status === '已完成' ? 'is-done' : ''}">${escapeHtml(row.status || '—')}</span></td>
        </tr>`).join('');
    } else {
        thead.innerHTML = '<tr><th>来源</th><th>消息主题</th><th>级别</th><th>时间</th></tr>';
        tbody.innerHTML = rows.map((row) => `<tr>
            <td>${escapeHtml(row.from || '—')}</td>
            <td>${escapeHtml(row.subject || '—')}</td>
            <td>${escapeHtml(row.level || '—')}</td>
            <td>${escapeHtml(row.time || '—')}</td>
        </tr>`).join('');
    }
}

function renderAdminSuccess(body) {
    state.admin = body;
    const card = $('#admin-card');
    card.classList.add('is-granted');
    card.classList.remove('is-locked');
    $('#admin-badge').className = 'admin-badge is-granted';
    $('#admin-badge').textContent = '已授权 · admin';
    $('#admin-title').textContent = '管理接口已开放';
    $('#admin-desc').textContent = body.message || 'admin 角色校验通过，管理数据已返回。';
    $('#admin-btn').textContent = '刷新管理数据';

    const records = Array.isArray(body.records) ? body.records : [];
    $('#admin-result').innerHTML = `
        <div class="admin-success-note"><strong>200 OK</strong> · ${escapeHtml(body.message || '管理接口调用成功')} · 角色：${(body.yourRoles || []).map((role) => `<code>${escapeHtml(role)}</code>`).join(' ')}</div>
        <div class="admin-result-table" style="margin-top:9px">
            <table>
                <thead><tr><th>ID</th><th>操作</th><th>操作人</th><th>时间</th></tr></thead>
                <tbody>${records.map((row) => `<tr>
                    <td>${escapeHtml(row.id || '—')}</td>
                    <td>${escapeHtml(row.action || '—')}</td>
                    <td>${escapeHtml(row.operator || row.scope || '—')}</td>
                    <td>${escapeHtml(row.time || '—')}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

function renderAdminDenied(body) {
    state.admin = null;
    const card = $('#admin-card');
    card.classList.remove('is-granted');
    card.classList.add('is-locked');
    $('#admin-badge').className = 'admin-badge';
    $('#admin-badge').textContent = body?.error === 'forbidden' ? '403 Forbidden' : '调用受限';
    $('#admin-title').textContent = body?.error === 'forbidden' ? '403 · 权限不足' : '管理接口暂不可用';
    $('#admin-desc').textContent = body?.message || '当前角色无法访问该接口。';
    $('#admin-btn').textContent = '再次尝试（预期 403）';

    const roles = Array.isArray(body?.yourRoles) ? body.yourRoles : state.roles;
    $('#admin-result').innerHTML = `
        <div class="admin-denied-note">
            <strong>403 Forbidden · ${escapeHtml(body?.message || '权限不足')}</strong>
            你的角色：${roles.length ? roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(' ') : '无'}；
            接口要求：<code>${escapeHtml(body?.requiredRole || 'admin')}</code>。<br>
            这是“认证成功，但授权不足”的正常结果：Token 有效，角色不够。
        </div>`;
}

function renderAdminLocked() {
    state.admin = null;
    const card = $('#admin-card');
    card.classList.add('is-locked');
    card.classList.remove('is-granted');
    $('#admin-badge').className = 'admin-badge';
    $('#admin-badge').textContent = '需要 admin';
    $('#admin-title').textContent = '当前角色无法访问';
    $('#admin-desc').textContent = `你当前的角色是 ${state.roles.join(', ') || '无'}；该接口要求 admin。点击按钮可以验证服务端返回 403。`;
    $('#admin-btn').textContent = '尝试访问（预期 403）';
    $('#admin-result').innerHTML = `<span class="admin-empty">角色为 ${state.roles.length ? state.roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(' ') : '无'}，管理员数据不会返回。</span>`;
}

function renderClaims() {
    const access = state.accessClaims;
    const id = state.idClaims;
    if (!access || !id) return;

    const accessView = {
        iss: access.iss,
        aud: access.aud,
        azp: access.azp,
        sub: access.sub,
        scope: access.scope,
        realm_access: access.realm_access,
        preferred_username: access.preferred_username,
        department: access.department,
        employee_no: access.employee_no,
        exp: access.exp,
        iat: access.iat
    };
    const idView = {
        iss: id.iss,
        aud: id.aud,
        azp: id.azp,
        sub: id.sub,
        nonce: id.nonce,
        name: id.name,
        preferred_username: id.preferred_username,
        email: id.email,
        department: id.department,
        employee_no: id.employee_no,
        exp: id.exp,
        iat: id.iat
    };
    $('#access-claims').textContent = JSON.stringify(accessView, null, 2);
    $('#id-claims').textContent = JSON.stringify(idView, null, 2);
}

function startCountdown() {
    stopCountdown();
    updateCountdown();
    state.countdownTimer = setInterval(updateCountdown, 1000);
}

function stopCountdown() {
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }
}

function updateCountdown() {
    const el = $('#countdown');
    if (!el || !state.session) return;
    const remaining = Math.max(0, Math.floor((state.session.expires_at - Date.now()) / 1000));
    if (remaining <= 0) {
        el.textContent = '已过期';
        el.classList.add('is-low');
        return;
    }
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    el.textContent = `${minutes}:${seconds}`;
    el.classList.toggle('is-low', remaining <= 60);
}

/* ============================== UI states ============================== */

function showLanding() {
    $('#landing').hidden = false;
    $('#dashboard').hidden = true;
    $('#top-login').hidden = false;
    $('#role-pill').hidden = true;
    $('#user-chip').hidden = true;
    document.body.dataset.role = 'guest';
    stopCountdown();
}

function showDashboard() {
    $('#landing').hidden = true;
    $('#dashboard').hidden = false;
    $('#top-login').hidden = true;
    $('#role-pill').hidden = false;
    $('#user-chip').hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function showLoading(message) {
    text('loading-text', message || '正在完成统一登录…');
    $('#loading').hidden = false;
}

function hideLoading() {
    $('#loading').hidden = true;
}

function showInlineError(message) {
    const el = $('#dashboard-error');
    if (!message) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = message;
}

let toastTimer = null;
function toast(message, type = 'success', duration = 3600) {
    const box = $('#toast');
    text('toast-text', message);
    box.hidden = false;
    box.classList.toggle('is-error', type === 'error');
    requestAnimationFrame(() => box.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        box.classList.remove('is-visible');
        setTimeout(() => { box.hidden = true; }, 220);
    }, duration);
}

function cleanAuthParams() {
    const params = new URLSearchParams(window.location.search);
    if (['code', 'state', 'error', 'error_description', 'login'].some((key) => params.has(key))) {
        history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    }
}

function bindEvents() {
    $('#login-btn').addEventListener('click', startLogin);
    $('#top-login').addEventListener('click', startLogin);
    $('#refresh-btn').addEventListener('click', refreshSession);
    $('#admin-btn').addEventListener('click', () => loadAdmin(false));
    $('#userinfo-btn').addEventListener('click', async () => {
        try {
            const info = await oidc.fetchUserInfo();
            toast(`UserInfo 返回：${info.name || info.preferred_username || info.sub}`);
        } catch (error) {
            toast(`UserInfo 调用失败：${error.message}`, 'error', 5000);
        }
    });
    $$('.js-logout').forEach((button) => button.addEventListener('click', logout));
}

/* ============================== helpers ============================== */

function text(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

boot();
