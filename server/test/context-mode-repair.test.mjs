/** Isolated copies only: never patch or restart the installed plugin. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareRepair, applyRepair } from "../../scripts/context-mode-repair.mjs";

const installed = process.env.MEWPII_CONTEXT_MODE_ROOT ?? join(homedir(), ".pi/agent/npm/node_modules/context-mode");
let available = true;
try { await access(join(installed, "package.json")); } catch { available = false; }
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error("condition did not settle");
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("context-mode repair: actual MCP cancellation, concurrent isolation and executor pipe settlement", { skip: !available, timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-context-repair-"));
  const pkg = join(root, "context-mode");
  const work = join(root, "work");
  const testHome = join(root, "home");
  let bridge;
  const ownedPids = new Set();
  try {
    await mkdir(pkg);
    await mkdir(work);
    await mkdir(join(testHome, ".pi"), { recursive: true });
    await cp(join(installed, "build"), join(pkg, "build"), { recursive: true });
    await cp(join(installed, "package.json"), join(pkg, "package.json"));
    await cp(join(installed, "server.bundle.mjs"), join(pkg, "server.bundle.mjs"));
    // Keep testing the upstream regression after the real deployment is patched.
    for (const file of ["build/adapters/pi/mcp-bridge.js", "build/executor.js", "build/server.js", "server.bundle.mjs"]) {
      try { await cp(join(installed, `${file}.mewpii-original`), join(pkg, file)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await symlink(join(installed, "node_modules"), join(pkg, "node_modules"));
    const before = await readFile(join(installed, "build/adapters/pi/mcp-bridge.js"), "utf8");
    const plan = await prepareRepair(pkg);
    assert.equal(plan.files.length, 3);
    await applyRepair(pkg);
    assert.equal((await prepareRepair(pkg)).alreadyPatched, true);
    assert.equal((await applyRepair(pkg)).alreadyPatched, true);
    assert.equal(await readFile(join(installed, "build/adapters/pi/mcp-bridge.js"), "utf8"), before);
    const { bootstrapMCPTools, MCPStdioClient } = await import(pathToFileURL(join(pkg, "build/adapters/pi/mcp-bridge.js")));
    const { PolyglotExecutor } = await import(pathToFileURL(join(pkg, "build/executor.js")));
    const definitions = new Map();
    bridge = await bootstrapMCPTools({ registerTool: def => definitions.set(def.name, def) }, join(pkg, "server.bundle.mjs"), {
      _resolveJsRuntime: () => process.execPath,
      env: { PATH: process.env.PATH, HOME: testHome, TMPDIR: root, PI_CONFIG_DIR: join(testHome, ".pi"),
        CONTEXT_MODE_PROJECT_DIR: work, CONTEXT_MODE_BRIDGE_IDLE_MS: "0" },
    });

    await t.test("registered ctx_execute accepts abort; kills only the cancelled process group", async () => {
      const controller = new AbortController();
      const pidFile = join(work, "cancel.pid");
      const running = definitions.get("ctx_execute").execute("cancel", {
        language: "javascript", timeout: 30_000,
        code: `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
      }, controller.signal);
      // Observe rejections immediately, including failures before the PID is published.
      const outcome = running.then(value => ({ value }), error => ({ error }));
      await until(async () => { try { return Boolean(await readFile(pidFile, "utf8")); } catch { return false; } });
      const pid = Number(await readFile(pidFile, "utf8"));
      ownedPids.add(pid);
      const other = definitions.get("ctx_execute").execute("other", {
        language: "javascript", timeout: 5000,
        code: "await new Promise(r=>setTimeout(r,400)); console.log('other-session-result');",
      }, new AbortController().signal);
      controller.abort();
      const stopped = await outcome;
      assert.equal(stopped.error?.name, "AbortError");
      assert.match(JSON.stringify(await other), /other-session-result/);
      await until(() => !alive(pid));
      ownedPids.delete(pid);
      assert.equal(bridge.client.pending.size, 0);
    });

    await t.test("already aborted requests never reach the server", async () => {
      const controller = new AbortController();
      controller.abort();
      const id = bridge.client.requestId;
      await assert.rejects(bridge.client.callTool("ctx_execute", { language: "javascript", code: "throw Error('must not run')" }, controller.signal), { name: "AbortError" });
      assert.equal(bridge.client.requestId, id);
    });

    await t.test("file and batch executors receive the same per-request cancellation", async () => {
      for (const name of ["ctx_execute_file", "ctx_batch_execute"]) {
        const controller = new AbortController();
        const pidFile = join(work, `${name}.pid`);
        const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`;
        const input = join(work, "input.txt");
        await writeFile(input, "fixture");
        const script = join(work, `${name}.cjs`);
        await writeFile(script, code);
        const args = name === "ctx_execute_file"
          ? { path: input, language: "javascript", code, timeout: 30_000 }
          : { commands: [{ label: "cancel-me", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }], queries: ["fixture"], timeout: 30_000, cwd: work };
        let earlyResult;
        const outcome = definitions.get(name).execute(name, args, controller.signal)
          .then(value => (earlyResult = { value }), error => (earlyResult = { error }));
        await until(async () => {
          if (earlyResult) throw new Error(`${name} ended before publishing pid: ${earlyResult.error?.stack ?? JSON.stringify(earlyResult.value)}`);
          try { return Boolean(await readFile(pidFile, "utf8")); } catch { return false; }
        });
        const pid = Number(await readFile(pidFile, "utf8"));
        ownedPids.add(pid);
        controller.abort();
        assert.equal((await outcome).error?.name, "AbortError");
        await until(() => !alive(pid));
        ownedPids.delete(pid);
      }
    });

    await t.test("lost RPC times out, sends cancellation and frees pending entries", async () => {
      const client = new MCPStdioClient("unused");
      client.child = {}; // No subprocess: exercise the real request bookkeeping.
      const frames = [];
      client.writeFrame = frame => frames.push(JSON.parse(frame));
      await assert.rejects(client.request("tools/call", {}, 20), /timeout/);
      assert.equal(client.pending.size, 0);
      assert.equal(frames[1].method, "notifications/cancelled");
      assert.equal(frames[1].params.requestId, frames[0].id);
      client.onData(Buffer.from(JSON.stringify({ id: frames[0].id, result: {} }) + "\n"));
      assert.equal(client.pending.size, 0, "late result resurrected cancelled request");
    });

    await t.test("bridge shutdown rejects pending calls even before the child exits", async () => {
      const client = new MCPStdioClient("unused");
      client.child = { kill() {}, exitCode: 0, signalCode: null };
      client.writeFrame = () => true;
      const pending = client.request("tools/call", {}, 10_000);
      const rejected = assert.rejects(pending, /MCP server exited/);
      client.shutdown();
      await rejected;
      assert.equal(client.pending.size, 0);
    });

    await t.test("finished command cannot hang forever on inherited output pipes", async () => {
      const executor = new PolyglotExecutor({ projectRoot: work, runtimes: { javascript: process.execPath } });
      const started = Date.now();
      const result = await executor.execute({ language: "javascript", timeout: 10_000,
        code: `const child=require('child_process').spawn(${JSON.stringify(process.execPath)}, ['-e','setInterval(()=>{},1000)'], {stdio:['ignore',1,2]}); console.log('DESCENDANT:'+child.pid); child.unref(); console.log('BUILD SUCCESS');`,
      });
      const pid = Number(result.stdout.match(/DESCENDANT:(\d+)/)?.[1]);
      if (pid) ownedPids.add(pid);
      assert.match(result.stdout, /BUILD SUCCESS/);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /pipes did not close/);
      assert.ok(Date.now() - started < 4000);
      await until(() => !alive(pid));
      ownedPids.delete(pid);
    });

    await t.test("explicit process timeout settles and a subsequent execution still works", async () => {
      const executor = new PolyglotExecutor({ projectRoot: work, runtimes: { javascript: process.execPath } });
      const result = await executor.execute({ language: "javascript", timeout: 100, code: "setInterval(()=>{},1000)" });
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 1);
      const next = await executor.execute({ language: "javascript", code: "console.log('next-ok')" });
      assert.equal(next.exitCode, 0);
      assert.match(next.stdout, /next-ok/);
    });

    await t.test("intentional background detachment still works", async () => {
      const executor = new PolyglotExecutor({ projectRoot: work, runtimes: { javascript: process.execPath } });
      const result = await executor.execute({ language: "javascript", timeout: 200, background: true,
        code: "console.log(process.pid); setInterval(()=>{},1000)" });
      const pid = Number(result.stdout.trim());
      ownedPids.add(pid);
      assert.equal(result.backgrounded, true);
      assert.ok(alive(pid));
      executor.cleanupBackgrounded();
      await until(() => !alive(pid));
      ownedPids.delete(pid);
    });

    await t.test("version drift refuses modification", async () => {
      const file = join(pkg, "package.json");
      const metadata = JSON.parse(await readFile(file, "utf8"));
      metadata.version = "future";
      await writeFile(file, JSON.stringify(metadata));
      await assert.rejects(prepareRepair(pkg), /review patch/);
    });
  } finally {
    bridge?.shutdown();
    for (const pid of ownedPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
