/**
 * 一个刻意保持“透明”的 OIDC 客户端实现。
 *
 * 没有使用 oidc-client-ts 等库，目的是把授权码 + PKCE 流程的每一步都显式写出来，
 * 方便在页面的「协议检查器」中观察真实请求。
 *
 * 支持：Discovery、Authorization Code + PKCE (S256)、state / nonce 校验、
 *       ID Token 声明校验、refresh_token 刷新、UserInfo、RP-Initiated Logout。
 */
export class OidcClient {
    constructor(config, { onEvent } = {}) {
        this.config = config;
        this.onEvent = onEvent || (() => {});
        this.discovery = null;
        this.prefix = config.storagePrefix || 'uniauth.sso';
    }

    /* ----------------------------- storage ----------------------------- */

    key(name) {
        return `${this.prefix}.${name}`;
    }

    emit(event) {
        try {
            this.onEvent(event);
        } catch (error) {
            console.warn('protocol event handler failed', error);
        }
    }

    getSession() {
        try {
            const raw = sessionStorage.getItem(this.key('tokens'));
            if (!raw) return null;
            const session = JSON.parse(raw);
            if (!session.access_token || !session.id_token) return null;
            if (session.issuer !== this.config.issuer || session.client_id !== this.config.clientId) return null;
            return session;
        } catch {
            return null;
        }
    }

    saveSession(session) {
        sessionStorage.setItem(this.key('tokens'), JSON.stringify(session));
    }

    clearSession() {
        for (const key of Object.keys(sessionStorage)) {
            if (key.startsWith(`${this.prefix}.`) && key !== this.key('logged-out')) {
                sessionStorage.removeItem(key);
            }
        }
    }

