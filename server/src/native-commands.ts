/** Pi built-ins share the same UI bridge as extension commands. @author coolonion */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getPackageDir, ModelSelectorComponent, ProjectTrustStore, SessionManager, SessionSelectorComponent,
  TreeSelectorComponent, UserMessageSelectorComponent,
  type AgentSession, type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { CustomUiFactory } from "./custom-ui-bridge.js";
import type { UiRequest, SessionSnapshot } from "./protocol.js";
import { createPiSettings } from "./pi-settings-ui.js";

export const NATIVE_COMMANDS = {
  settings: "Pi 原生设置", model: "搜索、选择模型", tree: "浏览会话树、切换分支",
  thinking: "选择思考级别", "scoped-models": "设置模型循环范围", export: "导出 HTML / JSONL",
  import: "导入 JSONL 会话", share: "分享为 GitHub 私密 Gist", copy: "复制最后一条助手回复",
  name: "设置会话名", session: "会话信息和用量", changelog: "Pi 更新记录", hotkeys: "快捷键说明",
  fork: "从历史用户消息分叉", clone: "复制当前会话", trust: "项目信任设置",
  login: "登录模型提供商", logout: "退出模型提供商", new: "新建会话",
  compact: "压缩上下文，可附加指令", resume: "选择并恢复会话", reload: "重新加载插件、技能、提示词和设置",
  quit: "关闭当前 Web 会话连接",
} as const;

export const WEB_BUILTIN_SLASH_COMMANDS: SessionSnapshot["slashCommands"] = Object.entries(NATIVE_COMMANDS)
  .map(([name, description]) => ({ name, description, source: "builtin" }));

