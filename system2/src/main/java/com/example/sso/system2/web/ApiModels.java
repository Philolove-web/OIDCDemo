package com.example.sso.system2.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 系统 2 的响应模型。
 */
public final class ApiModels {

    private ApiModels() {
    }

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