    getLastAuthRequest() {
        try {
            const raw = sessionStorage.getItem(this.key('last-auth'));
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    saveUserInfo(info) {
        sessionStorage.setItem(this.key('userinfo'), JSON.stringify(info));
    }

    getUserInfo() {
        try {
            const raw = sessionStorage.getItem(this.key('userinfo'));
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    consumeLogoutFlag() {
        const flag = sessionStorage.getItem(this.key('logged-out'));
        if (flag) sessionStorage.removeItem(this.key('logged-out'));
        return Boolean(flag);
    }

    /* ----------------------------- discovery ----------------------------- */

    async discover(force = false) {
        if (this.discovery && !force) return this.discovery;

        const issuer = this.config.issuer.replace(/\/$/, '');
        const url = `${issuer}/.well-known/openid-configuration`;
        const started = performance.now();

        let response;
        try {
            response = await fetch(url, { headers: { Accept: 'application/json' } });
        } catch (error) {
            this.emit({
                category: 'error',
                title: '无法访问 Keycloak Discovery 端点',
                method: 'GET',
                url,
                status: 'NETWORK ERROR',
                durationMs: Math.round(performance.now() - started),
                note: `请确认 Keycloak 已启动、issuer 配置正确。${error.message}`,
                level: 'error'
            });
            throw new Error(`无法连接 Keycloak（${issuer}），请确认 Docker 容器已启动`);
        }

        const body = await response.json().catch(() => null);
        const durationMs = Math.round(performance.now() - started);

        if (!response.ok || !body) {
            this.emit({
                category: 'error',
                title: '获取 OIDC 元数据失败',
                method: 'GET',
                url,
                status: response.status,
                durationMs,
                response: body,
                level: 'error'
            });
            throw new Error(`Discovery 请求失败：HTTP ${response.status}`);
        }
        if (!body.authorization_endpoint || !body.token_endpoint) {
            throw new Error('Discovery 文档缺少 authorization_endpoint / token_endpoint');
        }

        this.discovery = body;
        this.emit({
            category: 'discovery',
            title: '获取 OIDC Discovery 元数据',
            method: 'GET',
            url,
            status: response.status,
            durationMs,
            response: {
                issuer: body.issuer,
                authorization_endpoint: body.authorization_endpoint,
                token_endpoint: body.token_endpoint,
                userinfo_endpoint: body.userinfo_endpoint,
                jwks_uri: body.jwks_uri,
                end_session_endpoint: body.end_session_endpoint,
                response_types_supported: body.response_types_supported,
                code_challenge_methods_supported: body.code_challenge_methods_supported
            },
            note: '登录门户从 .well-known 文档自动发现所有端点，不硬编码 Keycloak 路径。'
        });
        return body;
    }

    /* ----------------------------- login ----------------------------- */

    async login() {
        const discovery = await this.discover();
        // 换账号登录时避免展示上一个账号缓存的 UserInfo
        sessionStorage.removeItem(this.key('userinfo'));

        const state = randomString(24);
        const nonce = randomString(24);
        const codeVerifier = randomString(48);
        const codeChallenge = await sha256Base64Url(codeVerifier);

        sessionStorage.setItem(this.key('tx'), JSON.stringify({
            state,
            nonce,
            codeVerifier,
            startedAt: Date.now()
        }));

        const url = new URL(discovery.authorization_endpoint);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: this.config.scope,
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        }).toString();

        const authRequest = {
            url: url.toString(),
            params: Object.fromEntries(url.searchParams.entries()),
            startedAt: Date.now()
        };
        sessionStorage.setItem(this.key('last-auth'), JSON.stringify(authRequest));

        this.emit({
            category: 'authorize',
            title: '发起授权请求（浏览器跳转 Keycloak）',
            method: 'GET',
            url: url.toString(),
            status: '302 Redirect',
            request: {
                response_type: 'code',
                client_id: this.config.clientId,
                redirect_uri: this.config.redirectUri,
                scope: this.config.scope,
                state: `${state.slice(0, 10)}…（完整值存于会话）`,
                nonce: `${nonce.slice(0, 10)}…`,
                code_challenge: `${codeChallenge.slice(0, 16)}…`,
                code_challenge_method: 'S256'
            },
            note: 'state 防 CSRF；nonce 防 ID Token 重放；PKCE 让授权码只能被本浏览器兑换。'
        });

        window.location.assign(url.toString());
    }

    /* ----------------------------- callback ----------------------------- */

    async handleCallback() {
        const params = new URLSearchParams(window.location.search);

        if (params.has('error')) {
            const error = params.get('error');
            const description = params.get('error_description') || '';
            this.emit({
                category: 'error',
                title: 'Keycloak 返回授权错误',
                method: 'GET',
                url: window.location.href,
                status: error,
                response: { error, error_description: description },
                level: 'error'
            });
            throw new Error(`授权失败：${error}${description ? `（${description}）` : ''}`);
        }

        const code = params.get('code');
        const state = params.get('state');
        if (!code) return null;

        const rawTx = sessionStorage.getItem(this.key('tx'));
        if (!rawTx) {
            throw new Error('未找到登录事务（sessionStorage），请回到登录页重新发起登录');
        }
        const tx = JSON.parse(rawTx);

        if (!state || state !== tx.state) {
            throw new Error('state 校验失败：回调参数与本地保存的 state 不一致，可能遭遇 CSRF');
        }

        this.emit({
            category: 'callback',
            title: 'Keycloak 回调，携带一次性授权码',
            method: 'GET',
            url: `${this.config.redirectUri}?code=${mask(code, 14)}&state=${mask(state, 10)}`,
            status: '302 → 门户',
            durationMs: Date.now() - tx.startedAt,
            request: {
                code: `${mask(code, 14)}（${code.length} 字符）`,
                state: '与本地 state 一致 ✓'
            },
            note: '浏览器地址栏只会出现授权码，不会出现任何 Token。'
        });

        const discovery = await this.discover();

        const started = performance.now();
        const tokenResponse = await fetch(discovery.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.config.redirectUri,
                client_id: this.config.clientId,
                code_verifier: tx.codeVerifier
            })
        });
        const tokens = await tokenResponse.json().catch(() => null);