export interface NativeCommandContext {
  assertCanReplace(): void;
  session: AgentSession;
  runtime: AgentSessionRuntime;
  ui<T>(request: Omit<UiRequest, "id">): Promise<T>;
  custom<T>(factory: CustomUiFactory<T>): Promise<T | undefined>;
}
export interface NativeCommandData { output: string; editorText?: string; action?: "quit" }
const cancelled = (): NativeCommandData => ({ output: "已取消。" });
const exec = promisify(execFile);
function filePath(cwd: string, path: string) {
  const unquoted = path.replace(/^(["'])(.*)\1$/, "$2");
  return resolve(cwd, unquoted.startsWith("~/") ? join(homedir(), unquoted.slice(2)) : unquoted);
}

/** Undefined means a built-in handled by SessionHost, or a dynamically discovered extension. */
export async function runNativeCommand(name: string, arg: string, ctx: NativeCommandContext): Promise<NativeCommandData | undefined> {
  const { session: s, runtime, ui, custom } = ctx;
  const select = (title: string, options: string[]) => ui<string | undefined>({ kind: "select", title, options });
  const output = (text: string): NativeCommandData => ({ output: text });
  switch (name) {
    case "settings":
      await custom<void>((_tui, _theme, _keys, done) => createPiSettings(s, done));
      return output("设置已关闭，修改已自动保存。终端显示选项用于 Pi TUI；Web 使用自己的页面布局。");
    case "model": {
      const selected = await custom<{ model: NonNullable<AgentSession["model"]>; persist: boolean } | undefined>((tui, _theme, _keys, done) =>
        new ModelSelectorComponent(tui as unknown as ConstructorParameters<typeof ModelSelectorComponent>[0],
          s.model, s.modelRuntime, s.scopedModels, model => done({ model, persist: false }), () => done(undefined), arg || undefined,
          model => done({ model, persist: true })));
      if (!selected) return cancelled();
      await s.setModel(selected.model, { persist: selected.persist });
      return output(`已切换模型：${selected.model.provider}/${selected.model.id}`);
    }
    case "thinking": {
      const levels = s.getAvailableThinkingLevels();
      const level = arg || await select("思考级别", levels);
      if (!level) return cancelled();
      if (!levels.includes(level as typeof levels[number])) throw new Error(`支持的思考级别：${levels.join(", ")}`);
      s.setThinkingLevel(level as typeof levels[number], { persist: !arg });
      return output(`思考级别：${s.thinkingLevel}`);
    }
    case "scoped-models": {
      const models = s.modelRuntime.getAvailableSnapshot();
      let ids = new Set((s.scopedModels.length ? s.scopedModels.map(item => item.model) : models).map(m => `${m.provider}/${m.id}`));
      while (true) {
        const labels = models.map(m => `${ids.has(`${m.provider}/${m.id}`) ? "✓" : "○"} ${m.provider}/${m.id}`);
        const answer = await select("模型循环范围 · 点击切换", [...labels, "保存为默认", "完成"]);
        if (!answer || answer === "完成") return output("已更新当前会话的模型范围。");
        if (answer === "保存为默认") {
          s.settingsManager.setEnabledModels([...ids]);
          return output("已保存默认模型范围。");
        }
        const index = labels.indexOf(answer);
        if (index < 0) continue;
        const id = `${models[index].provider}/${models[index].id}`;
        if (ids.has(id)) { if (ids.size === 1) continue; ids.delete(id); } else ids.add(id);
        s.setScopedModels(models.filter(m => ids.has(`${m.provider}/${m.id}`)).map(model => ({ model, thinkingLevel: s.thinkingLevel })));
      }
    }
    case "tree": {
      if (!s.sessionManager.getTree().length) return output("当前会话尚无节点。");
      const id = await custom<string | undefined>((_tui, _theme, _keys, done) =>
        new TreeSelectorComponent(s.sessionManager.getTree(), s.sessionManager.getLeafId(), 30, done,
          () => done(undefined), (id, label) => s.sessionManager.appendLabelChange(id, label),
          undefined, s.settingsManager.getTreeFilterMode()));
      if (!id) return cancelled();
      const mode = await select("切换分支", ["直接切换", "汇总当前分支后切换"]);
      if (!mode) return cancelled();
      ctx.assertCanReplace();
      const result = await s.navigateTree(id, { summarize: mode === "汇总当前分支后切换" });
      return result.cancelled ? cancelled() : { output: "已切换分支。", editorText: result.editorText };
    }
    case "fork":
    case "clone": {
      let id = s.sessionManager.getLeafId();
      if (name === "fork") {
        const messages = s.getUserMessagesForForking();
        if (!messages.length) return output("当前会话尚无可分叉的用户消息。");
        id = await custom<string | undefined>((_tui, _theme, _keys, done) => {
          const component = new UserMessageSelectorComponent(messages.map(m => ({ id: m.entryId, text: m.text })), done, () => done(undefined));
          return { render: width => component.render(width), invalidate: () => component.invalidate(),
            handleInput: data => component.getMessageList().handleInput(data) };
        }) ?? null;
      }
      if (!id) return cancelled();
      ctx.assertCanReplace();
      const result = await runtime.fork(id, { position: name === "clone" ? "at" : "before" });
      return result.cancelled ? cancelled() : { output: name === "clone" ? "已复制会话。" : "已分叉会话。", editorText: result.selectedText };
    }
    case "resume": {
      const path = arg ? filePath(runtime.cwd, arg) : await custom<string | undefined>((tui, _theme, keys, done) =>
        new SessionSelectorComponent(
          progress => SessionManager.list(runtime.cwd, undefined, progress),
          progress => SessionManager.listAll(progress), done, () => done(undefined), () => done(undefined),
          () => tui.requestRender(), { keybindings: keys }, s.sessionFile));
      if (!path) return cancelled();
      ctx.assertCanReplace();
      const result = await runtime.switchSession(path);
      return result.cancelled ? cancelled() : output("已恢复会话。");
    }
    case "import": {
      let temporary: string | undefined;
      try {
        let path = arg && filePath(runtime.cwd, arg);
        if (!path) {
          const file = await ui<{ name: string; content: string } | undefined>({ kind: "file", title: "导入 Pi 会话（JSONL，最大 16 MiB）" });
          if (!file) return cancelled();
          if (typeof file.content !== "string" || Buffer.byteLength(file.content) > 16 * 1024 * 1024)
            throw new Error("导入文件超过 16 MiB；大文件请使用 /import <服务器路径>。");
          temporary = await mkdtemp(join(tmpdir(), "mewpii-import-"));
          path = join(temporary, "session.jsonl");
          await writeFile(path, file.content, { mode: 0o600 });
        }
        ctx.assertCanReplace();
        const result = await runtime.importFromJsonl(path);
        return result.cancelled ? cancelled() : output("已导入会话。");
      } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    }
    case "export": {
      if (arg) {
        const path = filePath(runtime.cwd, arg);
        const result = path.endsWith(".jsonl") ? s.exportToJsonl(path) : await s.exportToHtml(path);
        return output(`已导出：${result}`);
      }
      const format = await select("导出会话", ["HTML", "JSONL"]);
      if (!format) return cancelled();
      const temporary = await mkdtemp(join(tmpdir(), "mewpii-export-"));
      try {
        const filename = `pi-session-${s.sessionId}.${format === "JSONL" ? "jsonl" : "html"}`;
        const path = join(temporary, filename);
        if (format === "JSONL") s.exportToJsonl(path); else await s.exportToHtml(path);
        if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("导出超过 32 MiB，请使用 /export <服务器路径> 保存大文件。");
        const content = await readFile(path, "utf8");
        const saved = await ui<boolean>({ kind: "download", title: "下载会话", filename, content });
        return saved ? output(`已下载：${filename}`) : cancelled();
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    case "copy": {
      const content = s.getLastAssistantText();
      if (!content) return output("还没有可复制的助手回复。");
      const copied = await ui<boolean>({ kind: "copy", title: "复制最后一条助手回复", content });
      return copied ? output("已复制到剪贴板。") : cancelled();
    }
    case "share": {
      const confirmed = await ui<boolean>({ kind: "confirm", title: "分享当前会话到 GitHub", message: "将上传完整会话 HTML 为 Secret Gist。持有链接的人均可查看，其中可能包含代码、工具输出和敏感内容。确认上传？" });
      if (!confirmed) return cancelled();
      const temporary = await mkdtemp(join(tmpdir(), "mewpii-share-"));
      try {
        const path = await s.exportToHtml(join(temporary, "session.html"));
        const { stdout } = await exec("gh", ["gist", "create", path, "--desc", "Pi session"], { timeout: 60_000 });
        return output(`已分享为 Secret Gist：${stdout.trim()}`);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    case "trust": {
      const choice = await select(`项目信任：${runtime.cwd}`, ["信任此项目", "不信任此项目", "清除已保存决定"]);
      if (!choice) return cancelled();
      const decision = choice === "清除已保存决定" ? null : choice === "信任此项目";
      new ProjectTrustStore(runtime.services.agentDir).set(runtime.cwd, decision);
      // Match Pi: trust changes govern future sessions, not already running extension code.
      return output("已保存项目信任决定，下次打开该项目时生效。");
    }
    case "changelog":
      return output(await readFile(join(getPackageDir(), "CHANGELOG.md"), "utf8"));
    case "hotkeys":
      return output("Web：Enter 发送；Shift+Enter 换行；输入 / 打开命令；↑↓ 选择；Tab 补全；Esc 关闭。\nPi 原生交互窗口：↑↓ 导航、Enter 确认、Esc 返回；组件底部会显示对应快捷键。\n完整 Pi 终端快捷键：\n" + (await readFile(join(getPackageDir(), "docs", "keybindings.md"), "utf8")));
    case "quit": return { output: "已关闭当前窗口的会话连接；重新选择会话即可恢复。", action: "quit" };
    default: return undefined;
  }
}
