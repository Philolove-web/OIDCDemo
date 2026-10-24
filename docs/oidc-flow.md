# OIDC 授权码流程详解

本文按真实执行顺序拆解本项目中的 OIDC 交互。所有端点都来自：

```text
http://localhost:8080/realms/sso-demo/.well-known/openid-configuration
```

---

## 0. 总览

```text
浏览器                          Keycloak                       系统 1 / 2
  │                                │                              │
  │ 1. GET /auth + PKCE            │                              │
  │───────────────────────────────>│                              │
  │ 2. 登录页（密码只提交给这里）  │                              │
  │<──────────────────────────────>│                              │
  │ 3. 302 ?code=...&state=...     │                              │
  │<───────────────────────────────│                              │
  │ 4. POST /token + code_verifier │                              │
  │───────────────────────────────>│                              │
  │ 5. ID Token + Access Token     │                              │
  │<───────────────────────────────│                              │
  │ 6. 校验 ID Token（iss/aud/nonce/exp）                          │
  │                                │                              │
  │ 7. GET /userinfo (Bearer)      │                              │
  │───────────────────────────────>│                              │
  │                                │                              │
  │ 8. GET /api/... (Bearer)       │                              │
  │──────────────────────────────────────────────────────────────>│
  │                                │ 9. 首次请求拉取 JWKS（缓存）  │
  │                                │<─────────────────────────────│
  │                                │ 10. 本地验签 + aud + 角色     │
  │ 11. 200 + 业务数据             │                              │
  │<──────────────────────────────────────────────────────────────│
```

对应前端代码：

| 步骤 | 代码 |
| --- | --- |
| 1 | `OidcClient.login()` |
| 2 | Keycloak 登录页（本项目不参与） |
| 3 | `OidcClient.handleCallback()` 读取 `code` / `state` |
| 4–5 | `handleCallback()` 中的 `fetch(token_endpoint)` |
| 6 | `OidcClient.validateIdToken()` |
| 7 | `OidcClient.fetchUserInfo()` |
| 8 | `app.js → callSystem()` |
| 9–10 | `system1 / system2` 的 Spring Security 自动完成 |
| 11 | `System1Controller / System2Controller` |

---

## 1. Discovery：先找到端点

```http
GET /.well-known/openid-configuration HTTP/1.1
Host: localhost:8080
```

响应（节选）：

```json
{
  "issuer": "http://localhost:8080/realms/sso-demo",
  "authorization_endpoint": "http://localhost:8080/realms/sso-demo/protocol/openid-connect/auth",
  "token_endpoint": "http://localhost:8080/realms/sso-demo/protocol/openid-connect/token",
  "userinfo_endpoint": "http://localhost:8080/realms/sso-demo/protocol/openid-connect/userinfo",
  "jwks_uri": "http://localhost:8080/realms/sso-demo/protocol/openid-connect/certs",
  "end_session_endpoint": "http://localhost:8080/realms/sso-demo/protocol/openid-connect/logout",
  "response_types_supported": ["code", "none", "id_token", ...],
  "code_challenge_methods_supported": ["plain", "S256"]
}
```

前端不硬编码 Keycloak 的路径，而是从这份文档读取 `authorization_endpoint`、`token_endpoint` 等。这样换 realm / 换 Keycloak 地址时只需要改 issuer。

---

## 2. 授权请求（前端 → Keycloak）

### 2.1 生成 PKCE 参数

```js
const codeVerifier = randomString(48);              // 48 字节随机数 → BASE64URL
const codeChallenge = base64UrlEncode(
    sha256(new TextEncoder().encode(codeVerifier))
);
const state = randomString(24);
const nonce = randomString(24);
```

`code_verifier` 只保存在 `sessionStorage`，不会出现在任何 URL 中；URL 里只有它的 SHA-256 摘要 `code_challenge`。

### 2.2 302 到授权端点

```http
GET /realms/sso-demo/protocol/openid-connect/auth
    ?response_type=code
    &client_id=sso-portal
    &redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F
    &scope=openid%20profile%20email
    &state=NLvgGH5YWi6f6BLxH8N1gUtoPRPvrhkf
    &nonce=zkUxeIvjR3M4vYnY1hTg-8p7ofmy_IPW
    &code_challenge=XY32WAFLSUmbEjilMk-m0xveLpXPqWLvQ-GUlusTnOA
    &code_challenge_method=S256 HTTP/1.1
Host: localhost:8080
```

