package com.example.sso.system1.web;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 公开的探活接口：不需要 Token，前端可用它判断系统是否在线。
 */
@RestController
@RequestMapping("/api/public")
public class PublicInfoController {

    private final String systemId;
    private final String systemName;

    public PublicInfoController(@Value("${app.system-id}") String systemId,
                                @Value("${app.system-name}") String systemName) {
        this.systemId = systemId;
        this.systemName = systemName;
    }

    @GetMapping("/info")
    public Map<String, Object> info() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("system", systemId);
        body.put("name", systemName);
        body.put("status", "UP");
        body.put("authRequired", true);
        body.put("serverTime", Instant.now());
        return body;
    }
}
