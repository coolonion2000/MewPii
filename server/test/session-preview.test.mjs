import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readRawSessionPreview,
  SESSION_HISTORY_MAX_MESSAGES,
} from "../dist/session-host.js";

function header(id = "session-preview") {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/preview-workspace",
  };
}

function message(id, parentId, text, role = "user") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [text] },
  };
}

test("raw preview follows the durable leaf branch and normalizes messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mewpii-preview-"));
  const file = join(dir, "branch.jsonl");
  const entries = [
    header(),
    message("root", null, "root"),
    {
      type: "model_change",
      id: "model",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      provider: "provider-a",
      modelId: "model-a",
    },
    {
      type: "thinking_level_change",
      id: "thinking",
      parentId: "model",
      timestamp: "2026-01-01T00:00:02.000Z",
      thinkingLevel: "high",
    },
    message("abandoned-1", "thinking", "not active"),
    message("abandoned-2", "abandoned-1", "also not active", "assistant"),
    message("branch-message", "thinking", "active branch", "assistant"),
    {
      type: "session_info",
      id: "name",
      parentId: "branch-message",
      timestamp: "2026-01-01T00:00:03.000Z",
      name: "  Fast preview  ",
    },
  ];
  await writeFile(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{broken`,
  );

  try {
    const preview = await readRawSessionPreview(file, "/fallback");
    assert.ok(preview);
    assert.equal(preview.branchComplete, true);
    assert.equal(preview.snapshot.sessionId, "session-preview");
    assert.equal(preview.snapshot.cwd, "/tmp/preview-workspace");
    assert.equal(preview.snapshot.name, "Fast preview");
    assert.equal(preview.snapshot.branchHeadId, "name");
    assert.equal(preview.snapshot.thinkingLevel, "high");
    assert.deepEqual(preview.snapshot.model, {
      provider: "provider-a",
      id: "model-a",
      name: "model-a",
    });
    assert.deepEqual(
      preview.snapshot.messages.map((value) => value._entryId),
      ["root", "branch-message"],
    );
    assert.deepEqual(preview.snapshot.messages[0].content, [
      { type: "text", text: "root" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw preview bounds a long linear branch to its newest message page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mewpii-preview-page-"));
  const file = join(dir, "linear.jsonl");
  const entries = [header("linear-preview")];
  let parentId = null;
  for (let index = 0; index < 70; index++) {
    const id = `message-${index}`;
    entries.push(message(id, parentId, `message ${index}`));
    parentId = id;
  }
  await writeFile(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  try {
    const preview = await readRawSessionPreview(file, "/fallback");
    assert.ok(preview);
    assert.equal(preview.branchComplete, false);
    assert.equal(preview.snapshot.messages.length, SESSION_HISTORY_MAX_MESSAGES);
    assert.equal(preview.snapshot.messages[0]._entryId, "message-20");
    assert.equal(preview.snapshot.messages.at(-1)._entryId, "message-69");
    assert.equal(preview.snapshot.totalMessages, SESSION_HISTORY_MAX_MESSAGES);
    assert.equal(preview.snapshot.historyFrom, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw preview defers legacy sessions to SessionManager migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mewpii-preview-v1-"));
  const file = join(dir, "legacy.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({ ...header("legacy"), version: 1 })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "legacy" } })}\n`,
  );
  try {
    assert.equal(await readRawSessionPreview(file, "/fallback"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
