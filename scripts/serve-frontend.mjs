#!/usr/bin/env node
/**
 * 零依赖的静态文件服务器，用于托管 frontend/。
 *
 * 用法：
 *   node scripts/serve-frontend.mjs
 *   PORT=3000 node scripts/serve-frontend.mjs
 *
 * 之所以单独起一个 3000 端口的静态站点，而不是把页面塞进 Spring Boot，
 * 是为了让“统一登录门户”与两个业务系统保持独立部署的边界。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'frontend');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

const server = http.createServer((request, response) => {
    try {
        const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        let pathname = decodeURIComponent(requestUrl.pathname);
        if (pathname === '/') pathname = '/index.html';

        const filePath = path.resolve(ROOT, `.${pathname}`);
        if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Forbidden');
            return;
        }

        fs.stat(filePath, (error, stats) => {
            if (error || !stats.isFile()) {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Not found');
                return;
            }
            const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
            response.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            fs.createReadStream(filePath).pipe(response);
        });
    } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(`Server error: ${error.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`统一登录门户已启动: http://localhost:${PORT}/`);
    console.log(`静态目录: ${ROOT}`);
});
