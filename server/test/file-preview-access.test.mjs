/** Session-scoped external file preview authorization regressions. @author coolonion */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveToolAuthorizedPreviewPath,
  successfulFileToolPaths,
} from "../dist/file-preview-access.js";

function toolCall(id, name, args) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}

function toolResult(toolCallId, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
  };
}

test("authorizes only exact files from successful read/write/edit calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-preview-access-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external", "report.md");
  const other = join(root, "external", "secret.md");
  await mkdir(workspace);
  await mkdir(join(root, "external"));
  await writeFile(external, "authorized");
  await writeFile(other, "not authorized");
  try {
    const messages = [
      toolCall("read-ok", "read", { path: external }),
      toolCall("read-failed", "read", { path: other }),
      toolResult("read-ok"),
      toolResult("read-failed", true),
    ];
    assert.deepEqual(successfulFileToolPaths(messages), [external]);
    assert.equal(
      await resolveToolAuthorizedPreviewPath(workspace, external, messages),
      await realpath(external),
    );
    assert.equal(
      await resolveToolAuthorizedPreviewPath(workspace, other, messages),
      undefined,
    );
    assert.equal(
      await resolveToolAuthorizedPreviewPath(workspace, external, [
        toolCall("missing-result", "read", { path: external }),
      ]),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
