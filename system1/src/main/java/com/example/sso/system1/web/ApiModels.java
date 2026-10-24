package com.example.sso.system1.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 系统 1 对外返回的数据结构。
 * 前端会直接展示这些字段，用于证明“Token 确实被后端校验过”。
 */
public final class ApiModels {

    private ApiModels() {
    }

    /** 从已验签的 JWT 中提取出来的当前用户信息。 */
    public record UserView(
            String subject,
            String username,
            String name,
            String email,
            String department,
            String employeeNo,
            List<String> roles,
            String scope,
            String issuer,
            List<String> audience,
            Instant issuedAt,
            Instant expiresAt,
            String tokenId) {
    }

    /** 服务端实际执行的校验项，便于演示时逐条说明。 */
    public record SecurityChecks(
            String signature,
            String issuer,
            String audience,
            String expiry,
            String keyId) {
    }

    public record SystemDashboard(
            String system,
            String systemName,
            UserView user,
            SecurityChecks securityChecks,
            Map<String, Object> data,
            Instant serverTime) {
    }

    public record AdminResult(
            String system,
            String message,
            String requiredRole,
            List<String> yourRoles,
            List<Map<String, Object>> records,
            Instant serverTime) {
    }
}
