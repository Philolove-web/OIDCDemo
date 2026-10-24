#!/usr/bin/env node
/**
 * 端到端冒烟测试：不依赖浏览器，用 Node 直接走完 Keycloak 的 OIDC 授权码流程。
 *
 * 它会验证：
 *   1. Discovery 文档
 *   2. Authorization Code + PKCE 登录（真实提交 Keycloak 登录表单）
 *   3. ID Token / Access Token 的 iss、aud、nonce、角色与自定义 claim
 *   4. UserInfo 端点
 *   5. 系统 1 / 系统 2 的资源接口（含 CORS 预检）
 *   6. 普通用户访问 admin 接口返回 403；管理员访问返回 200
 *   7. refresh_token 刷新
 *   8. 同一 Keycloak 会话下的 SSO 免登录
 *   9. RP-Initiated Logout
 *
 * 适用环境：keycloak、system1、system2、frontend 均已启动。
 * 运行：node scripts/smoke-test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const KC = (process.env.KEYCLOAK_URL || 'http://localhost:8080').replace(/\/$/, '');
const REALM = process.env.KEYCLOAK_REALM || 'sso-demo';
const ISSUER = `${KC}/realms/${REALM}`;
const PORTAL = (process.env.PORTAL_URL || 'http://localhost:3000').replace(/\/$/, '');
const SYSTEM1 = (process.env.SYSTEM1_URL || 'http://localhost:8081').replace(/\/$/, '');
const SYSTEM2 = (process.env.SYSTEM2_URL || 'http://localhost:8082').replace(/\/$/, '');
const CLIENT_ID = 'sso-portal';
const REDIRECT_URI = `${PORTAL}/`;
const SCOPE = 'openid profile email';

const ALICE = { username: process.env.ALICE_USERNAME || 'alice', password: process.env.ALICE_PASSWORD || 'alice123' };
const BOB = { username: process.env.BOB_USERNAME || 'bob', password: process.env.BOB_PASSWORD || 'bob123' };

const results = [];
let failed = 0;

async function step(name, fn) {
    try {
        const detail = await fn();
        results.push({ name, ok: true, detail });
        console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — \x1b[2m${detail}\x1b[0m` : ''}`);
        return detail;
    } catch (error) {
        failed += 1;
        results.push({ name, ok: false, error });
        console.log(`  \x1b[31m✗\x1b[0m ${name} — ${error.message}`);
        throw error;
    }
}

/* ----------------------------- cookie jar ----------------------------- */

class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    header() {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    store(response) {
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean);
        for (const cookie of setCookies) {
            const [pair] = cookie.split(';');
            const index = pair.indexOf('=');
            if (index <= 0) continue;
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            if (!value || /max-age=0/i.test(cookie)) {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
    }
}

async function request(url, options = {}, jar = null) {
    const headers = new Headers(options.headers || {});
    if (jar && jar.header()) headers.set('Cookie', jar.header());
    const response = await fetch(url, { ...options, headers, redirect: 'manual' });
    if (jar) jar.store(response);
    return response;
}

/* ----------------------------- oidc helpers ----------------------------- */

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwt(token) {
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT 应为三段');
    return {
        header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
        payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    };
}

function decodeEntities(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
}

function parseLoginForm(html) {
    const formTag = html.match(/<form[^>]*id="kc-form-login"[^>]*>/i);
    if (!formTag) throw new Error('未找到 Keycloak 登录表单（id=kc-form-login）');
    const actionRaw = formTag[0].match(/action="([^"]+)"/i)?.[1];
    if (!actionRaw) throw new Error('登录表单缺少 action 属性');

    const formBody = html.slice(html.indexOf(formTag[0]) + formTag[0].length).split('</form>')[0];
    const fields = new URLSearchParams();
    for (const input of formBody.matchAll(/<input\b[^>]*>/gi)) {
        const name = input[0].match(/name="([^"]*)"/i)?.[1];
        if (!name) continue;
        const value = input[0].match(/value="([^"]*)"/i)?.[1] || '';
        fields.set(name, decodeEntities(value));
    }
    return { action: decodeEntities(actionRaw), fields };
}

