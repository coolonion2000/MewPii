import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function waitForServerPort(child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited early (${child.exitCode})\n${logs.join("")}`);
    const match = logs.join("").match(
      /MewPii listening on http:\/\/127\.0\.0\.1:(\d+)/,
    );
    if (match) {
      const port = Number(match[1]);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return port;
      } catch {
        // Listen can be observable before the first accepted request.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`server did not start\n${logs.join("")}`);
}

function sessionLines(id, cwd, count) {
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    },
  ];
  let parentId = null;
  for (let index = 0; index < count; index++) {
    const entryId = `${id}-${index}`;
    entries.push({
      type: "message",
      id: entryId,
      parentId,
      timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `message ${index}` }],
      },
    });
    parentId = entryId;
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function collectStartup(url) {
  const ws = new WebSocket(url);
  const frames = [];
  const startedAt = performance.now();
  const ready = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket startup timed out")), 10_000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      frames.push({ message, at: performance.now() - startedAt });
      if (
        (message.type === "snapshot" || message.type === "session_ready") &&
        message.snapshot.initializing === false
      ) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
  });
  return { ws, frames, ready };
}

test(
  "cold session preview reaches every viewer and preserves legacy readiness",
  { timeout: 30_000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "mewpii-preview-ws-"));
    const home = join(temp, "home");
    const workspace = join(temp, "workspace");
    const sessions = join(home, ".pi", "agent", "sessions", "project");
    const extensions = join(home, ".pi", "agent", "extensions");
    const modernFile = join(sessions, "modern.jsonl");
    const legacyFile = join(sessions, "legacy.jsonl");
    await mkdir(workspace, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await mkdir(extensions, { recursive: true });
    await writeFile(modernFile, sessionLines("modern", workspace, 70));
    await writeFile(legacyFile, sessionLines("legacy", workspace, 60));
    await writeFile(
      join(extensions, "slow-start.js"),
      `export default function (pi) {
  pi.on("session_start", async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  });
}\n`,
    );

    const logs = [];
    const child = spawn(
      process.execPath,
      ["server/dist/index.js", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          PII_PASSWORD: "",
          PII_WORKSPACE_ROOTS: temp,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr.on("data", (chunk) => logs.push(String(chunk)));

    const sockets = [];
    try {
      const port = await waitForServerPort(child, logs);
      const modernUrl = `ws://127.0.0.1:${port}/ws?snapshotDelta=1&cwd=${encodeURIComponent(workspace)}&session=${encodeURIComponent(modernFile)}`;
      const first = collectStartup(modernUrl);
      const second = collectStartup(modernUrl);
      sockets.push(first.ws, second.ws);
      await Promise.all([first.ready, second.ready]);

      for (const client of [first, second]) {
        const preview = client.frames.find(({ message }) => message.type === "snapshot");
        assert.ok(preview, "one concurrent viewer missed the startup preview");
        assert.equal(preview.message.snapshot.initializing, true);
        assert.equal(preview.message.snapshot.pagingProvisional, true);
        assert.equal(preview.message.snapshot.messages.length, 50);
        assert.equal(preview.message.snapshot.totalMessages, 50);
        const ready = client.frames.find(
          ({ message }) => message.type === "session_ready",
        );
        assert.ok(ready, "delta-capable viewer did not receive readiness metadata");
        assert.equal(ready.message.snapshot.totalMessages, 70);
        assert.equal(ready.message.snapshot.historyFrom, 20);
        assert.equal(ready.message.snapshot.pagingProvisional, false);
        assert.equal(preview.at < ready.at, true);
      }

      const history = new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("history timed out")), 5_000);
        first.ws.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type !== "history" || message.requestId !== "older") return;
          clearTimeout(timeout);
          resolvePromise(message);
        });
      });
      first.ws.send(
        JSON.stringify({ type: "history", before: 20, requestId: "older" }),
      );
      const older = await history;
      assert.equal(older.before, 0);
      assert.equal(older.messages.length, 20);
      assert.equal(older.messages[0]._entryId, "modern-0");

      const legacyUrl = `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}&session=${encodeURIComponent(legacyFile)}`;
      const legacy = collectStartup(legacyUrl);
      sockets.push(legacy.ws);
      await legacy.ready;
      assert.equal(legacy.frames[0].message.type, "snapshot");
      assert.equal(legacy.frames[0].message.snapshot.pagingProvisional, true);
      assert.equal(
        legacy.frames.some(({ message }) => message.type === "session_ready"),
        false,
      );
      const final = legacy.frames.find(
        ({ message }) =>
          message.type === "snapshot" && message.snapshot.initializing === false,
      );
      assert.ok(final, "legacy viewer never received a complete snapshot");
      assert.equal(final.message.snapshot.totalMessages, 60);
      assert.equal(final.message.snapshot.historyFrom, 10);
    } finally {
      for (const ws of sockets) ws.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "an append between restore and watcher installation is reloaded",
  { timeout: 30_000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "mewpii-watch-window-"));
    const home = join(temp, "home");
    const workspace = join(temp, "workspace");
    const sessions = join(home, ".pi", "agent", "sessions", "project");
    const extensions = join(home, ".pi", "agent", "extensions");
    const file = join(sessions, "watch-window.jsonl");
    await mkdir(workspace, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await mkdir(extensions, { recursive: true });
    await writeFile(file, sessionLines("watch-window", workspace, 1));
    await writeFile(
      join(extensions, "slow-module.js"),
      `await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
export default function () {}\n`,
    );

    const logs = [];
    const child = spawn(
      process.execPath,
      ["server/dist/index.js", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          PII_PASSWORD: "",
          PII_WORKSPACE_ROOTS: temp,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr.on("data", (chunk) => logs.push(String(chunk)));

    let ws;
    try {
      const port = await waitForServerPort(child, logs);
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?snapshotDelta=1&cwd=${encodeURIComponent(workspace)}&session=${encodeURIComponent(file)}`,
      );
      const updated = new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`watch-window reload timed out\n${logs.join("")}`)),
          10_000,
        );
        ws.on("error", reject);
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (
            (message.type === "snapshot" || message.type === "session_ready") &&
            message.snapshot.initializing === false &&
            message.snapshot.totalMessages === 2
          ) {
            clearTimeout(timeout);
            resolvePromise(message);
          }
        });
      });

      const openDeadline = Date.now() + 5_000;
      while (!logs.join("").includes("stage=open") && Date.now() < openDeadline)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      assert.match(logs.join(""), /stage=open/);
      await appendFile(
        file,
        `${JSON.stringify({
          type: "message",
          id: "watch-window-1",
          parentId: "watch-window-0",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", content: "arrived during restore" },
        })}\n`,
      );

      await updated;
      assert.match(logs.join(""), /stage=restore_refresh/);
    } finally {
      ws?.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(temp, { recursive: true, force: true });
    }
  },
);