各参数：

| 参数 | 作用 |
| --- | --- |
| `response_type=code` | 使用授权码流程（不是 implicit） |
| `client_id=sso-portal` | Keycloak 中注册的 public client |
| `redirect_uri` | 必须与客户端注册值精确匹配 |
| `scope=openid profile email` | `openid` 是 OIDC 必需项；`profile` / `email` 提供身份声明 |
| `state` | 防 CSRF，回调时必须一致 |
| `nonce` | 防 ID Token 重放，会写入 ID Token |
| `code_challenge` | PKCE，`code_verifier` 的 S256 摘要 |
| `code_challenge_method=S256` | 本项目强制 S256 |

### 2.3 Keycloak 认证用户

Keycloak 返回登录页。**用户名和密码只提交给 Keycloak**，门户页面完全接触不到密码。

如果浏览器已有有效的 Keycloak SSO 会话，这一步会被跳过，直接进入第 3 步——这就是单点登录。

---

## 3. 回调：浏览器拿到授权码

```http
HTTP/1.1 302 Found
Location: http://localhost:3000/?code=1f0c8...&state=NLvgGH5YWi6f6BLxH8N1gUtoPRPvrhkf&session_state=...
```

门户：

1. 从 URL 读取 `code` 和 `state`
2. 从 `sessionStorage` 读取登录事务
3. 比较 `state`，不一致就拒绝（防 CSRF）
4. 立即用 `history.replaceState` 清掉地址栏里的 `code`

注意：**授权码不是 Token**。它只是一次性、短时效（本项目 `accessCodeLifespan=60s`）的兑换凭证，单独拿到它没有 `code_verifier` 也换不到 Token。

---

## 4. Token 交换（浏览器 → Keycloak 后端通道）

```http
POST /realms/sso-demo/protocol/openid-connect/token HTTP/1.1
Host: localhost:8080
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=1f0c8...
&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F
&client_id=sso-portal
&code_verifier=<原始随机串>
```

响应：

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "expires_in": 300,
  "refresh_expires_in": 1800,
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "not-before-policy": 0,
  "session_state": "8f0c8f...",
  "scope": "openid email profile"
}
```

Keycloak 会：

- 校验 `code` 是否存在、是否已使用、是否过期
- 校验 `redirect_uri` 与授权请求时一致
- 计算 `SHA256(code_verifier)` 并与授权请求里的 `code_challenge` 比较
- 校验客户端允许的 flow
- 签发 ID Token、Access Token、Refresh Token

> 这一步是浏览器直接请求 Keycloak 的 Token 端点，因此 Keycloak 客户端必须允许 `http://localhost:3000` 的 Web Origin。realm 里已配置；如果 CORS 报错，检查这里。

---

## 5. ID Token 校验（浏览器端）

### 5.1 解码

ID Token 是一个 JWT，三段：

```text
header.payload.signature
```

Payload 示例（真实字段，敏感值已截断）：

```json
{
  "exp": 1792139861,
  "iat": 1792139561,
  "jti": "6f0c8f...",
  "iss": "http://localhost:8080/realms/sso-demo",
  "aud": "sso-portal",
  "sub": "af3a613e-427a-4208-9a91-ac526e365ddf",
  "typ": "ID",
  "azp": "sso-portal",
  "nonce": "zkUxeIvjR3M4vYnY1hTg-8p7ofmy_IPW",
  "session_state": "...",
  "acr": "1",
  "email_verified": true,
  "name": "Alice Wang",
  "preferred_username": "alice",
  "email": "alice@example.com",
  "department": "研发中心",
  "employee_no": "E-1001"
}
```

### 5.2 本项目的校验项

`OidcClient.validateIdToken()`：

