package com.example.sso.system2;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 系统 2（消息中心）—— 与系统 1 完全独立的 OAuth2 / OIDC 资源服务器。
 *
 * <p>两个系统之间没有任何共享代码或共享 Session，它们唯一的共同信任来源是
 * Keycloak 签发的 JWT：各自通过 JWKS 公钥离线验签，并校验 issuer 与 audience。</p>
 */
@SpringBootApplication
public class System2Application {

    public static void main(String[] args) {
        SpringApplication.run(System2Application.class, args);
    }
}
