# 远程访问 pii web

pii web 驱动的是一个拥有 bash/文件读写权限的完整 coding agent。**永远不要**在没有认证和加密的情况下把它暴露到公网。

## 内置安全机制

| 机制 | 说明 |
| --- | --- |
| `PII_PASSWORD` / `--password` | HTTP Basic Auth（用户名固定 `pi`）。HTTP 与 WebSocket 都会校验 |
| 回环保护 | 默认只监听 `127.0.0.1`；绑非回环地址时**必须**设置密码，否则拒绝启动 |
| 路径沙箱 | 文件/Git API 限制在传入的 `cwd` 子树内 |

Basic Auth 是明文凭证（HTTP 下可被窃听），所以公网访问必须叠加 HTTPS 或加密隧道。

## 方案 A：Cloudflare Quick Tunnel（最快，零配置）

适合临时分享/外出访问：

```bash
PII_PASSWORD='足够长的随机密码' npm run start -- --host 127.0.0.1
cloudflared tunnel --url http://127.0.0.1:31041
```

cloudflared 会输出一个 `https://<随机>.trycloudflare.com` 地址，浏览器打开后输入用户名 `pi` 和密码即可。Quick Tunnel 域名每次变化，长期使用请改用 Named Tunnel。

## 方案 B：Tailscale / WireGuard（推荐长期使用）

机器加入 tailnet 后，直接通过 Tailscale IP 或 MagicDNS 域名访问：

```bash
PII_PASSWORD='...' npm run start -- --host 100.x.y.z   # 绑 tailnet 地址
```

流量全程 WireGuard 加密，不暴露到公网。

## 方案 C：反向代理 + HTTPS（自有域名）

```bash
PII_PASSWORD='...' npm run start -- --host 127.0.0.1
```

Caddy 示例：

```caddyfile
pii.example.com {
    reverse_proxy 127.0.0.1:31041
}
```

nginx 示例（注意 WebSocket 头）：

```nginx
server {
    listen 443 ssl;
    server_name pii.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:31041;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # 长时间运行的 agent 需要
    }
}
```

## 部署到服务器

```bash
# 在目标机器上
git clone <这个仓库> && cd Pii
npm install
npm run build
PII_PASSWORD='...' npm run start        # 生产模式：后端直接伺服前端构建产物
```

systemd unit（可选）：

```ini
[Unit]
Description=pii web
After=network.target

[Service]
WorkingDirectory=/opt/Pii
Environment=PII_PASSWORD=换成强密码
Environment=PII_HOST=127.0.0.1
Environment=PII_PORT=31041
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
