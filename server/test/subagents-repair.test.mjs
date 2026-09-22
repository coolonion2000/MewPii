/** Isolated native compatibility and continuation tests. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import {
  repairExecution,
  repairSpawn,
  planRepair,
  applyRepair,
} from "../../scripts/subagents-repair.mjs";
import { configureSubagentCli } from "../src/pi-runtime.ts";
import {
  runtimeSnapshot,
  registerRuntimeBridge,
} from "../../scripts/compat/subagent-runtime-bridge.ts";
import {
  bindSubagentRuntime,
  readSubagentRuntime,
} from "../src/subagent-runtime.ts";

const nativeRoot =
  process.env.MEWPII_TEST_SUBAGENTS_ROOT ??
  join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const nativeAvailable = existsSync(join(nativeRoot, "package.json"));
const nativeOptions = { skip: !nativeAvailable };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

// Node cannot type-strip .ts files under node_modules, so a direct `import()` of the native
// extension source is refused. Transpile in place to a sibling .mjs (keeping import.meta.url so
// the module still resolves its own package deps, e.g. acorn) and import that, then clean up.
async function importNativeTs(absTsPath) {
  const source = await readFile(absTsPath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const tempPath = join(
    dirname(absTsPath),
    `.mewpii-test-${basename(absTsPath)}.${process.pid}.mjs`,
  );
  await writeFile(tempPath, js);
  try {
    return await import(pathToFileURL(tempPath));
  } finally {
    await rm(tempPath, { force: true });
  }
}

test("Web resolves the hosted CLI even with a LaunchAgent PATH, preserving explicit executable overrides", () => {
  const env = { PATH: "/usr/bin:/bin" };
  const script = configureSubagentCli(env);
  assert.ok(script.endsWith("/dist/bundle/cli.js"));
  assert.ok(existsSync(script));
  assert.equal(env.PI_SUBAGENT_PI_SCRIPT, script);
  assert.equal(
    configureSubagentCli({ PI_SUBAGENT_PI_BINARY: "/custom/pi" }),
    undefined,
  );
  assert.throws(
    () => configureSubagentCli({ PI_SUBAGENT_PI_SCRIPT: "relative.js" }),
    /absolute/,
  );
});

test("read-only snapshot covers live detached children, terminal results, and isolates parent sessions", () => {
  const child = {
    index: 0,
    status: "completed",
    sessionFile: "/child.jsonl",
    updatedAt: 20,
  };
  const state = {
    foregroundRuns: new Map([
      [
        "c",
        { runId: "c", sessionId: "parent", updatedAt: 20, children: [child] },
      ],
    ]),
    foregroundControls: new Map([
      [
        "c",
        {
          runId: "c",
          sessionId: "parent",
          updatedAt: 30,
          activeChildren: new Map([
            [
              0,
              {
                index: 0,
                currentActivityState: "needs_attention",
                currentTool: "contact_supervisor",
                updatedAt: 30,
              },
            ],
          ]),
        },
      ],
    ]),
    asyncJobs: new Map([["w", { sessionId: "parent", updatedAt: 30 }]]),
    workflowControllers: new Map([["w", new AbortController()]]),
  };
  const before = structuredClone({
    runs: [...state.foregroundRuns],
    controls: [...state.foregroundControls],
  });
  assert.equal(runtimeSnapshot(state, "other", 40).rows.length, 0);
  assert.equal(
    runtimeSnapshot(state, "parent", 40).rows[0].state,
    "needs_attention",
  );
  state.foregroundControls.get("c").activeChildren.get(0).currentActivityState =
    "working";
  assert.equal(runtimeSnapshot(state, "parent", 41).rows[0].state, "running");
  state.foregroundControls.delete("c");
  assert.equal(runtimeSnapshot(state, "parent", 42).rows[0].state, "completed");
  assert.deepEqual([...state.foregroundRuns], before.runs);
  state.workflowControllers.get("w").abort();
  assert.equal(
    runtimeSnapshot(state, "parent", 43).rows.find((r) => r.runId === "w")
      .state,
    "stopping",
  );
});

test("bridge can read a snapshot without tool execution; disposal does not leave stale status", () => {
  const listeners = new Map();
  const bus = {
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
    emit(name, value) {
      listeners.get(name)?.(value);
    },
  };
  const state = {
    foregroundControls: new Map([
      [
        "c",
        {
          runId: "c",
          sessionId: "parent",
          updatedAt: 1,
          activeChildren: new Map([[0, { index: 0 }]]),
        },
      ],
    ]),
    asyncJobs: new Map(),
  };
  const dispose = registerRuntimeBridge(bus, state);
  const loader = {};
  bindSubagentRuntime(loader, bus);
  assert.equal(readSubagentRuntime(loader, "parent")[0].state, "running");
  assert.deepEqual(readSubagentRuntime(loader, "foreign"), []);
  dispose();
  assert.deepEqual(readSubagentRuntime(loader, "parent"), []);
});

async function patchedRunSync(completion) {
  const original = await readFile(
    join(nativeRoot, "src/runs/foreground/execution.ts"),
    "utf8",
  );
  const patched = original.includes("// mewpii-subagents-lifecycle-v1")
    ? original
    : repairExecution(original);
  const wrapper = patched.slice(
    patched.indexOf("export async function runSync("),
  );
  const js = ts.transpileModule(wrapper, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports = {};
  new Function(
    "exports",
    "runSyncCompletion",
    "isAgentContractV1",
    "redactResultPrompt",
    "persistSingleResultMetadata",
    js,
  )(
    exports,
    completion,
    () => false,
    (value) => value,
    () => {},
  );
  return exports.runSync;
}

test(
  "detached child preserves workflow continuation; same launch completes exactly once",
  nativeOptions,
  async () => {
    const done = deferred();
    const detached = deferred();
    let callbacks = 0,
      launches = 0,
      receipts = 0;
    const runSync = await patchedRunSync(
      (_cwd, _agents, _name, _task, options) => {
        launches++;
        assert.equal(
          options.onDetachReceipt({
            agent: "worker",
            exitCode: 0,
            detached: true,
            detachedReason: "intercom coordination",
          }),
          true,
        );
        detached.resolve();
        return done.promise;
      },
    );
    const { runWorkflowScript } = await importNativeTs(
      join(nativeRoot, "src/workflows/scripted-workflow.ts"),
    );
    const result = runWorkflowScript({
      script:
        'const r = await runs.run("impl", {agent:"worker",task:"test"}); return "continued:" + r.output;',
      timeoutMs: 5000,
      launch: async () => {
        const r = await runSync("/isolated", [], "worker", "test", {
          runId: "child",
          awaitDetachedCompletion: true,
          onWorkflowDetach: (receipt) => {
            assert.equal(receipt.detached, true);
            receipts++;
          },
          onDetachedExit: () => callbacks++,
        });
        return {
          key: "impl",
          runId: "child",
          ok: r.exitCode === 0,
          output: r.finalOutput,
          artifactPaths: [],
        };
      },
    });
    await detached.promise;
    let settled = false;
    result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    done.resolve({ agent: "worker", exitCode: 0, finalOutput: "done" });
    assert.equal((await result).value, "continued:done");
    assert.equal(launches, 1);
    assert.equal(
      receipts,
      1,
      "wait subscriptions retain an observable detached child",
    );
    assert.equal(
      callbacks,
      0,
      "terminal cleanup belongs to the awaiting executor, not both paths",
    );
  },
);

test(
  "workflow stop still reaches detached execution; ordinary foreground detach still releases caller",
  nativeOptions,
  async () => {
    for (const retain of [true, false]) {
      const done = deferred();
      let forwarded;
      let callbacks = 0;
      const runSync = await patchedRunSync(
        (_cwd, _agents, _name, _task, options) => {
          forwarded = options.signal;
          options.onDetachReceipt({
            agent: "worker",
            exitCode: 0,
            detached: true,
            detachedReason: "intercom coordination",
          });
          return done.promise;
        },
      );
      const controller = new AbortController();
      const result = runSync("/isolated", [], "worker", "test", {
        runId: "child",
        signal: controller.signal,
        awaitDetachedCompletion: retain,
        onDetachedExit: () => callbacks++,
      });
      if (!retain) assert.equal((await result).detached, true);
      controller.abort();
      assert.equal(forwarded.aborted, retain);
      done.resolve({
        agent: "worker",
        exitCode: retain ? 1 : 0,
        interrupted: retain,
      });
      await result;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(callbacks, retain ? 0 : 1);
    }
  },
);

test(
  "native patch validates all inputs and is idempotent on an isolated package copy",
  nativeOptions,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mewpii-subagents-test-"));
    try {
      const before = await planRepair(nativeRoot);
      await cp(nativeRoot, dir, {
        recursive: true,
        filter: (src) => !src.includes("/node_modules/", nativeRoot.length),
      });
      await applyRepair(dir);
      assert.deepEqual(await planRepair(dir), []);
      for (const file of [
        "src/runs/shared/pi-spawn.ts",
        "src/runs/foreground/execution.ts",
        "src/runs/foreground/subagent-executor.ts",
        "src/extension/index.ts",
      ]) {
        const result = ts.transpileModule(
          await readFile(join(dir, file), "utf8"),
          {
            reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
          },
        );
        assert.equal(
          result.diagnostics?.filter(
            (d) => d.category === ts.DiagnosticCategory.Error,
          ).length,
          0,
          file,
        );
      }
      const { getPiSpawnCommand } = await import(
        pathToFileURL(join(dir, "src/runs/shared/pi-spawn.ts"))
      );
      const env = { PATH: "/usr/bin:/bin" };
      const cli = configureSubagentCli(env);
      assert.deepEqual(getPiSpawnCommand(["--version"], { env }), {
        command: process.execPath,
        args: [cli, "--version"],
      });
      const command = getPiSpawnCommand(["--version"], { env });
      const probe = spawnSync(command.command, command.args, {
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.match(probe.stdout, /\d+\.\d+\.\d+/);
      assert.deepEqual(
        await planRepair(nativeRoot),
        before,
        "live extension must remain untouched",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("supervisor reply clears remembered attention without inventing a new child run", () => {
  const state = {
    foregroundRuns: new Map([
      [
        "c",
        {
          runId: "c",
          sessionId: "parent",
          updatedAt: 30,
          children: [
            {
              index: 0,
              status: "detached",
              activityState: "needs_attention",
              updatedAt: 30,
            },
          ],
        },
      ],
    ]),
    foregroundControls: new Map([
      [
        "c",
        {
          runId: "c",
          sessionId: "parent",
          updatedAt: 20,
          activeChildren: new Map([[0, { index: 0, updatedAt: 20 }]]),
        },
      ],
    ]),
    asyncJobs: new Map(),
  };
  assert.equal(
    runtimeSnapshot(state, "parent").rows[0].state,
    "needs_attention",
  );
  state.foregroundRuns.get("c").children[0].activityState = undefined;
  const rows = runtimeSnapshot(state, "parent").rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, "c");
  assert.equal(rows[0].state, "running");
});
