import { OidcClient, decodeJwt, mask } from './oidc.js';

const cfg = window.SSO_CONFIG;
const oidc = new OidcClient(cfg, { onEvent: onProtocolEvent });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
    session: null,
    claims: null,
    checks: null,
    userinfo: null,
    lastAuth: null,
    trace: [],
    artifactTab: 'id-token',
    countdownTimer: null,
    autoCallsStarted: false
};

/* ============================== init ============================== */

async function init() {
    bindEvents();
    applySystemLinks();
    hydrateFromStorage();
    renderTrace();
    pingSystems();

    const loggedOut = oidc.consumeLogoutFlag();
    if (loggedOut) {
        toast('已安全退出，Keycloak 会话已结束');
    }

    const params = new URLSearchParams(window.location.search);

    if (params.has('error')) {
        const error = params.get('error');
        const description = params.get('error_description') || '';
        cleanAuthParams();
        renderAnonymous();
        setProtocolBadge('登录被拒绝', 'badge-danger');
        logProtocol({
            category: 'error',
            title: 'Keycloak 拒绝了授权请求',
            method: 'GET',
            url: window.location.pathname,
            status: error,
            note: description || error,
            level: 'error'
        });
        toast(`登录未完成：${error}${description ? `（${description}）` : ''}`, 'error', 6000);
        return;
    }

    if (params.get('login') === '1') {
        cleanAuthParams();
        if (oidc.getSession()) {
            await restoreSession();
        } else {
            try {
                await oidc.login();
            } catch (error) {
                showError(error);
                renderAnonymous();
            }
        }
        return;
    }

    if (params.has('code')) {
        try {
            const result = await oidc.handleCallback();
            if (!result) {
                cleanAuthParams();
                await restoreSession();
                return;
            }
            applySession(result.session, result.claims);
            cleanAuthParams();
            renderAuthenticated();
            setProtocolBadge('已完成授权码流程', 'badge-success');
            toast('登录成功：身份已由 Keycloak 认证');
            void (async () => {
                await loadUserInfo(false);
                await autoAccessSystems();
            })();
        } catch (error) {
            cleanAuthParams();
            oidc.clearSession();
            renderAnonymous();
            showError(error);
        }
        return;
    }

    cleanAuthParams();
    await restoreSession();
}

function hydrateFromStorage() {
    state.lastAuth = oidc.getLastAuthRequest();
    state.userinfo = oidc.getUserInfo();
    try {
        const raw = sessionStorage.getItem(`${cfg.storagePrefix}.trace`);
        state.trace = raw ? JSON.parse(raw) : [];
    } catch {
        state.trace = [];
    }
    if (!Array.isArray(state.trace)) state.trace = [];
}

async function restoreSession() {
    const stored = oidc.getSession();
    if (!stored) {
        renderAnonymous();
        return;
    }
    try {
        const session = await oidc.ensureToken();
        applySession(session);
        state.checks = defaultChecks(state.claims, session);
        renderAuthenticated();
        setProtocolBadge('会话已恢复', 'badge-success');
        if (session.access_token !== stored.access_token) {
            toast('页面会话已恢复，Access Token 已自动刷新');
        }
    } catch (error) {
        oidc.clearSession();
        state.session = null;
        state.claims = null;
        renderAnonymous();
        toast(`会话已失效：${error.message}`, 'error', 6000);
    }
}

function applySession(session, claims) {
    state.session = session;
    state.claims = claims || decodeJwt(session.id_token).payload;
    state.lastAuth = oidc.getLastAuthRequest();
    state.userinfo = oidc.getUserInfo();
}

/* ============================== events ============================== */

function bindEvents() {
    $('#btn-login')?.addEventListener('click', startLogin);
    $('#btn-logout')?.addEventListener('click', handleLogout);
    $('#chip-logout')?.addEventListener('click', handleLogout);
    $('#btn-refresh')?.addEventListener('click', manualRefresh);
    $('#btn-userinfo')?.addEventListener('click', manualUserInfo);
    $('#btn-clear-log')?.addEventListener('click', () => {
        state.trace = [];
        sessionStorage.removeItem(`${cfg.storagePrefix}.trace`);
        renderTrace();
        toast('协议日志已清空');
    });
    $('#btn-sso-tab')?.addEventListener('click', () => {
        window.open(`${window.location.origin}${window.location.pathname}?login=1`, '_blank', 'noopener');
    });

    $$('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            state.artifactTab = tab.dataset.tab;
            $$('.tab').forEach((item) => item.classList.toggle('is-active', item === tab));
            renderArtifact();
        });
    });

    document.querySelectorAll('.system-card').forEach((card) => {
        card.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            callSystem(card.dataset.systemId, button.dataset.action);
        });
    });
}