| 检查 | 代码 | 失败后果 |
| --- | --- | --- |
| `alg` 不是 `none`，且为 RS256 | `header.alg === 'RS256'` | 拒绝登录 |
| `iss` 与配置 issuer 一致 | `claims.iss === discovery.issuer` | 拒绝登录 |
| `aud` 包含 `sso-portal` | `audience.includes(clientId)` | 拒绝登录 |
| `azp` 正确（存在时） | `!claims.azp || claims.azp === clientId` | 拒绝登录 |
| `exp` 未过期（允许 60s 时钟偏移） | `claims.exp > now - 60` | 拒绝登录 |
| `sub` 存在 | `Boolean(claims.sub)` | 拒绝登录 |
| `nonce` 与授权请求一致 | `claims.nonce === tx.nonce` | 拒绝登录 |

任何一项失败，`handleCallback()` 抛错，页面回到未登录状态，协议时间线记录失败原因。

### 5.3 为什么浏览器不验签

严格来说，RP 应该验证 ID Token 的签名。本 Demo 在浏览器端只做声明校验，原因：

- 演示重点是**协议数据**和**后端资源服务器验签**
- 浏览器端验签需要额外拉取 JWKS、用 WebCrypto 验证 RS256，代码量较大
- Token 是通过 TLS（生产环境）+ 后端 Token 端点直接换取的；XSS 才是 SPA 的主要威胁
- 生产环境推荐 **BFF**，在服务端完成签名校验并保持会话

后端系统 1 / 2 对 **Access Token** 的签名校验是完整的（JWKS + RS256），这部分没有省略。

### 5.4 系统页面如何显示“当前角色”

系统 1 / 2 的页面和门户一样，用授权码 + PKCE 换到 `sso-portal` 的 Token；只是 redirect URI 分别是 `http://localhost:8081/` 和 `http://localhost:8082/`。

角色读取分两层：

1. 浏览器先解码 **Access Token**，读取 `realm_access.roles`
2. 再用系统后端 `/api/systemX/dashboard` 返回的 `user.roles` 交叉确认；后端返回的角色来自已验签的同一枚 Token

页面把角色放在三个位置：

- 顶栏角色徽标
- 首屏大字角色卡（普通用户 / USER，管理员 / ADMIN）
- 权限矩阵（业务数据、管理接口分别显示已授权 / 未授权）

因此角色展示不是前端写死的 UI 文案，而是来自 Keycloak 签发、后端验签的 Token 声明。`user` 与 `admin` 的颜色也不同：普通用户使用系统主题色，管理员使用金色。

---

## 6. UserInfo

```http
GET /realms/sso-demo/protocol/openid-connect/userinfo HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

响应：

```json
{
  "sub": "af3a613e-427a-4208-9a91-ac526e365ddf",
  "email_verified": true,
  "name": "Alice Wang",
  "preferred_username": "alice",
  "email": "alice@example.com",
  "department": "研发中心",
  "employee_no": "E-1001"
}
```

OIDC 标准允许两种获取身份声明的方式：

- 从 ID Token 读取（本项目身份卡主要用它）
- 调用 UserInfo（本项目提供按钮，演示 Bearer 访问）

两者 `sub` 必须一致。

---

## 7. 访问资源服务器

```http
GET /api/system1/dashboard HTTP/1.1
Host: localhost:8081
Origin: http://localhost:3000
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

### 7.1 后端做了什么

Spring Security 资源服务器自动：

1. 解析 `Authorization: Bearer`，取出 JWT
2. 根据 `issuer-uri` 获取（并缓存）JWKS
3. 用 `kid` 找到对应公钥
4. 验证 RS256 签名
5. 校验 `iss`、`exp`、`nbf`
6. 校验 `aud` 包含 `system1`（`audiences` 配置）
7. 通过 `JwtAuthenticationConverter` 把 `realm_access.roles` 转成 `ROLE_*`
8. 根据 URL 规则 / `@PreAuthorize` 做授权

任何一步失败：

- 无 Token / 签名错 / 过期 / issuer 错 / aud 错 → **401**
- 签名有效但角色不够 → **403**

本项目的 401 / 403 都返回 JSON，并在 401 上设置：

```http
WWW-Authenticate: Bearer realm="system1", error="invalid_token"
```

### 7.2 Access Token 的关键部分

