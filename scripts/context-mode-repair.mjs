/**
 * Reproducible compatibility patch for context-mode 1.0.169.
 * Never run automatically: --check is read-only; --apply is deployment-only.
 * @author coolonion
 */
import { readFile, writeFile, copyFile, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "// mewpii-context-mode-cancellation-v1";
const FILES = ["build/adapters/pi/mcp-bridge.js", "build/executor.js", "build/server.js"];

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported context-mode source near: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

export function repairBridge(source) {
  let s = source;
  s = replaceOnce(s, "async execute(_toolCallId, params) {", "async execute(_toolCallId, params, signal) {");
  s = replaceOnce(s, "client.callTool(tool.name, params ?? {})", "client.callTool(tool.name, params ?? {}, signal)");
  s = replaceOnce(s, "async callTool(name, args) {", "async callTool(name, args, signal) {");
  s = replaceOnce(s, 'return this.request("tools/call", { name, arguments: args ?? {} }, Number.POSITIVE_INFINITY);', `// Honor long explicit execution budgets, but never leave a lost RPC pending forever.
        const requested = Number(args?.timeout);
        const budget = Number.isFinite(requested) && requested > 0 ? requested + 30_000 : 3_600_000;
        return this.request("tools/call", { name, arguments: args ?? {} }, Math.min(2_147_483_647, Math.max(60_000, budget)), signal);`);
  s = replaceOnce(s, "async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {", "async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal) {\n        signal?.throwIfAborted();");
  s = replaceOnce(s, 'if (!this.child)\n            throw new Error("MCP client not started");', 'signal?.throwIfAborted();\n        if (!this.child)\n            throw new Error("MCP client not started");');
  s = replaceOnce(s, "const id = ++this.requestId;", `const id = ++this.requestId;
        const cancel = (reason) => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            // The executor receives this request's signal, never another run's.
            try { this.notify("notifications/cancelled", { requestId: id, reason: "Cancelled by caller" }); } catch {}
            pending.reject(reason);
            this.diag(\x60[mewpii] mcp_request_cancelled request_id=\x24{id} method=\x24{method}\x60, "warn");
        };
        const onAbort = () => cancel(signal.reason ?? new DOMException("Aborted", "AbortError"));`);
  s = replaceOnce(s, `this.pending.delete(id);
                    reject(new Error(\x60MCP request timeout after \x24{timeoutMs}ms: \x24{method}\x60));`, `cancel(new Error(\x60MCP request timeout after \x24{timeoutMs}ms: \x24{method}\x60));`);
  s = replaceOnce(s, "resolve: (v) => {\n                    if (timer)", 'resolve: (v) => {\n                    signal?.removeEventListener("abort", onAbort);\n                    if (timer)');
  s = replaceOnce(s, "reject: (e) => {\n                    if (timer)", 'reject: (e) => {\n                    signal?.removeEventListener("abort", onAbort);\n                    if (timer)');
  s = replaceOnce(s, 'const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });', `signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) { onAbort(); return; }
            const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });`);
  s = replaceOnce(s, 'this.child.on("exit", () => this.onExit());\n        this.child.on("error", () => this.onExit());', `const child = this.child;
        child.on("exit", () => { if (this.child === child) this.onExit(); });
        child.on("error", () => { if (this.child === child) this.onExit(); });`);
  s = replaceOnce(s, "const child = this.child;\n        try {", "const child = this.child;\n        this.onExit(); // Reject pending calls before marking this generation shut down.\n        try {");
  return `${MARKER}\n${s}`;
}

const SPAWN_SETTLEMENT = `
            let resolved = false;
            let timedOut = false;
            let capExceeded = false;
            let forcedDrain = false;
            let timer, drainTimer;
            const stdoutChunks = [], stderrChunks = [];
            let totalBytes = 0;
            const cleanup = () => {
                clearTimeout(timer);
                clearTimeout(drainTimer);
                signal?.removeEventListener("abort", onAbort);
            };
            const finish = (exitCode, error, backgrounded = false) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                let stderr = Buffer.concat(stderrChunks).toString("utf-8");
                if (error) stderr += "\\n" + error.message;
                if (capExceeded) stderr += "\\n[output cap exceeded — process group killed]";
                if (forcedDrain) stderr += "\\n[output pipes did not close — capture ended; output may be incomplete]";
                if (signal?.aborted && !backgrounded) {
                    reject(signal.reason ?? new DOMException("Execution aborted", "AbortError"));
                    return;
                }
                res({ stdout: Buffer.concat(stdoutChunks).toString("utf-8"), stderr,
                    exitCode: timedOut && !backgrounded ? 1 : (exitCode ?? 1), timedOut,
                    ...(backgrounded ? { backgrounded: true } : {}) });
            };
            // 'exit' and 'close' are different: grandchildren can inherit pipes.
            // Waiting for close alone, even after SIGKILL, can hang forever.
            const boundDrain = (exitCode) => {
                if (drainTimer || resolved) return;
                drainTimer = setTimeout(() => {
                    if (resolved) return;
                    forcedDrain = true;
                    killTree(proc);
                    proc.stdout?.destroy();
                    proc.stderr?.destroy();
                    finish(exitCode);
                }, 1000);
            };
            const stopProcess = () => { killTree(proc); boundDrain(proc.exitCode); };
            const onAbort = () => {
                console.error(\x60[mewpii] execution_cancelled pid=\x24{proc.pid} language_process=\x24{spawnCmd}\x60);
                stopProcess();
            };
            const capture = (chunks, chunk) => {
                if (resolved) return;
                totalBytes += chunk.length;
                if (totalBytes <= this.#hardCapBytes) chunks.push(chunk);
                else if (!capExceeded) { capExceeded = true; stopProcess(); }
            };
            proc.stdout.on("data", chunk => capture(stdoutChunks, chunk));
            proc.stderr.on("data", chunk => capture(stderrChunks, chunk));
            proc.once("exit", code => boundDrain(code));
            proc.once("close", code => finish(code));
            proc.once("error", error => finish(1, error));
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
            if (timeout !== undefined) timer = setTimeout(() => {
                if (resolved) return;
                timedOut = true;
                if (background && !signal?.aborted) {
                    if (proc.pid) this.#backgroundedPids.add(proc.pid);
                    proc.unref();
                    // Keep draining detached processes without retaining their output.
                    for (const stream of [proc.stdout, proc.stderr]) {
                        stream.removeAllListeners("data");
                        stream.on("data", () => {});
                    }
                    finish(0, undefined, true);
                } else stopProcess();
            }, timeout);
`;

export function repairExecutor(source) {
  let s = source;
  s = `import { AsyncLocalStorage } from "node:async_hooks";\nexport const executionSignalContext = new AsyncLocalStorage();\n${s}`;
  s = replaceOnce(s, "async execute(opts) {", "async execute(opts) {\n        const signal = opts.signal ?? executionSignalContext.getStore();\n        signal?.throwIfAborted();");
  s = replaceOnce(s, "this.#compileAndRun(filePath, tmpDir, timeout)", "this.#compileAndRun(filePath, tmpDir, timeout, signal)");
  s = replaceOnce(s, "this.#spawn(cmd, cwd, tmpDir, timeout, background)", "this.#spawn(cmd, cwd, tmpDir, timeout, background, signal)");
  s = replaceOnce(s, "const { path: filePath, language, code, timeout } = opts;", "const { path: filePath, language, code, timeout, signal } = opts;");
  s = replaceOnce(s, "this.execute({ language, code: wrappedCode, timeout })", "this.execute({ language, code: wrappedCode, timeout, signal })");
  const start = s.indexOf("    async #compileAndRun(");
  const end = s.indexOf("    async #spawn(", start);
  if (start < 0 || end < 0) throw new Error("Unsupported executor compile method");
  s = s.slice(0, start) + `    async #compileAndRun(srcPath, cwd, timeout, signal) {
        const binPath = srcPath.replace(/\\.rs$/, "") + (isWin ? ".exe" : "");
        const compiled = await this.#spawn(["rustc", srcPath, "-o", binPath], cwd, cwd,
            timeout === undefined ? 60_000 : Math.min(timeout, 60_000), false, signal);
        if (compiled.exitCode !== 0) return compiled;
        return this.#spawn([binPath], cwd, cwd, timeout, false, signal);
    }
` + s.slice(end);
  s = replaceOnce(s, "async #spawn(cmd, cwd, sandboxTmpDir, timeout, background = false) {\n        return new Promise((res) => {", "async #spawn(cmd, cwd, sandboxTmpDir, timeout, background = false, signal) {\n        signal?.throwIfAborted();\n        return new Promise((res, reject) => {");
  const settlementStart = s.indexOf("            let timedOut = false;", s.indexOf("    async #spawn("));
  const settlementEnd = s.indexOf("\n        });\n    }\n    #buildSafeEnv", settlementStart);
  if (settlementStart < 0 || settlementEnd < 0) throw new Error("Unsupported executor settlement method");
  s = s.slice(0, settlementStart) + SPAWN_SETTLEMENT + s.slice(settlementEnd);
  return `${MARKER}\n${s}`;
}

export function repairServer(source) {
  let s = replaceOnce(source, 'import { PolyglotExecutor } from "./executor.js";', 'import { PolyglotExecutor, executionSignalContext } from "./executor.js";');
  s = replaceOnce(s, "return async (toolArgs) => {", "return async (toolArgs, extra) => {");
  s = replaceOnce(s, "return await handler(toolArgs);", "return await executionSignalContext.run(extra?.signal, () => {\n                extra?.signal?.throwIfAborted();\n                return handler(toolArgs, extra);\n            });");
  // Preserve the interpreter directive, if present.
  return s.replace("#!/usr/bin/env node\n", `#!/usr/bin/env node\n${MARKER}\n`);
}

export async function prepareRepair(packageRoot) {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "context-mode" || pkg.version !== "1.0.169") {
    throw new Error(`Expected context-mode 1.0.169, got ${pkg.name} ${pkg.version}; review patch before upgrading`);
  }
  const originals = await Promise.all(FILES.map(file => readFile(join(packageRoot, file), "utf8")));
  const patched = originals.map(s => s.includes(MARKER));
  if (patched.every(Boolean)) return { alreadyPatched: true, files: [] };
  if (patched.some(Boolean)) throw new Error("Partial patch detected; restore backups before retrying");
  const transforms = [repairBridge, repairExecutor, repairServer];
  return { alreadyPatched: false, files: FILES.map((file, i) => ({ file, content: transforms[i](originals[i]) })) };
}