async function startLogin() {
    try {
        setProtocolBadge('正在跳转 Keycloak…', 'badge-muted');
        await oidc.login();
    } catch (error) {
        showError(error);
        renderAnonymous();
    }
}

async function handleLogout() {
    try {
        await oidc.logout();
    } catch (error) {
        toast(`退出登录失败：${error.message}`, 'error');
    }
}

async function manualRefresh() {
    try {
        const session = await oidc.refresh();
        applySession(session);
        state.checks = defaultChecks(state.claims, session);
        renderSessionUi();
        renderAuthenticated();
        toast('Access Token 已刷新，有效期已重置');
    } catch (error) {
        toast(error.message, 'error', 5000);
    }
}

async function manualUserInfo() {
    try {
        await loadUserInfo(true);
    } catch {
        // loadUserInfo 已经提示错误
    }
}

async function loadUserInfo(showSuccessToast) {
    try {
        const info = await oidc.fetchUserInfo();
        state.userinfo = info;
        if (state.artifactTab === 'userinfo') renderArtifact();
        if (showSuccessToast) toast('UserInfo 调用成功，返回了最新身份信息');
    } catch (error) {
        toast(`UserInfo 调用失败：${error.message}`, 'error', 5000);
    }
}

async function autoAccessSystems() {
    if (state.autoCallsStarted) return;
    state.autoCallsStarted = true;
    for (const system of cfg.systems) {
        await callSystem(system.id, 'dashboard');
    }
    markStep(6, true);
}

/* ============================== system calls ============================== */

async function callSystem(systemId, kind) {
    const system = cfg.systems.find((item) => item.id === systemId);
    if (!system) return;

    const card = document.querySelector(`[data-system-id="${systemId}"]`);
    const result = $('[data-role="result"]', card);
    const path = kind === 'admin' ? system.adminPath : system.dashboardPath;
    const label = kind === 'admin' ? '管理员接口' : '业务接口';

    result.innerHTML = `<div class="result-loading"><span class="spinner"></span>正在携带 Bearer Token 调用 <code>${escapeHtml(path)}</code>…</div>`;
    const started = performance.now();

    try {
        const session = await ensureFreshSession();
        const response = await fetch(system.baseUrl + path, {
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                Accept: 'application/json'
            }
        });
        const durationMs = Math.round(performance.now() - started);
        const body = await response.json().catch(() => null);

        logProtocol({
            category: 'api',
            title: `${system.shortName} · ${label}`,
            method: 'GET',
            url: system.baseUrl + path,
            status: response.status,
            durationMs,
            request: {
                Authorization: `Bearer ${mask(session.access_token, 24)}`,
                Accept: 'application/json'
            },
            response: body,
            note: response.ok
                ? '访问令牌已被资源服务器校验；响应中的 securityChecks 是后端实际执行的校验项。'
                : '资源服务器拒绝了该请求，响应体说明了原因。',
            level: response.ok ? 'info' : (response.status === 403 ? 'warn' : 'error')
        });

        renderSystemResult(card, system, kind, response.status, body, durationMs);

        if (response.status === 403) {
            toast(`${system.shortName} 返回 403：当前账号缺少 admin 角色`, 'error', 5200);
        } else if (response.status === 401) {
            toast('Access Token 无效或已过期，请点击「刷新令牌」后重试', 'error', 5200);
        }
    } catch (error) {
        result.innerHTML = `
            <div class="result-error">
                <strong>请求失败</strong><br>
                ${escapeHtml(error.message)}<br>
                <span style="opacity:.8">请确认 ${escapeHtml(system.shortName)} 后端已在 ${escapeHtml(system.baseUrl)} 启动，并允许 ${escapeHtml(window.location.origin)} 跨域访问。</span>
            </div>`;
        logProtocol({
            category: 'error',
            title: `${system.shortName} 请求未完成`,
            method: 'GET',
            url: system.baseUrl + path,
            status: 'NETWORK ERROR',
            note: error.message,
            level: 'error'
        });
    }
}

