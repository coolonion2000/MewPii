# context-mode 停止与工具返回修复

适用版本：context-mode **1.0.169**。补丁保存在仓库，不直接手改全局 node_modules，也不通过增加 Pii 的 10 秒等待时间掩盖问题。

## 修复内容

- Pi 注册工具接收 `AbortSignal`，MCP 请求取消时发送 `notifications/cancelled`，释放对应 pending、计时器和监听器；已取消的请求不会再发出去，迟到结果不会复活请求。
- 服务端原来的 `wrapToolHandler` 会丢掉 MCP `extra`。补丁保留它，并通过请求级 `AsyncLocalStorage` 将 signal 传到 execute、execute_file、batch 和 Rust 编译/运行；并发调用互不取消。
- 执行器取消时终止自己创建的进程组，不扫描或终止其他会话的进程。正常退出后最多再等 1 秒排空输出；继承的 stdout/stderr 一直不关闭时终止该组并结束捕获，保留已有结果，标记输出可能不完整。显式 `background` 模式仍会保留后台进程。
- 显式工具预算外增加 30 秒协议余量，最少 60 秒；未设置预算时 RPC 兜底 1 小时。RPC 超时也会发送取消，不再无限占着会话。
- 修复 bridge shutdown 时 pending 不退出、旧进程退出事件误伤重建连接的问题。
- Pii 停止失败时保留活动工具和起始时间；不再错误显示成“等待模型”。实际工具结束事件或成功停止才清理状态。

## 当前故障的证据边界

用户这次 Maven 日志记录 2026-09-08 15:59:49 BUILD SUCCESS，但会话没有对应 toolResult。取消信号在 Pi 桥接和服务端包装器两处丢失已由代码及隔离实测确认。继承输出管道导致不返回已构造回归并修复；现有运行进程没有保存足够的阶段日志，不能证明它就是这次结果未返回的唯一触发点。

## 部署（必须等用户允许）

不要在任务运行中执行 `--apply`，不要热替换插件，也不要仅刷新页面就宣称旧调用已恢复。

1. 在 Pii 仓库安装好开发依赖后执行只读检查：

   ```sh
   node scripts/context-mode-repair.mjs --check /absolute/path/to/context-mode
   ```

2. 用户授权维护窗口后，先停止受该插件影响的运行实例，再执行：

   ```sh
   node scripts/context-mode-repair.mjs --apply /absolute/path/to/context-mode
   ```

   脚本先校验版本与代码锚点、在内存中重新打包并确认修复模块进入 bundle，全部成功后才写入。四个目标文件均保存 `.mewpii-original` 备份。写失败会尝试恢复备份；版本或部分补丁不匹配时拒绝继续。

3. 构建并启动 Pii，验证临时会话里的长工具停止及其他会话继续输出。仓库提交、Pii 构建、插件补丁应用和运行验证是不同步骤，不能互相替代。

插件升级可能覆盖补丁，新版本需重新审查；脚本不会向未知版本强套补丁。回滚需在停机状态将四个 `.mewpii-original` 备份恢复到原文件。

## 隔离验证

```sh
node --test server/test/context-mode-repair.test.mjs
```

测试只复制插件到新临时目录并在那里应用补丁。使用临时 HOME、工作目录和独立 MCP 子进程，不请求模型、不重启现有服务、不修改真实会话。默认从用户 `.pi/agent/npm/node_modules/context-mode` 读取，可用 `MEWPII_CONTEXT_MODE_ROOT` 指定另一份安装。未安装时该集成测试会明确跳过。

`server/test/stop-pending.test.mjs` 验证停止超时后保留真实工具状态，以及成功重试后的清理。运行服务器测试前需要编译；有服务运行时必须将编译产物写入独立临时目录，不能使用会覆盖 `server/dist` 的默认 test/build 命令。
