/** Cards and inspector must present the same state. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

globalThis.localStorage = { getItem: () => "zh" };
const bundle = await build({
  stdin: {
    contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { SubagentContext } from './src/subagent-store';
    import Card from './src/components/SubagentTaskCard';
    import Panel from './src/components/SubagentPanel';
    import Detail from './src/components/SubagentRunDialog';
    export function render(state, error = false, matched = true, extra = {}) {
      const presentation = { effectiveState: state, stateSource: 'record', statusStale: state === 'unknown', title: '实现补偿', toolCallId: 'call-1', steps: [], ...extra };
      const store = { runs: [{ id: 'run-1', presentation }], selected: 'run-1', error,
        detail: { runId: 'run-1', presentation, state: 'paused', agent: 'worker', preview: {messages: [{ role:'assistant', text:'output', outputText:'output' }]}, log:'' },
        close() {}, open() {}, selectStep() {}, setUsage() {} };
      return renderToStaticMarkup(<SubagentContext.Provider value={store}>
        <Card call={{id: matched ? 'call-1' : 'unrelated-call', arguments:{task:'实现补偿'}}} output="record" />
        <Panel /><Detail width={440}/>
      </SubagentContext.Provider>);
    }`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  banner: {
    js: `import {createRequire} from 'node:module'; const require = createRequire(${JSON.stringify(fileURLToPath(new URL("../package.json", import.meta.url)))});`,
  },
});
const { render } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
).catch((error) => {
  throw new Error(error.message);
});

test("historical paused state never headlines a resumed, completed or unconfirmed task", () => {
  for (const [state, label] of [
    ["running", "运行中"],
    ["completed", "执行结束"],
    ["unknown", "状态待确认"],
  ]) {
    const html = render(state);
    assert.equal(
      (
        html.match(
          new RegExp(`subagent-status state-${state}">${label}`, "g"),
        ) ?? []
      ).length,
      2,
    );
    assert.doesNotMatch(html, /modal-mask/);
    assert.match(html, /工作流历史状态/);
    assert.match(html, /已暂停/);
  }
});
test("refresh failure invalidates all headline states and unrelated tool IDs do not attach", () => {
  assert.equal(
    (
      render("running", true).match(
        /subagent-status state-unknown">状态待确认/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    render("running", false, false),
    /subagent-status state-unknown">状态待确认/,
  );
});

test("card and inspector show completed subtasks, workflow warning and diagnostic together", () => {
  const extra = {
    steps: [{ effectiveState: "completed" }, { effectiveState: "completed" }],
    childSummary: { total: 2, completed: 2 },
    workflow: {
      state: "failed",
      issue: "continuation",
      error: "unsupported-continuation: continuation was not persisted.",
    },
  };
  const html = render("failed", false, true, extra);
  assert.equal(
    (html.match(/subagent-status state-completed">子任务已交还结果/g) ?? [])
      .length,
    2,
  );
  assert.equal(
    (html.match(/class="subagent-flow-warning">流程待恢复/g) ?? []).length,
    2,
  );
  assert.match(html, /已记录的 2\/2 个子任务均已交还结果/);
  assert.match(html, /unsupported-continuation/);
  assert.doesNotMatch(
    render("failed", true, true, extra),
    /subagent-status state-completed/,
  );
});

test("summary aligns to composer width while the label and popover stay compact", async () => {
  const css = await readFile(
    new URL("../src/app.css", import.meta.url),
    "utf8",
  );
  const rule = (selector) =>
    css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))?.[1] ?? "";
  assert.match(
    rule("composer"),
    /max-width: var\(--composer-max-width, 800px\)/,
  );
  assert.match(
    rule("subagent-summary"),
    /max-width: var\(--chat-content-width, var\(--composer-max-width, 800px\)\)/,
  );
  assert.match(rule("subagent-summary-toggle"), /width: fit-content/);
  assert.match(rule("subagent-summary-list"), /width: min\(360px, 100%\)/);
});
