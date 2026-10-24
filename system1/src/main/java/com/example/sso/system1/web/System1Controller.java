package com.example.sso.system1.web;

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
 * 系统 1 的业务接口。
 *
 * <p>所有接口都要求携带 Access Token；Spring Security 在进入 Controller 之前
 * 已经完成签名、issuer、audience、有效期校验，Controller 里直接信任 JWT 即可。</p>
 */
@RestController
@RequestMapping("/api/system1")
public class System1Controller {

    private static final Logger log = LoggerFactory.getLogger(System1Controller.class);

    private final String systemId;
    private final String systemName;

    public System1Controller(@Value("${app.system-id}") String systemId,
                             @Value("${app.system-name}") String systemName) {
        this.systemId = systemId;
        this.systemName = systemName;
    }

    /**
     * 任何拥有 user 或 admin 角色的已认证用户都可以访问。
     */
    @GetMapping("/dashboard")
    @PreAuthorize("hasAnyRole('user', 'admin')")
    public ApiModels.SystemDashboard dashboard(@AuthenticationPrincipal Jwt jwt) {
        log.info("system1 dashboard: sub={}, username={}, roles={}",
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
                orderData(jwt.getClaimAsString("preferred_username")),
                Instant.now());
    }

    /**
     * 只有 admin 角色可以访问，用于演示“认证 ≠ 授权”。
     * alice 访问时会得到 403，bob 访问时得到 200。
     */
    @GetMapping("/admin/audit")
    @PreAuthorize("hasRole('admin')")
    public ApiModels.AdminResult audit(@AuthenticationPrincipal Jwt jwt) {
        log.info("system1 admin audit: sub={}, roles={}", jwt.getSubject(), roles(jwt));

        return new ApiModels.AdminResult(
                systemId,
                "已通过 Keycloak 的 admin 角色校验，成功读取审计日志",
                "admin",
                roles(jwt),
                List.of(
                        Map.of("id", "AUD-001", "action", "导出订单明细", "operator", "bob", "result", "成功", "time", "09:12"),
                        Map.of("id", "AUD-002", "action", "修改结算规则", "operator", "bob", "result", "成功", "time", "10:36"),
                        Map.of("id", "AUD-003", "action", "删除测试订单", "operator", "bob", "result", "已拒绝", "time", "11:02")),
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

    private static Map<String, Object> orderData(String username) {
        return Map.of(
                "owner", Objects.toString(username, "unknown"),
                "stats", List.of(
                        Map.of("label", "今日订单", "value", "128", "unit", "笔", "trend", "+12.4%"),
                        Map.of("label", "待处理", "value", "26", "unit", "笔", "trend", "-4.1%"),
                        Map.of("label", "本月 GMV", "value", "128.6", "unit", "万元", "trend", "+8.6%")),
                "orders", List.of(
                        Map.of("orderNo", "SO-2026-0001", "customer", "华东制造", "amount", "¥12,800", "status", "已支付"),
                        Map.of("orderNo", "SO-2026-0002", "customer", "北辰零售", "amount", "¥6,420", "status", "待发货"),
                        Map.of("orderNo", "SO-2026-0003", "customer", "云栖科技", "amount", "¥23,000", "status", "已完成")));
    }
}
