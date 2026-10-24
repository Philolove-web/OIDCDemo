package com.example.sso.system1.config;

import java.util.Collection;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import com.example.sso.system1.web.RestAccessDeniedHandler;
import com.example.sso.system1.web.RestAuthenticationEntryPoint;

/**
 * 资源服务器安全配置。
 *
 * <p>关键点：</p>
 * <ul>
 *   <li>完全无状态：不创建 HttpSession，不设置登录页；</li>
 *   <li>只接受 {@code Authorization: Bearer <JWT>}；</li>
 *   <li>JWT 的签名、issuer、受众(aud) 由 Spring Security 自动校验；</li>
 *   <li>把 Keycloak 的 {@code realm_access.roles} 映射为 Spring 的 ROLE_* 权限。</li>
 * </ul>
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain apiSecurityFilterChain(HttpSecurity http,
                                               RestAuthenticationEntryPoint unauthorizedHandler,
                                               RestAccessDeniedHandler forbiddenHandler) throws Exception {
        http
                .cors(Customizer.withDefaults())
                // 纯 Token API，不需要 CSRF Token（浏览器不会自动携带 Bearer Token）
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(authorize -> authorize
                        // 系统自己的前端页面与静态资源公开；API 仍然必须携带 Bearer Token
                        .requestMatchers("/", "/index.html", "/config.js", "/assets/**", "/favicon.ico", "/error").permitAll()
                        .requestMatchers("/actuator/health", "/api/public/**").permitAll()
                        // 管理接口要求 Keycloak 中的 admin realm role
                        .requestMatchers(HttpMethod.GET, "/api/system1/admin/**").hasRole("admin")
                        .anyRequest().authenticated())
                .oauth2ResourceServer(oauth2 -> oauth2
                        .jwt(jwt -> jwt.jwtAuthenticationConverter(keycloakJwtConverter()))
                        .authenticationEntryPoint(unauthorizedHandler)
                        .accessDeniedHandler(forbiddenHandler));
        return http.build();
    }

    /**
     * 把 Keycloak 的 realm_access.roles 转换成 Spring Security 的 ROLE_xxx。
     * 例如 alice 的 ["user"] → ROLE_user；bob 的 ["user","admin"] → ROLE_user, ROLE_admin。
     */
    private JwtAuthenticationConverter keycloakJwtConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(SecurityConfig::realmRoles);
        converter.setPrincipalClaimName("preferred_username");
        return converter;
    }

    private static Collection<GrantedAuthority> realmRoles(Jwt jwt) {
        Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
        if (realmAccess == null || !(realmAccess.get("roles") instanceof Collection<?> roles)) {
            return List.of();
        }
        return roles.stream()
                .map(String::valueOf)
                .map(role -> (GrantedAuthority) new SimpleGrantedAuthority("ROLE_" + role))
                .toList();
    }

    /**
     * 只允许统一登录门户（http://localhost:3000）跨域调用。
     * Authorization 头会触发预检请求，因此必须显式声明 allowedHeaders。
     */
    @Bean
    CorsConfigurationSource corsConfigurationSource(
            @Value("${app.frontend-origin:http://localhost:3000}") String frontendOrigin) {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(List.of(frontendOrigin));
        configuration.setAllowedMethods(List.of("GET", "POST", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("Authorization", "Content-Type", "Accept"));
        configuration.setExposedHeaders(List.of("WWW-Authenticate"));
        configuration.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
