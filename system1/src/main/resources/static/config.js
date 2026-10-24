/**
 * 系统 1 · 订单中心 前端配置。
 *
 * 与统一门户共用 Keycloak 的 sso-portal 公开客户端（Demo 简化），
 * 但使用自己的 redirect URI 和 sessionStorage 前缀。
 */
window.SYSTEM_CONFIG = {
    systemId: "system1",
    systemName: "系统 1",
    systemFullName: "系统 1 · 订单中心",
    subtitle: "订单中心",
    mark: "S1",

    landingSystemCaption: "系统 1 · 订单中心",
    landingTitle: "每一笔订单，",
    landingHighlight: "都从可信身份开始。",
    landingLead: "系统 1 是独立的 Spring Boot 资源服务器，只处理属于你的订单。它不保存密码、不创建会话，只信任 Keycloak 签发的 Access Token。",

    portalUrl: "http://localhost:3000/",
    issuer: "http://localhost:8080/realms/sso-demo",
    clientId: "sso-portal",
    redirectUri: window.location.origin + "/",
    postLogoutRedirectUri: window.location.origin + "/",
    scope: "openid profile email",
    storagePrefix: "system1.sso",

    dashboardPath: "/api/system1/dashboard",
    adminPath: "/api/system1/admin/audit",

    dataTitle: "订单概览",
    dataSub: "由系统 1 后端返回，已通过 JWKS 验签、issuer 与 audience 校验。",
    tableTitle: "最近订单",
    businessScope: "订单接口",
    adminName: "订单审计",
    adminSub: "admin 角色可以读取订单审计日志；普通用户访问会得到 403。",

    theme: {
        accent: "#4f46e5",
        accentStrong: "#3730a3",
        accentSoft: "#eef2ff",
        accentBorder: "#c7d2fe",
        accentGradient: "linear-gradient(135deg, #17153f 0%, #312e81 46%, #4f46e5 100%)"
    }
};
