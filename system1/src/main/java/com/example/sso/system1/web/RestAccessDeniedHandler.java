package com.example.sso.system1.web;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Token 合法但权限不足（例如 alice 访问 admin 接口）时返回 JSON 403。
 */
@Component
public class RestAccessDeniedHandler implements AccessDeniedHandler {

    private final ObjectMapper objectMapper;

    public RestAccessDeniedHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response,
                       AccessDeniedException accessDeniedException) throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setCharacterEncoding("UTF-8");
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);

        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        List<String> roles = authentication == null ? List.of() : authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(authority -> authority.startsWith("ROLE_"))
                .map(authority -> authority.substring("ROLE_".length()))
                .toList();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "forbidden");
        body.put("message", "身份已认证，但当前用户缺少访问该资源所需的角色");
        body.put("requiredRole", "admin");
        body.put("yourRoles", roles);
        body.put("path", request.getRequestURI());
        body.put("timestamp", Instant.now().toString());
        objectMapper.writeValue(response.getWriter(), body);
    }
}
