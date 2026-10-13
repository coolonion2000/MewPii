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

前端构建不会清空 `web/dist/assets`：保留最近 **3 个不同构建**及退役不足 **14 天**的资源和压缩副本，保护已打开页面的懒加载。旧资源只在下一次成功构建时清理；首次启用时，已有未登记资源获得完整 14 天宽限期。当前构建的所有输出（包括动态导入、CSS、图片和 public 资源）受清单保护。过期后仍长期打开旧页面，可能需要刷新；这不保证无限期保留旧版本，也不是硬性磁盘配额。全新 Docker 镜像不包含上一镜像的产物，这个保留窗口仅适用于复用同一构建目录的更新。

清理预览默认只读，不会改动文件：

```bash
node scripts/retain-web-assets.mjs --root /absolute/path/to/Pii/web/dist --dry-run
```

确认预览后可显式使用 `--apply`；清单损坏或当前资源缺失时拒绝清理。压缩脚本会复用未改变资源的 `.br/.gz`，不再每次重新压缩全部历史版本。

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

## Web 中的 Pi 命令

聊天框输入 `/` 可搜索全部 23 个 Pi 内置命令，以及当前加载的扩展命令、提示词和技能。
`/settings`、`/model`、`/tree`、`/fork`、`/resume` 复用 Pi 原生组件，按上下键、Enter、Esc 操作；
插件的 `select`、`confirm`、`input`、`editor` 和 `custom` 统一经 Web 交互桥处理，无需逐插件开发页面。

- `/export` 选择 HTML / JSONL 后下载；`/export <服务器路径>` 保存到服务器。浏览器下载上限 32 MiB。
- `/import` 选择本地 JSONL（最大 16 MiB）；更大的文件使用 `/import <服务器路径>`。
- `/copy` 通过浏览器按钮写入当前设备剪贴板；`/share` 确认后用服务器的 `gh` 登录上传 Secret Gist。
- `/quit` 关闭当前浏览器会话连接；重新选择会话可恢复。
- 设置中的终端外观选项会保存到 Pi 配置，Web 页面仍使用自身的布局和主题。

全局和项目资源目录里的插件、技能、提示词，以及包配置发生变化后，会提示资源待重载，不再自动执行完整重载，避免阻塞同一服务中的其他会话。
Web 托管会话默认使用 pi-lens 的 `quick` 启动模式，跳过启动时的慢工具探测、语言分析、预安装和全量扫描；不卸载插件或禁用工具。需要原先完整预热时可设置 `PI_LENS_STARTUP_MODE=full`，显式配置优先。
macOS LaunchAgent 应配置 `<key>ProcessType</key><string>Interactive</string>`：Web/agent 直接服务用户请求，不应使用会限制 CPU/I/O 的 `Background` 类型。修改 plist 后需重新加载 launchd 定义（仅 `kickstart` 不会重新读取配置）；重载会中断当前任务，应在获准的维护窗口执行。
Pi 0.85.1 的扩展工厂缓存通过安装/构建脚本按工作目录隔离，最多保留 8 个目录、每目录 128 个工厂；会话实例仍独立。`/reload` 会清除缓存。SDK 升级时补丁会拒绝未知版本，需重新审查适配；模块导入及工厂初始化耗时会输出到服务日志。
请在任务空闲时手动执行 `/reload`。加载成功的命令会更新到已有页面，无需重启 Web；加载失败可查看通知并重试。会话文件的外部写入同步不受此调整影响。
已加载包的入口文件也会被监控。仅修改包内部依赖文件时可手动 `/reload`。
扩展直接操作进程终端或替换整个 TUI 编辑器的能力仍需要插件提供 Web 兼容交互。

### 会话状态、投递回执与耗时诊断

- 连接建立、插件初始化、会话就绪、运行/压缩、重连及服务无响应分别显示；断线后的旧运行快照不再作为实时运行依据。停止成功仍须服务端确认。
- 消息携带独立投递 ID。断线/回执超时显示“待确认”，自动重连及手动查询只查询原回执，不重发；明确拒绝才恢复原草稿。编辑器已有内容时保留“追加恢复草稿”入口，不覆盖正在编辑的内容；多条待确认消息各自可查询。“已接收”不是模型任务完成。
- 同一浏览器标签页刷新/切换会话保留待确认 ID 与 SHA-256 指纹，不在回执存储中保存消息或图片内容。服务端回执为内存数据：每会话最多 4,096 条、24 小时保留；重启/过期后为未知结果，需要核对历史，不会自动重放。浏览器每会话最多 64 条、合计 256 条待确认记录，满后拒绝新增而不丢弃去重依据。存储不可用时只保证当前页面内保留。
- 启动日志按 `key`/`session_id` 关联 `scheduling_wait_ms`、`open`、`extensions`、`resources`、`runtime_restore`、`bind`、`ready_total`；`created` 只代表 host 已建立，不代表插件已就绪。阶段有重叠，不能将所有耗时直接相加。
- 全部模型提供商记录 `request_started`、`first_content`、`request_completed`，区分首事件与首段实际文本/思考/工具参数（`first_event_ms`、`first_content_ms`），没有输出时为 `null`。命令排队超过 100 ms 记录 `command_queue_wait`，带投递 ID、不打印消息正文；日志不包含请求密钥。
- 模型上下文压缩与网页聊天记录分离：页面读取持久化的当前分支历史，不用压缩后的模型上下文替换聊天记录。默认优先展示最近 50 条可见对话（用户/助手消息，工具结果不占配额）。近期快照批次预算为 4 MiB、最多 400 条原始记录；超预算的单条消息仍完整保留以推进分页，其余近期记录在就绪后分批自动补齐，不必逐次点击“加载更早”。后台补齐失败会暂停，仍可手动加载，不阻塞发送。
- 同一分支的快照通过消息重叠或经分页位置核对的前驱消息 ID 续接已加载历史；切换分支不会混入旧分支尾部。长会话仍按窗口展开，流式更新复用已完成历史的窗口及工具依赖计算；主动展开全部历史仍会增加 DOM，这不是无限历史虚拟化。启动快照日志含 `visible_messages`、`recent_target`、`recent_shortfall`，区分字节/记录预算导致的分页与实际上下文压缩。

## 目录结构

```
server/src/index.ts        REST + WebSocket + 静态托管 + 登录认证 + 隧道枢纽
server/src/session-host.ts 每会话一个 AgentSessionRuntime，事件扇出、扩展 UI 桥
server/src/tunnel.ts       多 agent 注册表与 HTTP/WS 多路复用隧道
web/src/theme.css          dsh 设计 token（static 色板 + 明暗 alias 层 + 字阶）
web/src/components/        工作区 / 聊天 / 工具卡 / 模型 / 文件 / 设置
```

与 pi CLI **共享 `~/.pi`**（会话、凭证、技能、扩展、模型配置）：MewPii 里的对话可直接 `pi --resume` 继续，反之亦然。

## 内置终端

点击左下角“文件”旁的终端图标，在右侧底部打开当前项目的交互式 shell。拖动上边缘可调整高度。

- `─` 收起面板，命令继续运行；切换会话或文件页保留同一个终端。
- `×` 关闭终端并结束进程；再次打开时使用当前项目目录。
- 刷新页面、关闭浏览器标签或连接断开会结束该终端，不自动恢复命令。
- 终端在当前选中的本机或远程 agent 上运行，使用该服务用户的 shell 和权限。

## 许可证

MIT，见 [LICENSE](LICENSE)（Copyright © coolonion）。第三方声明见 [NOTICE](NOTICE)。