export async function applyRepair(packageRoot) {
  // esbuild canonicalizes symlinks (including macOS /var -> /private/var).
  packageRoot = await realpath(packageRoot);
  const plan = await prepareRepair(packageRoot);
  if (plan.alreadyPatched) return plan;
  // Build in memory first: validation/bundling failures must not modify the installation.
  const { build } = await import("esbuild");
  const replacements = new Map(plan.files.map(f => [resolve(packageRoot, f.file), f.content]));
  const patchedModules = new Set();
  const bundled = await build({
    entryPoints: [join(packageRoot, "build/server.js")], bundle: true, platform: "node",
    target: "node18", format: "esm", write: false, minify: true,
    external: ["better-sqlite3", "turndown", "turndown-plugin-gfm", "@mixmark-io/domino"],
    plugins: [{ name: "mewpii-context-mode", setup(plugin) {
      plugin.onLoad({ filter: /\.js$/ }, args => {
        if (!replacements.has(args.path)) return;
        patchedModules.add(args.path);
        return { contents: replacements.get(args.path), loader: "js", resolveDir: resolve(args.path, "..") };
      });
    } }],
  });
  for (const file of ["build/server.js", "build/executor.js"]) {
    if (!patchedModules.has(join(packageRoot, file))) throw new Error(`Bundle did not include repaired module: ${file}`);
  }
  const files = [...plan.files, { file: "server.bundle.mjs", content: bundled.outputFiles[0].text }];
  for (const { file } of files) {
    const target = join(packageRoot, file);
    try { await stat(`${target}.mewpii-original`); throw new Error(`Backup already exists: ${target}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const { file } of files) await copyFile(join(packageRoot, file), join(packageRoot, `${file}.mewpii-original`));
  try {
    for (const { file, content } of files) await writeFile(join(packageRoot, file), content);
  } catch (error) {
    for (const { file } of files) await copyFile(join(packageRoot, `${file}.mewpii-original`), join(packageRoot, file));
    throw error;
  }
  return { ...plan, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, packageRoot] = process.argv.slice(2);
  if (!["--check", "--apply"].includes(mode) || !packageRoot) {
    throw new Error("Usage: node scripts/context-mode-repair.mjs --check|--apply /absolute/path/to/context-mode (apply only while affected runtimes are stopped)");
  }
  const result = await (mode === "--apply" ? applyRepair : prepareRepair)(resolve(packageRoot));
  console.log(JSON.stringify({ mode, packageRoot: resolve(packageRoot), alreadyPatched: result.alreadyPatched, files: result.files.map(f => f.file) }));
}
