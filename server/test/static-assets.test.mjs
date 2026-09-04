/** Pre-compressed static asset negotiation regressions. @author coolonion */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isPathInside,
  selectStaticRepresentation,
} from "../dist/static-assets.js";

test("static assets prefer accepted pre-compressed representations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-static-"));
  try {
    const file = join(directory, "index.js");
    await Promise.all([
      writeFile(file, "source"),
      writeFile(`${file}.br`, "brotli"),
      writeFile(`${file}.gz`, "gzip"),
    ]);
    assert.deepEqual(selectStaticRepresentation(file, "gzip, br"), {
      path: `${file}.br`,
      encoding: "br",
      varyAcceptEncoding: true,
    });
    assert.deepEqual(selectStaticRepresentation(file, "br;q=0, gzip;q=0.8"), {
      path: `${file}.gz`,
      encoding: "gzip",
      varyAcceptEncoding: true,
    });
    assert.deepEqual(selectStaticRepresentation(file, "identity"), {
      path: file,
      varyAcceptEncoding: true,
      notAcceptable: false,
    });
    assert.deepEqual(
      selectStaticRepresentation(file, "br;q=0, gzip;q=0, identity;q=0"),
      {
        path: file,
        varyAcceptEncoding: true,
        notAcceptable: true,
      },
    );
    assert.deepEqual(selectStaticRepresentation(file, "br;q=invalid"), {
      path: file,
      varyAcceptEncoding: true,
      notAcceptable: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("static containment rejects sibling paths that only share a prefix", () => {
  assert.equal(isPathInside("/srv/web/dist", "/srv/web/dist/assets/a.js"), true);
  assert.equal(isPathInside("/srv/web/dist", "/srv/web/dist-evil/a.js"), false);
  assert.equal(isPathInside("/srv/web/dist", "/srv/web/dist/../secret"), false);
});

test("binary assets do not vary on compression support", () => {
  assert.deepEqual(selectStaticRepresentation("/tmp/icon.png", "br"), {
    path: "/tmp/icon.png",
    varyAcceptEncoding: false,
  });
  assert.deepEqual(
    selectStaticRepresentation("/tmp/icon.png", "identity;q=0"),
    {
      path: "/tmp/icon.png",
      varyAcceptEncoding: true,
      notAcceptable: true,
    },
  );
});