```json
{
  "iss": "http://localhost:8080/realms/sso-demo",
  "aud": ["system1", "system2"],
  "azp": "sso-portal",
  "sub": "af3a613e-427a-4208-9a91-ac526e365ddf",
  "realm_access": {
    "roles": ["user"]
  },
  "scope": "openid email profile",
  "preferred_username": "alice",
  "email": "alice@example.com",
  "department": "研发中心",
  "employee_no": "E-1001",
  "exp": 1792139861
}
```

两个系统使用同一枚 Access Token，所以 `aud` 同时包含 `system1` 和 `system2`。

### 7.3 为什么系统 1 和系统 2 不需要互相知道

它们只共享：

- Keycloak 的 realm issuer
- Keycloak 的 JWKS 公钥
- 对 `aud` 和角色的约定

没有共享 Session、数据库、密钥、代码。增加系统 3 时，只需要一个新的 audience 和一套新的角色规则。

---

## 8. 刷新令牌

Access Token 默认 5 分钟过期。页面上的倒计时归零前，可以：

- 点击 **“刷新令牌”**
- 或者在调用 API 前由 `ensureToken()` 自动刷新（剩余 < 30 秒时）

请求：

```http
POST /token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=sso-portal
&refresh_token=eyJhbGciOiJIUzI1NiIs...
```

Keycloak 返回新的 Access Token（可能也会返回新的 ID Token / Refresh Token）。前端更新本地会话并重置倒计时。

刷新不会重新要求用户登录，也不会改变 `sub` / 角色（除非管理员修改了用户角色）。

---

## 9. 单点登录（SSO）

SSO 的关键不是前端代码，而是 **Keycloak 的会话 Cookie**。

第一次登录成功后：

```text
Set-Cookie: KEYCLOAK_SESSION=sso-demo/...; Path=/realms/sso-demo/; HttpOnly
Set-Cookie: KEYCLOAK_IDENTITY=...; Path=/realms/sso-demo/; HttpOnly
```

之后访问任意一个前端时：

1. 新页面没有自己的 `sessionStorage`（每个 origin / 标签页独立）
2. 点击登录 → 发起新的授权请求，redirect URI 指向当前页面
3. 浏览器自动带上 `localhost:8080` 的 Keycloak Cookie
4. Keycloak 发现 SSO 会话有效，**不再显示登录页**，直接 302 回带 `code` 的 redirect URI
5. 当前页面用新 code 换新 Token，显示自己的“登录成功”和角色

具体到本项目：

- 门户的 **“新标签页验证 SSO”** 打开 `?login=1`
- 在门户登录 `alice` 后直接打开 <http://localhost:8081>，点击登录会免密进入系统 1
- 系统 1 已登录时再打开 <http://localhost:8082>，点击登录同样免密进入系统 2
- 三个前端共用 Keycloak 的 SSO 会话，但 Token 存在各自的 `sessionStorage` 中，不互相复制

> Demo 中三个前端共用 `sso-portal` 客户端；它们各自注册 redirect URI。生产环境建议拆成独立客户端。

---

## 10. 退出登录（RP-Initiated Logout）

```http
GET /realms/sso-demo/protocol/openid-connect/logout
    ?id_token_hint=eyJhbGciOiJSUzI1NiIs...
    &client_id=sso-portal
    &post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F
```

Keycloak：

1. 根据 `id_token_hint` 找到对应会话
2. 结束该浏览器的 SSO 会话
3. 校验 `post_logout_redirect_uri` 已在客户端注册
4. 302 回 `http://localhost:3000/`

前端在跳转前已经清除 `sessionStorage` 中的 Token。回来之后：

- 页面回到未登录状态
- 再次发起授权请求会重新显示登录页（冒烟测试验证了这一点）

只清前端 Token、不调用 `end_session_endpoint` 的话，Keycloak 会话仍然有效，下一次点击登录会“秒登录”，用户会误以为没有退出。这也是很多 SSO Demo 的常见问题。

---

## 11. 在浏览器里观察协议

打开 DevTools：

### Network

过滤 `openid-connect` 或 `token`：