        this.emit({
            category: 'token',
            title: '使用授权码 + code_verifier 换取令牌',
            method: 'POST',
            url: discovery.token_endpoint,
            status: tokenResponse.status,
            durationMs: Math.round(performance.now() - started),
            request: {
                grant_type: 'authorization_code',
                client_id: this.config.clientId,
                redirect_uri: this.config.redirectUri,
                code: `${mask(code, 12)}…`,
                code_verifier: `${tx.codeVerifier.length} 字符（仅本浏览器持有）`
            },
            response: tokens ? {
                token_type: tokens.token_type,
                expires_in: tokens.expires_in,
                scope: tokens.scope,
                id_token: `${tokens.id_token?.length ?? 0} 字符`,
                access_token: `${tokens.access_token?.length ?? 0} 字符`,
                refresh_token: tokens.refresh_token ? '已签发' : '未签发'
            } : null,
            note: 'Token 只通过这个 Token 端点返回，不会出现在浏览器的重定向 URL 中。',
            level: tokenResponse.ok ? 'info' : 'error'
        });

        if (!tokenResponse.ok || !tokens?.access_token || !tokens?.id_token) {
            const message = tokens?.error_description || tokens?.error || `HTTP ${tokenResponse.status}`;
            throw new Error(`令牌交换失败：${message}`);
        }

        const decoded = decodeJwt(tokens.id_token);
        this.validateIdToken(decoded.payload, decoded.header, {
            expectedNonce: tx.nonce,
            discovery
        });

        const session = {
            ...tokens,
            issuer: discovery.issuer,
            client_id: this.config.clientId,
            obtained_at: Date.now(),
            expires_at: Date.now() + (Number(tokens.expires_in) || 300) * 1000
        };
        this.saveSession(session);
        sessionStorage.removeItem(this.key('tx'));

