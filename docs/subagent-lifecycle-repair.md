# 子任务运行态与工作流修复

本修复针对 pi-subagents 0.56.0。源码和补丁保存在 Pii 仓库；开发和测试不修改全局扩展，不写历史任务记录，不部署。

## 修复范围

- Web 从本项目实际加载的 Pi SDK 解析 CLI，子进程使用当前 Node + 绝对 CLI 路径，不依赖登录 shell 的 NVM PATH。显式 `PI_SUBAGENT_PI_BINARY` 保留优先级。
- 活跃的后台工作流拥有自己的 controller 时，`runSync` 在 supervisor 协调 detach 后继续等待真实终态，保留内存中的 JS continuation。交互式前台调用仍可立即返回 detach receipt，避免阻塞父模型回答 supervisor。停止信号仍传播给工作流拥有的子任务；终态清理仅执行一次。
- Web 通过独立 ResourceLoader EventBus 查询原生 foregroundControls / foregroundRuns / workflowControllers 的只读快照。不调用 status 命令，不触发 reconcile、模型轮次、恢复或重跑。按父会话路径、run ID 和 child index 关联。
- 沿用现有共享 REST 轮询（详情 3 秒、列表 5 秒），每次读取当前原生状态，不按日志新鲜度猜测正在运行。关闭详情和切换 Web 页面不影响任务本身。扩展卸载会移除桥接监听，无响应时回退到历史记录的保守判断。
- 旧 continuation 错误保留原始诊断，标注“子任务已交还结果 / 流程待恢复”。未核实需求验收时仅显示“执行结束”；仅最新 assistant 输出中完整、唯一的 acceptance-report 明确含 not-satisfied 时提示“报告未达成”，不根据工具输出或自然语言关键词判定失败。

## 明确边界

这不是跨进程 JS 栈持久化。进程退出后无法继续旧内存中的任意 JavaScript；历史 unsupported-continuation 不会自动修复，不允许自动重放脚本（可能重复提交、写文件或发送消息）。确认停机后再部署；部署只保证新运行走修复路径。没有原生实时证据的外部/旧会话继续保守显示待确认。

独立后台 async runner 的磁盘状态仍走原生状态文件；只读桥接不接管它的控制权。原有超时预算不调大，也不禁用。

## 检查与部署

以下 `<package-dir>` 是实际安装的 pi-subagents 包目录，通常位于用户 `.pi/agent/npm/node_modules/pi-subagents`。

只读预检：

```sh
node scripts/subagents-repair.mjs --check <package-dir>
```

**只有用户明确批准部署，且任务已收尾时**，才停止服务、应用兼容补丁、构建并重启：

```sh
node scripts/subagents-repair.mjs --apply <package-dir>
npm run build
```

补丁校验版本和精确源码锚点，保留 `.mewpii-v1.bak` 原文件；漂移则停止，禁止强行覆盖。重启前后再次 `--check`，验证 PID、31041 listener、health、新资源，以及真实任务从 supervisor 等待到返回结果的全过程。不要在任务仍执行时运行 apply 或覆盖 dist。

## 隔离验证

```sh
npx tsc -p server/tsconfig.json --noEmit
npx tsc -p web/tsconfig.json --noEmit
node --import tsx --test server/test/subagents-repair.test.mjs server/test/subagent-presentation.test.mjs web/test/subagent-run-state.test.mjs
```

兼容测试只在临时包副本应用补丁。使用真实工作流引擎和真实修复后的 runSync 协调层，替换最底层子进程执行，以可控终态验证 detach 后等待、继续一次、取消透传与清理单一所有权。它不等价于已部署真实模型验收；部署后仍需做真实任务 UI 验证。
