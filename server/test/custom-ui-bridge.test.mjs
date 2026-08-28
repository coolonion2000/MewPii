import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function waitForServer(port, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `server exited early (${child.exitCode})\n${logs.join("")}`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${logs.join("")}`);
}

test("reloads extensions and bridges ctx.ui.custom input over WebSocket", {
  timeout: 30_000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mewpii-custom-ui-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const extensionDir = join(home, ".pi", "agent", "extensions");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(extensionDir, "web-ui-test.js"),
    `
import { keyHint } from ${JSON.stringify(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"))};

export default function (pi) {
  pi.registerProvider('web-auth-test', {
    name: 'Web Auth Test',
    baseUrl: 'https://example.invalid/v1',
    api: 'openai-completions',
    models: [{
      id: 'web-auth-model', name: 'Web Auth Model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
    }],
    oauth: {
      name: 'Web Auth Test OAuth',
      async login(callbacks) {
        callbacks.onAuth({ url: 'https://example.test/login' });
        const code = await callbacks.onPrompt({ message: 'Paste test code' });
        if (code !== 'CODE-123') throw new Error('unexpected test code');
        return { refresh: 'test-refresh', access: 'test-access', expires: Date.now() + 3600000 };
      },
      async refreshToken(credentials) { return credentials; },
      getApiKey(credentials) { return credentials.access; },
    },
  });

  pi.registerCommand('web-ui-test', {
    description: 'Exercise the MewPii custom UI bridge',
    handler: async (_args, ctx) => {
      const picked = await ctx.ui.custom((tui, _theme, _keybindings, done) => {
        const values = ['Alpha', 'Beta'];
        const hint = keyHint('tui.select.confirm', 'choose');
        let selected = 0;
        let width = 0;
        return {
          render(nextWidth) {
            width = nextWidth;
            return [
              'Pick one ' + hint,
              ...values.map((value, index) => (index === selected ? '> ' : '  ') + value),
              'width=' + width,
            ];
          },
          handleInput(data) {
            if (data === '\\u001b[B') selected = Math.min(values.length - 1, selected + 1);
            if (data === '\\u001b[A') selected = Math.max(0, selected - 1);
            if (data === '\\r') done(values[selected]);
            tui.requestRender();
          },
          invalidate() {},
        };
      });
      ctx.ui.notify('picked=' + picked, 'info');
    },
  });
}
`,
  );

  const port = 32_000 + Math.floor(Math.random() * 5_000);
  const logs = [];
  const child = spawn(
    process.execPath,
    ["server/dist/index.js", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, HOME: home, PII_PASSWORD: "", PII_WORKSPACE_ROOTS: temp },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForServer(port, child, logs);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}`,
    );
    const result = await new Promise((resolve, reject) => {
      let phase = 0;
      let commandOk = false;
      let toastSeen = false;
      let loginStarted = false;
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `WebSocket test timed out phase=${phase}\n${logs.join("")}`,
            ),
          ),
        15_000,
      );
      const maybeStartLogin = () => {
        if (!commandOk || !toastSeen || loginStarted) return;
        loginStarted = true;
        phase = 6;
        ws.send(
          JSON.stringify({
            id: "login-1",
            type: "slash",
            raw: "/login web-auth-test",
          }),
        );
      };

      ws.on("error", reject);
      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch (cause) {
          reject(cause);
          return;
        }
        if (message.type === "snapshot" && phase === 0) {
          const commandNames = message.snapshot.slashCommands?.map((command) => command.name) ?? [];
          assert.ok(commandNames.includes("reload"), "missing built-in /reload suggestion");
          assert.ok(commandNames.includes("web-ui-test"), "missing extension command suggestion");
          phase = 1;
          ws.send(JSON.stringify({ id: "reload-1", type: "slash", raw: "/reload" }));
          return;
        }
        if (message.type === "command_result" && message.id === "reload-1") {
          assert.equal(message.ok, true, message.error);
          assert.match(message.data?.output ?? "", /已重新加载/);
          phase = 2;
          ws.send(
            JSON.stringify({
              id: "command-1",
              type: "slash",
              raw: "/web-ui-test",
            }),
          );
          return;
        }
        if (message.type === "custom_ui_frame" && phase === 2) {
          assert.match(message.frame.lines.join("\n"), /> Alpha/);
          phase = 3;
          ws.send(
            JSON.stringify({
              type: "custom_ui_resize",
              requestId: message.frame.requestId,
              width: 72,
            }),
          );
          return;
        }
        if (
          message.type === "custom_ui_frame" &&
          phase === 3 &&
          message.frame.lines.includes("width=72")
        ) {
          phase = 4;
          ws.send(
            JSON.stringify({
              type: "custom_ui_input",
              requestId: message.frame.requestId,
              data: "\u001b[B",
            }),
          );
          return;
        }
        if (
          message.type === "custom_ui_frame" &&
          phase === 4 &&
          message.frame.lines.some((line) => line === "> Beta")
        ) {
          phase = 5;
          ws.send(
            JSON.stringify({
              type: "custom_ui_input",
              requestId: message.frame.requestId,
              data: "\r",
            }),
          );
          return;
        }
        if (message.type === "toast" && message.message === "picked=Beta") {
          toastSeen = true;
          maybeStartLogin();
          return;
        }
        if (message.type === "command_result" && message.id === "command-1") {
          assert.equal(message.ok, true, message.error);
          commandOk = true;
          maybeStartLogin();
          return;
        }
        if (message.type === "custom_ui_frame" && phase === 6) {
          const text = message.frame.lines.join("\n");
          if (
            !text.includes("https://example.test/login") ||
            !text.includes("Paste test code")
          )
            return;
          phase = 7;
          ws.send(
            JSON.stringify({
              type: "custom_ui_input",
              requestId: message.frame.requestId,
              data: "CODE-123",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "custom_ui_input",
              requestId: message.frame.requestId,
              data: "\r",
            }),
          );
          return;
        }
        if (message.type === "command_result" && message.id === "login-1") {
          clearTimeout(timer);
          assert.equal(message.ok, true, message.error);
          assert.match(message.data?.output ?? "", /登录成功/);
          resolve(undefined);
        }
      });
    });
    void result;
    ws.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