async function ensureFreshSession() {
    const before = state.session?.access_token;
    const session = await oidc.ensureToken();
    if (before && session.access_token !== before) {
        applySession(session);
        state.checks = defaultChecks(state.claims, session);
        renderSessionUi();
    }
    return session;
}

function renderSystemResult(card, system, kind, status, body, durationMs) {
    const result = $('[data-role="result"]', card);
    const statusBadge = status >= 200 && status < 300
        ? '<span class="badge badge-success">200 OK</span>'
        : `<span class="badge ${status === 403 ? 'badge-warn' : 'badge-danger'}">${status} ${status === 403 ? 'Forbidden' : 'Error'}</span>`;

    if (!body) {
        result.innerHTML = `<div class="result-error"><strong>${statusBadge}</strong> 服务端返回了空响应体。</div>`;
        return;
    }

    if (status === 401) {
        result.innerHTML = `
            <div class="result-error">
                <strong>401 Unauthorized</strong><br>
                ${escapeHtml(body.message || 'Access Token 无效')}<br>
                <span style="opacity:.8">提示：点击上方「刷新令牌」，或用 bob / bob123 重新登录。</span>
            </div>`;
        return;
    }

    if (status === 403) {
        const roles = Array.isArray(body.yourRoles) ? body.yourRoles : [];
        result.innerHTML = `
            <div class="result-head">${statusBadge}<span class="result-title">认证通过，但授权不足</span><span class="result-time">${durationMs} ms</span></div>
            <div class="result-warn">
                <strong>403 Forbidden</strong> · ${escapeHtml(body.message || '缺少所需角色')}<br>
                你的角色：${roles.length ? roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(' ') : '无'}；
                接口要求：<code>${escapeHtml(body.requiredRole || 'admin')}</code>。<br>
                这是「认证 ≠ 授权」的直接体现：Token 有效，但角色不足。请用 <code>bob / bob123</code> 重新登录后重试。
            </div>`;
        return;
    }

    if (status < 200 || status >= 300) {
        result.innerHTML = `
            <div class="result-head">${statusBadge}<span class="result-title">调用失败</span></div>
            <div class="result-error">${escapeHtml(body.message || JSON.stringify(body))}</div>`;
        return;
    }

    if (kind === 'admin') {
        const records = Array.isArray(body.records) ? body.records : [];
        result.innerHTML = `
            <div class="result-head">${statusBadge}<span class="result-title">管理员接口调用成功</span><span class="result-time">${durationMs} ms</span></div>
            <div class="verified-box">
                <strong>admin 角色校验通过</strong><br>
                ${escapeHtml(body.message || '')} · 角色：${(body.yourRoles || []).map((role) => `<code>${escapeHtml(role)}</code>`).join(' ')}
            </div>
            ${table(['ID', '操作', '操作人', '时间'], records.map((row) => [row.id, row.action, row.operator || row.scope || '—', row.time || '—']))}`;
        return;
    }

    const data = body.data || {};
    const user = body.user || {};
    const stats = Array.isArray(data.stats) ? data.stats : [];
    const security = body.securityChecks || {};

    result.innerHTML = `
        <div class="result-head">${statusBadge}<span class="result-title">服务端已验签</span><span class="result-time">${durationMs} ms</span></div>
        <div class="verified-box">
            <strong>${escapeHtml(body.systemName || system.name)}</strong> 接受该 Access Token<br>
            aud 包含 <code>${escapeHtml(system.id)}</code> · 用户 <strong>${escapeHtml(user.username || '—')}</strong>
            · 角色 ${(user.roles || []).map((role) => `<code>${escapeHtml(role)}</code>`).join(' ') || '—'}<br>
            <span class="mono">${escapeHtml(security.signature || 'RS256 / JWKS 校验通过')}</span>
        </div>
        ${stats.length ? `<div class="stat-row">${stats.map((stat) => `
            <div class="stat">
                <span>${escapeHtml(stat.label)}</span>
                <strong>${escapeHtml(stat.value)}<small>${escapeHtml(stat.unit || '')}</small></strong>
            </div>`).join('')}</div>` : ''}
        ${system.id === 'system1'
            ? table(['订单号', '客户', '金额', '状态'], (data.orders || []).map((row) => [row.orderNo, row.customer, row.amount, row.status]))
            : table(['来源', '消息', '级别', '时间'], (data.messages || []).map((row) => [row.from, row.subject, row.level, row.time]))}
        <div class="artifact-note" style="margin-top:8px">
            iss ✓ · aud ✓ · exp ✓ · 服务端时间 ${formatTime(new Date(body.serverTime || Date.now()).getTime())}
        </div>`;
}

