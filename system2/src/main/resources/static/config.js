/**
 * 系统 2 · 消息中心 前端配置。
 *
 * 与统一门户共用 Keycloak 的 sso-portal 公开客户端（Demo 简化），
 * 但使用自己的 redirect URI 和 sessionStorage 前缀。
 */
window.SYSTEM_CONFIG = {
    systemId: "system2",
    systemName: "系统 2",
    systemFullName: "系统 2 · 消息中心",
    subtitle: "消息中心",
    mark: "S2",

    landingSystemCaption: "系统 2 · 消息中心",
    landingTitle: "每一条消息，",
    landingHighlight: "都发给对的人。",
    landingLead: "系统 2 是独立的 Spring Boot 资源服务器，只处理属于你的消息。它和系统 1 零共享代码、零共享 Session，只共享对 Keycloak 公钥的信任。",

    portalUrl: "http://localhost:3000/",
    issuer: "http://localhost:8080/realms/sso-demo",
    clientId: "sso-portal",
    redirectUri: window.location.origin + "/",
    postLogoutRedirectUri: window.location.origin + "/",
    scope: "openid profile email",
    storagePrefix: "system2.sso",

    dashboardPath: "/api/system2/dashboard",
    adminPath: "/api/system2/admin/console",

    dataTitle: "消息概览",
    dataSub: "由系统 2 后端返回，已通过 JWKS 验签、issuer 与 audience 校验。",
    tableTitle: "最近消息",
    businessScope: "消息接口",
    adminName: "消息管理台",
    adminSub: "admin 角色可以读取消息管理台；普通用户访问会得到 403。",

    theme: {
        accent: "#0d9488",
        accentStrong: "#115e59",
        accentSoft: "#f0fdfa",
        accentBorder: "#99f6e4",
        accentGradient: "linear-gradient(135deg, #042f2e 0%, #115e59 46%, #0d9488 100%)"
    }
};