function parseAuthResponse(location, expectedState) {
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, `${PORTAL}/`, `回调地址不是门户：${location}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    assert.ok(code, '回调 URL 缺少 code');
    assert.equal(state, expectedState, 'state 校验失败');
    return code;
}

async function login({ username, password }, jar = new CookieJar()) {
    const discovery = await getDiscovery();
    const state = base64Url(crypto.randomBytes(24));
    const nonce = base64Url(crypto.randomBytes(24));
    const codeVerifier = base64Url(crypto.randomBytes(48));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());

    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    }).toString();

    // 1) 打开授权端点，跟随时会先落到 Keycloak 登录页
    let currentUrl = authorizeUrl.toString();
    let response;
    let html = '';
    for (let i = 0; i < 6; i += 1) {
        response = await request(currentUrl, { headers: { Accept: 'text/html' } }, jar);
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            assert.ok(location, '重定向缺少 Location');
            currentUrl = new URL(location, currentUrl).toString();
            if (currentUrl.startsWith(`${PORTAL}/`)) {
                const code = parseAuthResponse(currentUrl, state);
                return exchangeCode(discovery, code, codeVerifier, nonce, jar);
            }
            continue;
        }
        html = await response.text();
        break;
    }
    assert.equal(response.status, 200, `打开登录页失败：HTTP ${response.status}`);

    const form = parseLoginForm(html);
    const body = new URLSearchParams(form.fields);
    body.set('username', username);
    body.set('password', password);

    // 2) 提交用户名密码
    let postResponse = await request(form.action, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html',
            Referer: currentUrl
        },
        body: body.toString()
    }, jar);

    // 3) 跟随 Keycloak 的 302，直到回调到门户
    for (let i = 0; i < 6; i += 1) {
        if (postResponse.status >= 300 && postResponse.status < 400) {
            const location = postResponse.headers.get('location');
            assert.ok(location, '登录 POST 重定向缺少 Location');
            const next = new URL(location, form.action).toString();
            if (next.startsWith(`${PORTAL}/`)) {
                const code = parseAuthResponse(next, state);
                return exchangeCode(discovery, code, codeVerifier, nonce, jar);
            }
            postResponse = await request(next, { headers: { Accept: 'text/html' } }, jar);
            continue;
        }
        const page = await postResponse.text();
        const errorText = page.match(/id="kc-feedback-text"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
            || page.match(/class="pf-c-alert__title"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
            || '登录失败（未解析到错误文本）';
        throw new Error(`用户 ${username} 登录失败：${errorText.replace(/<[^>]+>/g, '').trim()}`);
    }
    throw new Error(`用户 ${username} 登录后未获得授权码`);
}

async function exchangeCode(discovery, code, codeVerifier, nonce, jar) {
    const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Origin: PORTAL
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier
        })
    });
    const tokens = await response.json().catch(() => null);
    assert.equal(response.status, 200, `换取令牌失败：${JSON.stringify(tokens)}`);
    assert.ok(tokens.access_token && tokens.id_token, '令牌响应缺少 access_token / id_token');

    const idToken = decodeJwt(tokens.id_token);
    const accessToken = decodeJwt(tokens.access_token);
    assert.equal(idToken.payload.iss, ISSUER, 'ID Token iss 不匹配');
    assert.equal(idToken.payload.nonce, nonce, 'ID Token nonce 不匹配');
    assert.ok(idToken.payload.aud.includes(CLIENT_ID), 'ID Token aud 缺少 sso-portal');
    assert.ok(idToken.payload.exp * 1000 > Date.now(), 'ID Token 已过期');
    assert.ok(accessToken.payload.aud.includes('system1'), 'Access Token aud 缺少 system1');
    assert.ok(accessToken.payload.aud.includes('system2'), 'Access Token aud 缺少 system2');

    const cors = response.headers.get('access-control-allow-origin');
    if (cors !== null) assert.ok(cors === PORTAL || cors === '*', `Token 端点 CORS 不允许门户：${cors}`);

    return { discovery, tokens, idToken, accessToken, jar };
}

let cachedDiscovery = null;
async function getDiscovery() {
    if (cachedDiscovery) return cachedDiscovery;
    const response = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    assert.equal(response.status, 200, 'Discovery 端点不可用');
    cachedDiscovery = await response.json();
    return cachedDiscovery;
}

async function api(path, token, origin = null) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    return fetch(path, { headers });
}

/* ----------------------------- test cases ----------------------------- */

console.log(`\nUniAuth OIDC 冒烟测试`);
console.log(`  Keycloak : ${KC} (${ISSUER})`);
console.log(`  Portal   : ${PORTAL}`);
console.log(`  Systems  : ${SYSTEM1} / ${SYSTEM2}\n`);

const discovery = await getDiscovery();
await step('OIDC Discovery：issuer 与端点', async () => {
    assert.equal(discovery.issuer, ISSUER);
    assert.ok(discovery.authorization_endpoint && discovery.token_endpoint && discovery.jwks_uri && discovery.userinfo_endpoint);
    assert.ok(discovery.code_challenge_methods_supported.includes('S256'), 'Keycloak 未声明支持 S256 PKCE');
    return `authz=${discovery.authorization_endpoint.split('/').pop()} · S256 PKCE ✓`;
});

let alice;
await step('授权码 + PKCE：alice 登录并换取令牌', async () => {
    alice = await login(ALICE);
    return `${alice.tokens.token_type} · exp=${alice.tokens.expires_in}s · scope="${alice.tokens.scope}"`;
});

await step('ID Token 身份声明：姓名 / 邮箱 / 部门 / 角色 / nonce', async () => {
    const c = alice.idToken.payload;
    assert.equal(c.preferred_username, 'alice');
    assert.equal(c.email, 'alice@example.com');
    assert.equal(c.department, '研发中心');
    assert.equal(c.employee_no, 'E-1001');
    // realm_access.roles 按最佳实践位于 Access Token（ID Token 只负责身份认证）
    const roles = alice.accessToken.payload.realm_access.roles;
    assert.ok(roles.includes('user'));
    assert.ok(!roles.includes('admin'));
    return `${c.name} <${c.email}> · 部门=${c.department} · roles=${roles.join(',')}`;
});

await step('UserInfo：使用 Bearer Access Token 获取用户信息', async () => {
    const response = await api(discovery.userinfo_endpoint, alice.tokens.access_token, PORTAL);
    assert.equal(response.status, 200);
    const cors = response.headers.get('access-control-allow-origin');
    assert.ok(cors === PORTAL || cors === '*', `UserInfo CORS 不允许门户：${cors}`);
    const info = await response.json();
    assert.equal(info.preferred_username, 'alice');
    assert.equal(info.sub, alice.idToken.payload.sub);
    return `sub=${info.sub.slice(0, 8)}… · username=${info.preferred_username}`;
});

await step('系统 1：带 Bearer Token 访问业务接口', async () => {
    const response = await api(`${SYSTEM1}/api/system1/dashboard`, alice.tokens.access_token, PORTAL);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.user.username, 'alice');
    assert.equal(body.user.issuer, ISSUER);
    assert.ok(body.user.audience.includes('system1'));
    assert.equal(body.securityChecks.signature.includes('签名校验通过'), true);
    const cors = response.headers.get('access-control-allow-origin');
    assert.equal(cors, PORTAL, '系统 1 响应缺少正确的 CORS 头');
    return `${body.systemName} · ${body.data.orders.length} 条订单 · aud=${body.user.audience.join(',')}`;
});

await step('系统 2：同一枚 Access Token 也被接受', async () => {
    const response = await api(`${SYSTEM2}/api/system2/dashboard`, alice.tokens.access_token, PORTAL);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.user.username, 'alice');
    assert.ok(body.user.audience.includes('system2'));
    return `${body.systemName} · ${body.data.messages.length} 条消息`;
});

await step('系统 1：alice 访问 admin 接口应返回 403', async () => {
    const response = await api(`${SYSTEM1}/api/system1/admin/audit`, alice.tokens.access_token, PORTAL);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error, 'forbidden');
    assert.deepEqual(body.yourRoles, ['user']);
    return `403 ${body.message} · requiredRole=${body.requiredRole}`;
});

await step('系统 2：alice 访问 admin 接口应返回 403', async () => {
    const response = await api(`${SYSTEM2}/api/system2/admin/console`, alice.tokens.access_token, PORTAL);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error, 'forbidden');
    return `403 · yourRoles=${body.yourRoles.join(',')}`;
});

await step('资源服务器：不带 Token 访问应返回 401 JSON', async () => {
    const response = await api(`${SYSTEM1}/api/system1/dashboard`, null, PORTAL);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error, 'unauthorized');
    assert.match(response.headers.get('www-authenticate') || '', /Bearer/);
    return `${body.error} · ${body.message}`;
});

await step('CORS 预检：系统 1 允许门户携带 Authorization', async () => {
    const response = await fetch(`${SYSTEM1}/api/system1/dashboard`, {
        method: 'OPTIONS',
        headers: {
            Origin: PORTAL,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization'
        }
    });
    assert.ok(response.status === 200 || response.status === 204, `预检状态码异常：${response.status}`);
    assert.equal(response.headers.get('access-control-allow-origin'), PORTAL);
    assert.match(response.headers.get('access-control-allow-headers') || '', /authorization/i);
    return `200 · allow-origin=${PORTAL}`;
});

await step('refresh_token：静默刷新并再次访问系统 1', async () => {
    const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Origin: PORTAL
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: alice.tokens.refresh_token
        })
    });
    const refreshed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(refreshed));
    assert.notEqual(refreshed.access_token, alice.tokens.access_token);
    const claims = decodeJwt(refreshed.access_token).payload;
    assert.ok(claims.aud.includes('system1'));

    const apiResponse = await api(`${SYSTEM1}/api/system1/dashboard`, refreshed.access_token, PORTAL);
    assert.equal(apiResponse.status, 200);
    alice.tokens.access_token = refreshed.access_token;
    alice.tokens.refresh_token = refreshed.refresh_token || alice.tokens.refresh_token;
    alice.tokens.id_token = refreshed.id_token || alice.tokens.id_token;
    return `new token aud=${claims.aud.join(',')}`;
});

await step('SSO：同一 Keycloak 会话再次授权，无需登录页直接回调 code', async () => {
    const state = base64Url(crypto.randomBytes(24));
    const nonce = base64Url(crypto.randomBytes(24));
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();

    const response = await request(url.toString(), { headers: { Accept: 'text/html' } }, alice.jar);
    assert.ok(response.status >= 300 && response.status < 400, `预期直接 302，实际 HTTP ${response.status}`);
    const location = response.headers.get('location');
    assert.ok(location, '缺少 Location');
    assert.ok(location.startsWith(`${PORTAL}/?code=`) || location.startsWith(`${PORTAL}/?`), `未直接回调门户：${location}`);
    parseAuthResponse(location, state);
    return '302 → 门户（未出现登录页）';
});

let bob;
await step('管理员 bob：登录并访问两个系统的 admin 接口', async () => {
    bob = await login(BOB);
    assert.ok(bob.accessToken.payload.realm_access.roles.includes('admin'));
    const r1 = await api(`${SYSTEM1}/api/system1/admin/audit`, bob.tokens.access_token, PORTAL);
    const b1 = await r1.json();
    assert.equal(r1.status, 200, JSON.stringify(b1));
    const r2 = await api(`${SYSTEM2}/api/system2/admin/console`, bob.tokens.access_token, PORTAL);
    const b2 = await r2.json();
    assert.equal(r2.status, 200, JSON.stringify(b2));
    return `admin 角色通过 · ${b1.records.length + b2.records.length} 条管理记录`;
});

await step('RP-Initiated Logout：结束 Keycloak 会话并回到门户', async () => {
    const url = new URL(discovery.end_session_endpoint);
    url.searchParams.set('id_token_hint', alice.tokens.id_token);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('post_logout_redirect_uri', REDIRECT_URI);
    const response = await request(url.toString(), { headers: { Accept: 'text/html' } }, alice.jar);
    assert.ok(response.status >= 300 && response.status < 400, `登出未重定向：HTTP ${response.status}`);
    const location = response.headers.get('location');
    assert.equal(location, REDIRECT_URI);
    return `302 → ${location}`;
});

await step('登出后：新的授权请求必须重新显示登录页', async () => {
    const state = base64Url(crypto.randomBytes(16));
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        nonce: base64Url(crypto.randomBytes(16)),
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();

    let currentUrl = url.toString();
    let response;
    let html = '';
    for (let i = 0; i < 6; i += 1) {
        response = await request(currentUrl, { headers: { Accept: 'text/html' } }, alice.jar);
        if (response.status >= 300 && response.status < 400) {
            currentUrl = new URL(response.headers.get('location'), currentUrl).toString();
            assert.ok(!currentUrl.startsWith(`${PORTAL}/`), '登出后仍直接回调门户，SSO 会话未结束');
            continue;
        }
        html = await response.text();
        break;
    }
    assert.equal(response.status, 200);
    assert.match(html, /kc-form-login|username/, '未显示登录表单');
    return '登录页已重新出现（会话已结束）';
});

/* ----------------------------- summary ----------------------------- */

const passed = results.filter((item) => item.ok).length;
console.log(`\n${'─'.repeat(64)}`);
console.log(`结果：\x1b[32m${passed} 通过\x1b[0m，${failed} 失败`);
console.log(`${'─'.repeat(64)}\n`);

if (failed > 0) process.exit(1);