function table(headers, rows) {
    return `<table class="mini-table">
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

/* ============================== render ============================== */

function renderAuthenticated() {
    $('#landing').hidden = true;
    $('#dashboard').hidden = false;
    $('#auth-chip').hidden = false;

    if (state.session && state.claims) {
        renderIdentity();
        renderSessionUi();
        startCountdown();
        setStepperCompleted();
        setProtocolBadge('已完成授权码流程', 'badge-success');
        renderArtifact();
        document.title = `${state.claims.name || state.claims.preferred_username || '已登录'} · UniAuth OIDC 演示`;
    }
    renderTrace();
}

function renderAnonymous() {
    $('#landing').hidden = false;
    $('#dashboard').hidden = true;
    $('#auth-chip').hidden = true;
    stopCountdown();
    resetStepper();
    setProtocolBadge('等待登录', 'badge-muted');
    renderArtifact();
    document.title = 'UniAuth · Keycloak OIDC 统一身份认证演示';
}

function renderIdentity() {
    const claims = state.claims;
    if (!claims) return;

    const displayName = claims.name || claims.preferred_username || '未知用户';
    const initial = Array.from(displayName.trim())[0]?.toUpperCase() || 'U';
    $('#user-name').textContent = displayName;
    $('#user-username').textContent = claims.preferred_username || '—';
    $('#user-email').textContent = claims.email || '—';
    $('#user-department').textContent = claims.department || '—';
    $('#user-employee').textContent = claims.employee_no || '—';
    $('#avatar').textContent = initial;
    $('#chip-avatar').textContent = initial;
    $('#chip-name').textContent = claims.preferred_username || displayName;

    // 角色属于“授权”信息，按 OIDC / OAuth2 最佳实践放在 Access Token 中。
    // ID Token 主要证明“你是谁”，因此这里从 Access Token 读取 realm_access.roles。
    const roles = rolesFromAccessToken();
    $('#user-roles').innerHTML = roleChips(roles);

    const isAdmin = roles.includes('admin');
    const successRole = $('#success-role');
    if (successRole) {
        successRole.dataset.role = isAdmin ? 'admin' : (roles.length ? 'user' : 'other');
        $('#success-role-name').textContent = isAdmin ? '管理员' : (roles.includes('user') ? '普通用户' : '已认证用户');
    }
    $('#user-issuer').textContent = claims.iss || '—';
    $('#user-subject').textContent = claims.sub || '—';
    $('#user-subject').title = claims.sub || '';
    $('#user-audience').textContent = Array.isArray(claims.aud) ? claims.aud.join(', ') : (claims.aud || '—');
    $('#token-source').textContent = 'OIDC · code + PKCE';
}

function renderSessionUi() {
    renderIdentity();
    const session = state.session;
    if (!session) return;
    const refreshState = $('#refresh-state');
    if (session.refresh_token) {
        refreshState.textContent = '可用';
        refreshState.className = 'badge badge-success';
    } else {
        refreshState.textContent = '未签发';
        refreshState.className = 'badge badge-muted';
    }
    if (state.claims) {
        $('#user-issuer').textContent = state.claims.iss || '—';
        $('#user-audience').textContent = Array.isArray(state.claims.aud) ? state.claims.aud.join(', ') : (state.claims.aud || '—');
    }
    updateCountdown();
}

function rolesFromAccessToken() {
    try {
        if (!state.session?.access_token) return [];
        const payload = decodeJwt(state.session.access_token).payload;
        return payload.realm_access?.roles || [];
    } catch {
        return [];
    }
}

function roleChips(roles) {
    if (!Array.isArray(roles) || roles.length === 0) return '<span style="color:var(--muted-2)">无</span>';
    return roles.map((role) => `<span class="role-chip ${role === 'admin' ? 'is-admin' : ''}">${escapeHtml(role)}</span>`).join('');
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
    const el = $('#session-time');
    if (!el || !state.session) return;
    const remaining = Math.max(0, Math.floor((state.session.expires_at - Date.now()) / 1000));
    if (remaining <= 0) {
        el.textContent = '已过期';
        el.classList.add('is-expired');
        el.classList.remove('is-low');
        return;
    }
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    el.textContent = `${minutes}:${seconds}`;
    el.classList.toggle('is-low', remaining <= 60);
    el.classList.remove('is-expired');
}

function setStepperCompleted() {
    $$('#stepper li').forEach((item) => { item.dataset.state = 'done'; });
}

function resetStepper() {
    $$('#stepper li').forEach((item) => { item.dataset.state = 'pending'; });
}

function markStep(index, done = true) {
    const item = $(`#stepper li[data-step="${index}"]`);
    if (item) item.dataset.state = done ? 'done' : 'pending';
}

