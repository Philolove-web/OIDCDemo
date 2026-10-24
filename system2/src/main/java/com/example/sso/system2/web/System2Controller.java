package com.example.sso.system2.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 系统 2 的业务接口。
 */
@RestController
@RequestMapping("/api/system2")
public class System2Controller {

    private static final Logger log = LoggerFactory.getLogger(System2Controller.class);

    private final String systemId;
    private final String systemName;

    public System2Controller(@Value("${app.system-id}") String systemId,
                             @Value("${app.system-name}") String systemName) {
        this.systemId = systemId;
        this.systemName = systemName;
    }

    @GetMapping("/dashboard")
    @PreAuthorize("hasAnyRole('user', 'admin')")
    public ApiModels.SystemDashboard dashboard(@AuthenticationPrincipal Jwt jwt) {
        log.info("system2 dashboard: sub={}, username={}, roles={}",
                jwt.getSubject(), jwt.getClaimAsString("preferred_username"), roles(jwt));

        return new ApiModels.SystemDashboard(
                systemId,
                systemName,
                toUserView(jwt),
                new ApiModels.SecurityChecks(
                        "RS256 签名校验通过（JWKS 公钥验签）",
                        "iss = " + Objects.toString(jwt.getIssuer(), "n/a") + "，与配置一致",
                        "aud 包含 " + systemId,
                        "exp 未过期，剩余 " + remainingSeconds(jwt) + " 秒",
                        String.valueOf(jwt.getHeaders().get("kid"))),
                messageData(jwt.getClaimAsString("preferred_username")),
                Instant.now());
    }

    /**
     * 只有 admin 角色可以访问，用于演示同一枚 Token 在两个系统中的授权差异。
     */
    @GetMapping("/admin/console")
    @PreAuthorize("hasRole('admin')")
    public ApiModels.AdminResult console(@AuthenticationPrincipal Jwt jwt) {
        log.info("system2 admin console: sub={}, roles={}", jwt.getSubject(), roles(jwt));

        return new ApiModels.AdminResult(
                systemId,
                "已通过 Keycloak 的 admin 角色校验，成功读取消息中心管理台",
                "admin",
                roles(jwt),
                List.of(
                        Map.of("id", "MSG-ADM-001", "action", "全员公告推送", "operator", "bob", "scope", "全体用户", "time", "08:30"),
                        Map.of("id", "MSG-ADM-002", "action", "创建消息模板", "operator", "bob", "scope", "财务通知", "time", "10:05"),
                        Map.of("id", "MSG-ADM-003", "action", "下线旧通道", "operator", "bob", "scope", "短信通道 A", "time", "11:20")),
                Instant.now());
    }

    private static ApiModels.UserView toUserView(Jwt jwt) {
        return new ApiModels.UserView(
                jwt.getSubject(),
                jwt.getClaimAsString("preferred_username"),
                jwt.getClaimAsString("name"),
                jwt.getClaimAsString("email"),
                jwt.getClaimAsString("department"),
                jwt.getClaimAsString("employee_no"),
                roles(jwt),
                jwt.getClaimAsString("scope"),
                Objects.toString(jwt.getIssuer(), null),
                jwt.getAudience(),
                jwt.getIssuedAt(),
                jwt.getExpiresAt(),
                jwt.getId());
    }

    private static List<String> roles(Jwt jwt) {
        Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
        if (realmAccess == null || !(realmAccess.get("roles") instanceof List<?> list)) {
            return List.of();
        }
        return list.stream().map(String::valueOf).toList();
    }

    private static long remainingSeconds(Jwt jwt) {
        Instant expiresAt = jwt.getExpiresAt();
        return expiresAt == null ? 0 : Math.max(0, expiresAt.getEpochSecond() - Instant.now().getEpochSecond());
    }

    private static Map<String, Object> messageData(String username) {
        return Map.of(
                "owner", Objects.toString(username, "unknown"),
                "stats", List.of(
                        Map.of("label", "未读消息", "value", "12", "unit", "条", "trend", "+2"),
                        Map.of("label", "今日推送", "value", "3,480", "unit", "条", "trend", "+6.2%"),
                        Map.of("label", "到达率", "value", "99.2", "unit", "%", "trend", "+0.3%")),
                "messages", List.of(
                        Map.of("from", "财务共享中心", "subject", "10 月报销截止提醒", "level", "重要", "time", "10:24"),
                        Map.of("from", "HR 服务台", "subject", "年度体检预约已开放", "level", "普通", "time", "09:48"),
                        Map.of("from", "统一认证平台", "subject", "新设备登录提醒", "level", "安全", "time", "09:02")));
    }
}
