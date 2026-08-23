# NAS 部署指南

pii 自带完整的 pi agent（SDK 内置），部署机器上**不需要**单独安装 pi。

## 方式一：Docker（推荐，群晖/威联通 Container Manager 通用）

```bash
git clone <这个仓库> && cd Pii
docker build -t pii-web .
docker run -d --name pii \
  -p 31041:31041 \
  -e PII_PASSWORD='你的强密码' \
  -v pii-pi-state:/root/.pi \
  pii-web
```

打开 `http://<NAS-IP>:31041`，用户名 `pi` + 密码。

或 compose：`PII_PASSWORD='...' docker compose up -d --build`

**重要路径说明**：
- 容器里 pi 的状态在 `/root/.pi`（会话、凭证、设置）——务必挂卷持久化，否则重建容器会丢会话
- pi 的工作目录（cwd）是容器内路径；agent 的 bash/文件工具操作的是容器文件系统。要让 agent 操作 NAS 上的真实项目，把项目目录挂进去：
  ```bash
  -v /volume1/code:/code   # 然后在 pii 里用 /code/xxx 作为项目目录
  ```

## 方式二：裸机 Node（NAS 装了 Node 22.19+ 的话）

```bash
# 从源码
git clone <仓库> && cd Pii
npm ci && npm run build
PII_PASSWORD='...' node server/bin/pii-web.js --host 0.0.0.0

# 或从打包产物
npm pack                       # 生成 pii-0.1.0.tgz
# 传到 NAS 后：
npm install -g pii-0.1.0.tgz   # 自动装 pi SDK 依赖
PII_PASSWORD='...' pii-web --host 0.0.0.0
```

## 首次使用：NAS 上的模型鉴权

NAS 上的 `~/.pi` 是全新的。进 pii 的 设置 → 模型，给 Provider 填 API Key 或 OAuth 登录即可（都在网页里完成）。
也可以把你 Mac 的 `~/.pi/agent/auth.json` 和 `models.json` 复制进容器卷直接复用。

## 想让 NAS 上的界面控制你 Mac 的 pi？

pi 的 RPC 是 stdio，不能跨网络直连。拓扑是：**pii 服务端必须跑在 pi 所在的机器上**。所以：

1. Mac 上跑 pii：`npm start`（或开发模式 `npm run dev`）
2. NAS 只做转发层——反向代理 / frp / cloudflared / Tailscale 把 Mac 的 31041 暴露出去
3. 浏览器访问 NAS 的入口地址即可

细节见 [remote-access.md](remote-access.md)。

如果确实要「UI 在 NAS、agent 在 Mac」的分离架构（pii-agent 桥接模式），可以做但属于独立特性，先按上面的代理方案用，有强需求再提。