function setProtocolBadge(text, className) {
    const badge = $('#protocol-status');
    if (!badge) return;
    badge.textContent = text;
    badge.className = `badge ${className}`;
}

/* ============================== protocol trace ============================== */

function logProtocol(event) {
    onProtocolEvent(event);
}

function onProtocolEvent(event) {
    const entry = { ...event, at: Date.now() };
    state.trace.push(entry);
    if (state.trace.length > 80) state.trace = state.trace.slice(-80);
    if (event.checks) state.checks = event.checks;

    if (event.category === 'authorize') markStep(1, true);
    if (event.category === 'callback') {
        markStep(2, true);
        markStep(3, true);
    }
    if (event.category === 'token') markStep(4, true);
    if (event.category === 'validate') markStep(5, true);
    if (event.category === 'userinfo' || event.category === 'api') markStep(6, true);
    if (event.category === 'error') setProtocolBadge('出现错误', 'badge-danger');

    persistTrace();
    renderTrace();
}

function persistTrace() {
    try {
        sessionStorage.setItem(`${cfg.storagePrefix}.trace`, JSON.stringify(state.trace));
    } catch {
        // 忽略存储配额问题
    }
}

function renderTrace() {
    const list = $('#trace');
    const counter = $('#trace-count');
    if (!list) return;
    if (counter) counter.textContent = `${state.trace.length} 条`;

    if (state.trace.length === 0) {
        list.innerHTML = `
            <li class="trace-empty">
                <span class="trace-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>
                </span>
                登录后，这里会记录每一次 OIDC / API 请求
            </li>`;
        return;
    }

    list.innerHTML = state.trace.map(renderTraceItem).join('');
    // 保持从头阅读的时序；用户可自行向下滚动查看最新的 API 调用。
}

function renderTraceItem(event) {
    const level = event.level === 'error' ? 'is-error' : event.level === 'warn' ? 'is-warn' : ['discovery', 'authorize', 'callback'].includes(event.category) ? 'is-info' : '';
    const methodClass = event.category === 'api' ? 'is-api' : event.method === 'POST' ? 'is-post' : '';
    const statusClass = event.level === 'error' ? 'is-error' : event.level === 'warn' ? 'is-warn' : '';
    const details = {};
    if (event.request) details.request = event.request;
    if (event.response) details.response = event.response;
    if (event.checks) details.checks = event.checks;
    if (event.note) details.note = event.note;

    return `
        <li class="trace-item">
            <div class="trace-rail"><span class="trace-dot ${level}"></span></div>
            <div>
                <div class="trace-top">
                    <span class="trace-method ${methodClass}">${escapeHtml(event.method || '—')}</span>
                    <span class="trace-title">${escapeHtml(event.title || '')}</span>
                    <span class="trace-status ${statusClass}">${escapeHtml(formatStatus(event.status))}${event.durationMs != null ? ` · ${event.durationMs}ms` : ''}</span>
                    <span class="trace-time">${formatTime(event.at)}</span>
                </div>
                <div class="trace-url" title="${escapeHtml(event.url || '')}">${escapeHtml(event.url || '')}</div>
                ${Object.keys(details).length ? `<details class="trace-details"><summary>查看请求 / 响应</summary><pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre></details>` : ''}
            </div>
        </li>`;
}

