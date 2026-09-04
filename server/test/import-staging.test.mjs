import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withStagedSessionImport } from "../dist/import-staging.js";

async function missing(path) {
  await assert.rejects(stat(path), (cause) => cause?.code === "ENOENT");
}

test("staged session imports are private, unique and removed after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-import-"));
  const paths = [];
  try {
    const results = await Promise.all(
      ["first", "second"].map((content) =>
        withStagedSessionImport(
          directory,
          Buffer.from(content),
          async (path) => {
            paths.push(path);
            assert.equal((await stat(path)).mode & 0o777, 0o600);
            assert.equal(await readFile(path, "utf8"), content);
            return content;
          },
        ),
      ),
    );
    assert.deepEqual(results, ["first", "second"]);
    assert.equal(new Set(paths).size, 2);
    await Promise.all(paths.map(missing));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged session imports are removed when importing rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-import-"));
  let stagedPath;
  try {
    await assert.rejects(
      withStagedSessionImport(
        directory,
        Buffer.from("sensitive transcript"),
        async (path) => {
          stagedPath = path;
          throw new Error("import failed");
        },
      ),
      /import failed/,
    );
    assert.ok(stagedPath);
    await missing(stagedPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
