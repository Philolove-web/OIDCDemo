/**
 * 统一登录门户配置。
 *
 * 如果修改了端口或域名，请同步修改：
 *   1. 这里的 redirectUri / postLogoutRedirectUri / systems.baseUrl
 *   2. Keycloak 客户端 sso-portal 的 Valid redirect URIs / Web origins
 *   3. system1、system2 的 app.frontend-origin
 */
window.SSO_CONFIG = {
    // Keycloak realm 的 issuer，必须与后端 application.yml 中的 SSO_ISSUER 完全一致
    issuer: "http://localhost:8080/realms/sso-demo",
    clientId: "sso-portal",

    // 必须是 Keycloak 客户端中注册过的 Valid redirect URI
    redirectUri: window.location.origin + "/",
    postLogoutRedirectUri: window.location.origin + "/",

    // 授权码流程所需的 scope；openid 是 OIDC 的必填项
    scope: "openid profile email",

    // 本地 token 存储 key 前缀（使用 sessionStorage，关闭标签页即销毁）
    storagePrefix: "uniauth.sso",

    systems: [
        {
            id: "system1",
            name: "系统 1 · 订单中心",
            shortName: "系统 1",
            baseUrl: "http://localhost:8081",
            uiUrl: "http://localhost:8081/",
            dashboardPath: "/api/system1/dashboard",
            adminPath: "/api/system1/admin/audit"
        },
        {
            id: "system2",
            name: "系统 2 · 消息中心",
            shortName: "系统 2",
            baseUrl: "http://localhost:8082",
            uiUrl: "http://localhost:8082/",
            dashboardPath: "/api/system2/dashboard",
            adminPath: "/api/system2/admin/console"
        }
    ]
};