/* ============================== artifact panel ============================== */

function renderArtifact() {
    const container = $('#artifact-body');
    if (!container) return;

    if (!state.session) {
        container.innerHTML = `
            <div class="artifact-placeholder">
                <div class="placeholder-glyph">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg>
                </div>
                <p>完成登录后，查看 ID Token、Access Token 的完整 JWT 内容。</p>
            </div>`;
        return;
    }

    if (state.artifactTab === 'access-token') {
        container.innerHTML = renderJwtPanel(state.session.access_token, 'Access Token', '资源服务器（系统 1 / 2）使用该 Token 访问受保护 API。后端用 JWKS 公钥验签并校验 aud。');
        return;
    }
    if (state.artifactTab === 'userinfo') {
        if (!state.userinfo) {
            container.innerHTML = `
                <div class="artifact-placeholder">
                    <div class="placeholder-glyph">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>
                    </div>
                    <p>尚未调用 UserInfo。点击页面上的「调用 UserInfo」按钮，使用 Bearer Token 获取用户信息。</p>
                </div>`;
            return;
        }
        container.innerHTML = `
            <div class="artifact-section">
                <div class="artifact-label">UserInfo Response</div>
                ${jsonBlock(state.userinfo)}
            </div>
            <p class="artifact-note">UserInfo 端点的响应由 Access Token 授权，是 OIDC 标准中获取用户声明的另一种方式。</p>`;
        return;
    }
    if (state.artifactTab === 'auth-request') {
        container.innerHTML = renderAuthRequest();
        return;
    }
    container.innerHTML = renderJwtPanel(state.session.id_token, 'ID Token', 'ID Token 由 Keycloak 签名，登录门户校验 iss / aud / exp / nonce 后，才会认为“登录成功”。');
}

function renderJwtPanel(token, title, description) {
    let decoded;
    try {
        decoded = decodeJwt(token);
    } catch (error) {
        return `<div class="result-error">JWT 解析失败：${escapeHtml(error.message)}</div>`;
    }
    const checks = state.checks && state.checks.length ? state.checks : defaultChecks(decoded.payload, state.session);
    return `
        <div class="artifact-section">
            <div class="artifact-label">${escapeHtml(title)} · HEADER</div>
            ${jsonBlock(decoded.header)}
        </div>
        <div class="artifact-section">
            <div class="artifact-label">${escapeHtml(title)} · PAYLOAD</div>
            ${jsonBlock(decoded.payload)}
        </div>
        <div class="artifact-section">
            <div class="artifact-label">${title === 'ID Token' ? '声明校验结果' : '令牌用途'}</div>
            ${title === 'ID Token' ? `
                <ul class="checks">
                    ${checks.map((check) => `<li>
                        <span class="check-icon">${check.ok
                            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
                            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'}</span>
                        <span><strong>${escapeHtml(check.name)}</strong> · ${escapeHtml(String(check.detail || ''))}</span>
                    </li>`).join('')}
                </ul>` : `
                <ul class="checks">
                    <li><span class="check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span><span><strong>Bearer Token</strong> · 两个系统分别校验自己的 audience</span></li>
                    <li><span class="check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span><span><strong>无状态</strong> · 后端不保存 Session，只看 JWT 与 JWKS</span></li>
                </ul>`}
        </div>
        <p class="artifact-note">${escapeHtml(description)}</p>`;
}

