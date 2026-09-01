/** Detached-session background activity detection regressions. @author coolonion */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasRunningSubagentRuns } from "../dist/subagent-activity.js";

async function writeStatus(root, runId, status) {
  const dir = join(root, "pi-subagents-test", "async-subagent-runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status));
}

test("detects only live subagent runs owned by the parent session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-subagent-activity-"));
  const parent = "/tmp/parent-session.jsonl";
  try {
    await writeStatus(root, "matching", {
      sessionId: parent,
      state: "running",
      pid: 42,
      deadlineAt: 500_000,
    });
    assert.equal(
      hasRunningSubagentRuns(parent, {
        tempRoot: root,
        now: 100_000,
        pidAlive: (pid) => pid === 42,
      }),
      true,
    );
    assert.equal(
      hasRunningSubagentRuns("/tmp/other-session.jsonl", {
        tempRoot: root,
        now: 100_000,
        pidAlive: () => true,
      }),
      false,
    );

    await writeStatus(root, "matching", {
      sessionId: parent,
      state: "complete",
      pid: 42,
    });
    assert.equal(
      hasRunningSubagentRuns(parent, {
        tempRoot: root,
        now: 100_000,
        pidAlive: () => true,
      }),
      false,
    );

    await writeStatus(root, "matching", {
      sessionId: parent,
      state: "queued",
      deadlineAt: 10_000,
    });
    assert.equal(
      hasRunningSubagentRuns(parent, {
        tempRoot: root,
        now: 80_001,
        pidAlive: () => true,
      }),
      false,
      "expired queued run retained a host forever",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
