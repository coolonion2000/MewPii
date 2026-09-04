/** End-to-end readiness queue regression across an in-place session rebind. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      throw new Error(
        `server exited early (${child.exitCode})\n${logs.join("")}`,
      );
    const match = logs.join("").match(
      /MewPii listening on http:\/\/127\.0\.0\.1:(\d+)/,
    );
    if (match) {
      const port = Number(match[1]);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) return port;
      } catch {
        // The listen callback can precede the first accepted request briefly.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`server did not start\n${logs.join("")}`);
}

test(
  "commands queued during a later session_start drain after its UI answer",
  { timeout: 30_000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "mewpii-readiness-ws-"));
    const home = join(temp, "home");
    const workspace = join(temp, "workspace");
    const extensionDir = join(home, ".pi", "agent", "extensions");
    await mkdir(extensionDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(extensionDir, "startup-gate.js"),
      `
// Simulate a slow extension module load. The read-only session preview must be
// delivered before resource discovery finishes.
await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.input("Readiness gate", "answer");
  });
}
`,
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
        `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}`,
      );
      await new Promise((resolvePromise, reject) => {
        let firstMessageSeen = false;
        let uiRequests = 0;
        let newSessionSent = false;
        let newSessionDone = false;
        let queuedCommandDone = false;
        let renamedSnapshotSeen = false;
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `readiness rebind timed out uiRequests=${uiRequests} newSessionDone=${newSessionDone} queuedCommandDone=${queuedCommandDone}\n${logs.join("")}`,
              ),
            ),
          15_000,
        );
        const complete = () => {
          if (!newSessionDone || !queuedCommandDone || !renamedSnapshotSeen)
            return;
          clearTimeout(timeout);
          resolvePromise();
        };

        ws.on("error", reject);
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (!firstMessageSeen) {
            firstMessageSeen = true;
            assert.equal(message.type, "snapshot");
            assert.equal(message.snapshot.initializing, true);
          }
          if (message.type === "ui_request") {
            uiRequests += 1;
            if (uiRequests === 2) {
              // This arrives while newSession is awaiting the replacement
              // session's extension bind. It must be drained after the answer.
              ws.send(
                JSON.stringify({
                  id: "queued-after-rebind",
                  type: "setSessionName",
                  name: "ready-after-rebind",
                }),
              );
            }
            ws.send(
              JSON.stringify({
                type: "ui_response",
                requestId: message.request.id,
                value: `answer-${uiRequests}`,
              }),
            );
            return;
          }
          if (
            (message.type === "snapshot" || message.type === "session_ready") &&
            message.snapshot.initializing === false &&
            uiRequests >= 1 &&
            !newSessionSent
          ) {
            newSessionSent = true;
            ws.send(
              JSON.stringify({ id: "new-session", type: "newSession" }),
            );
            return;
          }
          if (
            message.type === "snapshot" &&
            message.snapshot.name === "ready-after-rebind"
          ) {
            renamedSnapshotSeen = true;
            complete();
            return;
          }
          if (message.type !== "command_result") return;
          if (message.id === "new-session") {
            assert.equal(message.ok, true, message.error);
            newSessionDone = true;
            complete();
          }
          if (message.id === "queued-after-rebind") {
            assert.equal(message.ok, true, message.error);
            queuedCommandDone = true;
            complete();
          }
        });
      });
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