function renderAuthRequest() {
    const auth = state.lastAuth;
    if (!auth?.params) {
        return `
            <div class="artifact-placeholder">
                <div class="placeholder-glyph">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7l1-1"/></svg>
                </div>
                <p>授权请求记录不在当前标签页中。重新登录后即可查看完整的 Authorization Request。</p>
            </div>`;
    }
    const order = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
    const params = auth.params;
    const rows = order
        .filter((key) => params[key] !== undefined)
        .map((key) => `<div class="param-row"><dt>${escapeHtml(key)}</dt><dd class="${['state', 'nonce', 'code_challenge'].includes(key) ? 'is-em' : ''}">${escapeHtml(params[key])}</dd></div>`)
        .join('');

    return `
        <div class="artifact-section">
            <div class="artifact-label">Authorization Request URL</div>
            <pre class="code-block">${escapeHtml(auth.url)}</pre>
        </div>
        <div class="artifact-section">
            <div class="artifact-label">Query Parameters</div>
            <dl class="param-list">${rows}</dl>
        </div>
        <p class="artifact-note">
            <strong>state</strong> 用于防 CSRF；<strong>nonce</strong> 会写入 ID Token 并由登录门户比对；
            <strong>code_challenge</strong> 是 code_verifier 的 SHA-256 摘要，授权码兑换时必须回传原始 verifier（PKCE）。
        </p>`;
}

function defaultChecks(claims, session) {
    if (!claims) return [];
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    const checks = [
        { name: 'iss 签发者一致', ok: claims.iss === cfg.issuer, detail: claims.iss },
        { name: 'aud 包含本客户端', ok: audience.includes(cfg.clientId), detail: audience.join(', ') },
        { name: 'exp 未过期', ok: Number(claims.exp) > now - 60, detail: new Date(claims.exp * 1000).toLocaleString('zh-CN') },
        { name: 'sub 存在', ok: Boolean(claims.sub), detail: claims.sub }
    ];
    if (claims.nonce) checks.push({ name: 'nonce 已参与校验', ok: true, detail: '首次登录时与授权请求比对' });
    return checks;
}

/* ============================== helpers ============================== */

function applySystemLinks() {
    for (const link of $$('[data-open-ui]')) {
        const system = cfg.systems.find((item) => item.id === link.dataset.openUi);
        if (system?.uiUrl) {
            link.href = system.uiUrl;
            link.title = `在新标签页打开${system.name}页面`;
        }
    }
}

function pingSystems() {
    for (const system of cfg.systems) {
        fetch(`${system.baseUrl}/api/public/info`, { headers: { Accept: 'application/json' } })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(() => setSystemStatus(system.id, true))
            .catch(() => setSystemStatus(system.id, false));
    }
}

function setSystemStatus(systemId, online) {
    const pill = $(`[data-system-id="${systemId}"] [data-role="status"]`);
    if (!pill) return;
    pill.className = `status-pill ${online ? 'is-online' : 'is-offline'}`;
    pill.innerHTML = `<i></i>${online ? '在线' : '离线'}`;
    pill.title = online ? '公开探活接口 /api/public/info 调用成功' : '无法连接后端，请确认已启动';
}

function setProtocolStatusFromTrace() {
    const hasError = state.trace.some((event) => event.level === 'error');
    if (hasError) setProtocolBadge('出现错误', 'badge-danger');
}

function cleanAuthParams() {
    const params = new URLSearchParams(window.location.search);
    const authKeys = ['code', 'state', 'error', 'error_description', 'login'];
    if (authKeys.some((key) => params.has(key))) {
        history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    }
}

let toastTimer = null;
function toast(message, type = 'success', duration = 3600) {
    const box = $('#toast');
    const text = $('#toast-message');
    if (!box || !text) return;
    text.textContent = message;
    box.hidden = false;
    box.classList.toggle('is-error', type === 'error');
    requestAnimationFrame(() => box.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        box.classList.remove('is-visible');
        setTimeout(() => { box.hidden = true; }, 220);
    }, duration);
}

function formatStatus(status) {
    if (status == null) return '—';
    if (typeof status === 'string') return status;
    const labels = { 200: 'OK', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Server Error' };
    return `${status} ${labels[status] || ''}`.trim();
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function jsonBlock(value) {
    return `<pre class="code-block">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
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

init().catch((error) => {
    console.error(error);
    renderAnonymous();
    showError(error);
});

function showError(error) {
    const message = error?.message || String(error);
    toast(message, 'error', 6500);
    setProtocolBadge('认证流程异常', 'badge-danger');
    if (!state.trace.some((event) => event.level === 'error' && event.note === message)) {
        logProtocol({
            category: 'error',
            title: '认证流程异常',
            method: '—',
            url: window.location.pathname,
            status: 'ERROR',
            note: message,
            level: 'error'
        });
    }
}
