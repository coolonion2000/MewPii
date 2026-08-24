# pii

[pi coding agent](https://github.com/earendil-works/pi) 的 Web 界面，视觉风格对齐 [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh)，功能由 pi SDK 直接驱动。

## 功能

- **会话工作区**：按项目（cwd）分组浏览、搜索、继续、重命名、删除、导出 HTML 历史会话
- **完整对话体验**：流式输出、思考过程折叠、dsh 风格工具卡片（read/bash/edit/write/grep…）、Diff 高亮、图片附件（含剪贴板粘贴）
- **会话控制**：中断（abort）、介入（steer）、排队（follow-up）、压缩上下文（compact）
- **两种分支**：`分支` 从任意消息分叉为新会话文件；`编辑` 在当前会话内回到该消息重写
- **状态可见**：上下文占用百分比、token 统计、花费、运行状态
- **模型页**：Provider 鉴权状态、API Key 设置/退出、模型目录（推理/图像/上下文窗口标签）
- **资源页**：当前项目可见的技能（skills）、扩展（extensions）、提示模板
- **文件页**：项目文件浏览/预览/上传，Git 状态与 Diff 查看
- **中英文界面**：跟随浏览器语言，侧栏可切换；深色/浅色主题

## 开发

```bash
npm install
npm run dev        # server :31041 (tsx watch) + web :31042 (vite，代理 /api 与 /ws)
```

打开 http://127.0.0.1:31042 （Vite 开发服务器，支持 HMR）。

## 生产

```bash
npm run build
npm run start      # http://127.0.0.1:31041 ，后端直接伺服 web/dist
```

## 打包与部署

```bash
npm pack              # 生成 pii-<version>.tgz（含构建产物，全局安装即用）
docker build -t pii-web .   # 或构建 Docker 镜像
```

NAS 部署（群晖/威联通 Container Manager、compose、隧道拓扑）见 [docs/nas-deployment.md](docs/nas-deployment.md)。

## 远程访问

见 [docs/remote-access.md](docs/remote-access.md)。简要版：

```bash
PII_PASSWORD='强密码' npm run start -- --host 0.0.0.0 --port 31041
```

公网场景请叠加 HTTPS 隧道（cloudflared / Tailscale / 反向代理）。

## 架构

```
浏览器 (React SPA, dsh 设计 token)
   │  HTTP REST + WebSocket
   ▼
server (Node + tsx)
   │  pi SDK 进程内调用（createAgentSessionRuntime）
   ▼
pi agent（与本机 pi CLI 共享 ~/.pi 配置、凭证和会话文件）
```

- `server/src/session-host.ts` — 每个会话一个 `AgentSessionRuntime`，事件扇出到所有浏览器连接
- `server/src/index.ts` — REST（会话/模型/认证/文件/Git/资源）+ WS + 静态托管 + Basic Auth
- `web/src/theme.css` — 完整 dsh 设计 token（static 色板 + 明暗 alias 层）
- 与 pi CLI **共享同一份会话与配置**：在 pii 里的对话可以直接 `pi --resume` 继续，反之亦然

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方声明见 [NOTICE](NOTICE)。
