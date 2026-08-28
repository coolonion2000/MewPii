# MewPii

[pi coding agent](https://github.com/earendil-works/pi) 的 Web 控制台。
界面语言对齐 [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh)，功能由 pi SDK 直接驱动。

![MewPii](web/public/logo-wide-light.png)

## 功能

- **会话工作区**：按项目分组、搜索、收藏置顶、拖拽排序、重命名、删除、归档、导出（HTML / 含图 ZIP）、导入 JSONL
- **完整对话**：流式输出、思考过程、思考级别、dsh 风格工具卡片（Diff 高亮、实时输出）、图片附件与灯箱预览、乐观渲染（发送即显示）
- **会话控制**：中断（abort）、介入（steer）、排队（follow-up）、压缩上下文、克隆/分支/会话内回退编辑、轨迹时间线
- **模型管理**：Provider 主从列表、API Key / OAuth 登录（Codex 等）、自定义 Provider（models.json）、按模型过滤可用思考级别
- **工具与扩展**：工具集模式（off/read-only/default/full）、插件包安装/启停/逐文件过滤、技能增删、扩展 widget / 状态栏 / question 对话框（Web 弹窗）
- **文件与 Git**：项目文件浏览、预览（Markdown 渲染 / JSON 格式化 / highlight.js 语法高亮）、上传、Git 状态与 Diff、对话内文件路径点击右侧预览
- **实时同步**：pi CLI 与 Web 双向实时（目录监听 + 外部写入自动重载）
- **多语言与主题**：中文 / English、深色 / 浅色主题

## 三种部署形态

```
A. 单机        浏览器 ──▶ mewpii（UI + pi agent 同机）
B. 枢纽+agent  浏览器 ──▶ mewpii (NAS, hub) ◀── mewpii --agent (Mac / 办公机 / ...)
C. 纯 UI       浏览器 ──▶ mewpii --ui-only (NAS) ◀── mewpii --agent (各机器)
```

- **A 单机**：`mewpii --host 0.0.0.0`，UI 和 pi 在同一台机器
- **B 枢纽+agent**：NAS 上跑默认模式（同时可作 agent），其他机器 `--agent` 拨入，侧边栏可切换控制对象（多 agent 共存）
- **C 纯 UI**：`--ui-only`，NAS 只托管界面和隧道，完全不跑 pi

agent 主动出站连接，**不需要公网 IP / 内网穿透**。

## 快速开始

```bash
npm install
npm run dev        # server :31041 (tsx watch) + web :31042 (vite, 代理 /api 与 /ws)
```

打开 <http://127.0.0.1:31042> （Vite HMR）。

## 生产

```bash
npm run build
npm start          # http://127.0.0.1:31041
# 对外开放（必须带密码）
PII_PASSWORD='强密码' mewpii --host 0.0.0.0
```

## Docker / NAS

```bash
docker build -t coolonion2000/mewpii:latest .
docker run -d -p 31041:31041 -e PII_PASSWORD='强密码' \
  -v pii-state:/root/.pi coolonion2000/mewpii:latest
```

- 镜像：`coolonion2000/mewpii`（Docker Hub，linux/amd64）
- 绿联 UGOS / 群晖部署、隧道、HTTPS、多 agent：见 [docs/nas-deployment.md](docs/nas-deployment.md)
- 远程访问安全模型（Basic Auth + Cookie 会话 + Origin 校验）：[docs/remote-access.md](docs/remote-access.md)

## 命令

```
mewpii [options]
  --host, -H <host>     监听地址（默认 127.0.0.1）
  --port, -p <port>     端口（默认 31041）
  --password <pwd>      访问密码（用户 pi；绑非公网时必填）
  --ui-only             纯 UI + 隧道枢纽，不跑本机 pi
  --agent <url>         作为 agent 安全拨入枢纽，如 wss://nas.example/tunnel
  --name <name>         agent 显示名
  --token <token>       枢纽认证 token（默认取 PII_PASSWORD）
```

## 目录结构

```
server/src/index.ts        REST + WebSocket + 静态托管 + 登录认证 + 隧道枢纽
server/src/session-host.ts 每会话一个 AgentSessionRuntime，事件扇出、扩展 UI 桥
server/src/tunnel.ts       多 agent 注册表与 HTTP/WS 多路复用隧道
web/src/theme.css          dsh 设计 token（static 色板 + 明暗 alias 层 + 字阶）
web/src/components/        工作区 / 聊天 / 工具卡 / 模型 / 文件 / 设置
```

与 pi CLI **共享 `~/.pi`**（会话、凭证、技能、扩展、模型配置）：MewPii 里的对话可直接 `pi --resume` 继续，反之亦然。

## 许可证

MIT，见 [LICENSE](LICENSE)（Copyright © coolonion）。第三方声明见 [NOTICE](NOTICE)。