        return { session, claims: decoded.payload, header: decoded.header, authRequest: this.getLastAuthRequest() };
    }

    validateIdToken(claims, header, { expectedNonce, discovery } = {}) {
        const issuer = discovery?.issuer || this.config.issuer;
        const now = Math.floor(Date.now() / 1000);
        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

        const checks = [
            {
                name: 'alg 算法安全',
                ok: header?.alg === 'RS256',
                detail: `ID Token 头部的 alg = ${header?.alg || '缺失'}`
            },
            {
                name: 'iss 签发者一致',
                ok: claims.iss === issuer,
                detail: claims.iss
            },
            {
                name: 'aud 包含本客户端',
                ok: audience.includes(this.config.clientId),
                detail: audience.join(', ')
            },
            {
                name: 'azp 授权方正确',
                ok: !claims.azp || claims.azp === this.config.clientId,
                detail: claims.azp || '未提供（单一 audience）'
            },
            {
                name: 'exp 未过期',
                ok: Number(claims.exp) > now - 60,
                detail: claims.exp ? new Date(claims.exp * 1000).toLocaleString('zh-CN') : '缺失'
            },
            {
                name: 'sub 存在',
                ok: Boolean(claims.sub),
                detail: claims.sub || '缺失'
            }
        ];

        if (expectedNonce) {
            checks.push({
                name: 'nonce 与授权请求一致',
                ok: claims.nonce === expectedNonce,
                detail: claims.nonce ? mask(String(claims.nonce), 10) : '缺失'
            });
        }

        const failed = checks.filter((check) => !check.ok);
        this.emit({
            category: 'validate',
            title: '校验 ID Token 声明',
            method: 'LOCAL',
            url: '浏览器内存',
            status: failed.length === 0 ? 'PASSED' : 'FAILED',
            checks,
            note: '签名由 Keycloak 的 RS256 私钥生成；浏览器端校验声明，资源服务器再用 JWKS 公钥验签。',
            level: failed.length === 0 ? 'info' : 'error'
        });

        if (failed.length > 0) {
            throw new Error(`ID Token 校验失败：${failed.map((item) => item.name).join('、')}`);
        }
    }

    /* ----------------------------- tokens ----------------------------- */

    async ensureToken() {
        const session = this.getSession();
        if (!session) throw new Error('尚未登录');

        const remaining = session.expires_at - Date.now();
        if (remaining <= 30_000) {
            if (session.refresh_token) return this.refresh();
            if (remaining <= 0) throw new Error('Access Token 已过期，请重新登录');
        }
        return session;
    }

    async refresh() {
        const current = this.getSession();
        if (!current?.refresh_token) throw new Error('当前会话没有 refresh_token，无法刷新');

        const discovery = await this.discover();
        const started = performance.now();
        const response = await fetch(discovery.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.config.clientId,
                refresh_token: current.refresh_token
            })
        });
        const tokens = await response.json().catch(() => null);

        this.emit({
            category: 'refresh',
            title: '使用 refresh_token 静默刷新令牌',
            method: 'POST',
            url: discovery.token_endpoint,
            status: response.status,
            durationMs: Math.round(performance.now() - started),
            request: {
                grant_type: 'refresh_token',
                client_id: this.config.clientId,
                refresh_token: `${mask(current.refresh_token, 10)}…`
            },
            response: tokens ? {
                token_type: tokens.token_type,
                expires_in: tokens.expires_in,
                scope: tokens.scope,
                access_token: `${tokens.access_token?.length ?? 0} 字符`
            } : null,
            level: response.ok ? 'info' : 'error'
        });

        if (!response.ok || !tokens?.access_token) {
            const message = tokens?.error_description || tokens?.error || `HTTP ${response.status}`;
            throw new Error(`刷新令牌失败：${message}，请重新登录`);
        }

        if (tokens.id_token) {
            const decoded = decodeJwt(tokens.id_token);
            this.validateIdToken(decoded.payload, decoded.header, { discovery });
        }

        const next = {
            ...current,
            ...tokens,
            refresh_token: tokens.refresh_token || current.refresh_token,
            issuer: discovery.issuer,
            client_id: this.config.clientId,
            expires_at: Date.now() + (Number(tokens.expires_in) || 300) * 1000
        };
        this.saveSession(next);
        return next;
    }

    /* ----------------------------- userinfo ----------------------------- */

    async fetchUserInfo() {
        const session = await this.ensureToken();
        const discovery = await this.discover();
        if (!discovery.userinfo_endpoint) throw new Error('Keycloak 未提供 userinfo_endpoint');

        const started = performance.now();
        const response = await fetch(discovery.userinfo_endpoint, {
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                Accept: 'application/json'
            }
        });
        const body = await response.json().catch(() => null);

        this.emit({
            category: 'userinfo',
            title: '调用 UserInfo 端点（Bearer Access Token）',
            method: 'GET',
            url: discovery.userinfo_endpoint,
            status: response.status,
            durationMs: Math.round(performance.now() - started),
            request: {
                Authorization: `Bearer ${mask(session.access_token, 18)}`
            },
            response: body,
            level: response.ok ? 'info' : 'error'
        });

        if (!response.ok) {
            throw new Error(`UserInfo 请求失败：HTTP ${response.status}`);
        }
        this.saveUserInfo(body);
        return body;
    }

    /* ----------------------------- logout ----------------------------- */

    async logout() {
        const session = this.getSession();
        let discovery = null;
        try {
            discovery = await this.discover();
        } catch {
            // 即使 Discovery 失败也保留本地登出能力
        }

        this.clearSession();
        sessionStorage.setItem(this.key('logged-out'), '1');

        if (discovery?.end_session_endpoint) {
            const url = new URL(discovery.end_session_endpoint);
            if (session?.id_token) url.searchParams.set('id_token_hint', session.id_token);
            url.searchParams.set('client_id', this.config.clientId);
            url.searchParams.set('post_logout_redirect_uri', this.config.postLogoutRedirectUri);
            window.location.assign(url.toString());
        } else {
            window.location.assign(this.config.postLogoutRedirectUri);
        }
    }
}

/* ============================= helpers ============================= */

export function decodeJwt(token) {
    if (typeof token !== 'string' || token.split('.').length !== 3) {
        throw new Error('不是有效的 JWT（应为 header.payload.signature 三段）');
    }
    const [encodedHeader, encodedPayload] = token.split('.');
    try {
        return {
            header: JSON.parse(base64UrlDecode(encodedHeader)),
            payload: JSON.parse(base64UrlDecode(encodedPayload))
        };
    } catch {
        throw new Error('JWT 解码失败，payload 不是合法 JSON');
    }
}

export function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function mask(value, visible = 8) {
    if (!value) return '—';
    const text = String(value);
    return text.length <= visible ? text : `${text.slice(0, visible)}…`;
}

function randomString(byteLength = 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(value) {
    if (!crypto.subtle) {
        throw new Error('当前环境不支持 WebCrypto（PKCE 需要 HTTPS 或 localhost）');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
