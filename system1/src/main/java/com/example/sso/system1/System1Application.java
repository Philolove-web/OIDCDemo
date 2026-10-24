package com.example.sso.system1;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 系统 1（订单中心）—— OAuth2 / OIDC 资源服务器。
 *
 * <p>它不负责登录，只负责校验统一认证中心签发的 Access Token（JWT），
 * 校验内容包括：RS256 签名、iss、exp、nbf 与 aud。</p>
 */
@SpringBootApplication
public class System1Application {

    public static void main(String[] args) {
        SpringApplication.run(System1Application.class, args);
    }
}