- `auth` 请求：302 到登录页
- 登录 POST：`login-actions/authenticate`
- 回调：`localhost:3000/?code=...`（302）
- `token`：POST，Form Data 里可以看到 `code_verifier`
- `userinfo`：GET，带 Bearer
- `certs`：资源服务器首次请求时拉取 JWKS

勾选 **Preserve log**，否则登录跳转会清空 Network 记录。

### Application → Session Storage

```text
http://localhost:3000
├── uniauth.sso.tokens       # access_token / id_token / refresh_token / expires_at
├── uniauth.sso.last-auth    # 授权请求 URL 与参数
├── uniauth.sso.trace        # 协议时间线
├── uniauth.sso.userinfo     # UserInfo 响应
└── uniauth.sso.tx           # 仅登录过程中存在的一次性事务

http://localhost:8081
└── system1.sso.tokens       # 系统 1 自己的 Token
http://localhost:8082
└── system2.sso.tokens       # 系统 2 自己的 Token
```

本 Demo 用 `sessionStorage`，关闭标签页即销毁。生产环境不建议把长期 Token 放在这里。

### Console

`OidcClient` 不会把 Token 打印到控制台；协议数据只渲染在页面的“协议检查器”中。

---

## 12. 常见错误与排查

| 错误 | 含义 | 排查 |
| --- | --- | --- |
| `invalid_redirect_uri` | 回调地址与注册值不一致 | 用 `localhost:3000`；检查 Keycloak 的 Valid redirect URIs |
| `unauthorized_client` | 客户端不允许该 flow | 确认 sso-portal 的 Standard Flow 开启 |
| `invalid_grant: Code not valid` | code 过期 / 重复使用 / verifier 不匹配 | 重新登录；检查 `code_verifier` 是否被覆盖 |
| `invalid_grant: Incorrect redirect_uri` | 换 Token 时 redirect_uri 不一致 | 授权和换 Token 必须使用完全相同的 URI |
| `invalid_client` | client_id 错，或 public client 传了 secret | 检查 `frontend/config.js` |
| state 校验失败 | 回调 state 与 sessionStorage 不一致 | 检查是否在多标签页/旧页面重复回调；刷新重试 |
| ID Token `nonce` 不匹配 | 授权请求与 Token 不配对 | 重新发起登录；不要复用旧事务 |
| 系统 401 `Invalid audience` | Access Token 的 aud 不含当前系统 | 检查 portal 的 audience mapper |
| 系统 401 `JWT issuer is not trusted` | Token iss 与后端 issuer-uri 不一致 | 检查 `KC_HOSTNAME` / `SSO_ISSUER` |
| 系统 401 `JWT expired` | Access Token 过期 | 刷新令牌 |
| 系统 403 | 角色不足 | 用 `bob` 登录；检查 `realm_access.roles` |
| 浏览器 CORS | Web origins / 后端 CORS 未配置 | 检查 Keycloak Web origins、`app.frontend-origin` |
| 刷新后登录状态丢失 | `sessionStorage` 被清空 / 新标签页 | 正常现象；SSO 依赖 Keycloak Cookie |
| 登出后仍自动登录 | 只清了本地 Token，未调用 end_session | 检查 `OidcClient.logout()` 是否被调用 |

---

## 13. 生产化建议

1. **BFF 模式**：浏览器只持有 HttpOnly Session Cookie，Token 保存在服务端
2. 浏览器与 Keycloak 全链路 HTTPS；Keycloak 使用 `start` 而非 `start-dev`
3. 使用外部数据库（PostgreSQL）和真实主机名
4. 严格的 redirect URI / post logout URI / Web origin 白名单
5. 更短的 Access Token 生命周期 + refresh token rotation + 会话撤销
6. 资源服务器继续本地 JWKS 验签，并做 scope / role / audience 的最小权限校验
7. 增加 CSP、HSTS、Referrer-Policy，防止 XSS 窃取 SPA 中的 Token
8. 对敏感操作（管理员接口）考虑额外认证强度（`acr` / step-up authentication）

---

## 14. 相关文档

- [架构设计](architecture.md)
- [Keycloak 配置](keycloak-setup.md)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 7636 · PKCE](https://www.rfc-editor.org/rfc/rfc7636)
