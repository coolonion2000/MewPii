/** @author coolonion */
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  rm,
  stat as fileStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readSessionInfo,
  SessionCatalog,
} from "../dist/session-catalog.js";

function stamp(path, size = 1, mtimeMs = 1, ino = 1, ctimeMs = mtimeMs) {
  return { path, size, mtimeMs, ino, ctimeMs };
}

function session(path, id = path) {
  return {
    path,
    id,
    cwd: "/workspace",
    created: new Date(0),
    modified: new Date(0),
    messageCount: 0,
    firstMessage: "",
    allMessagesText: "",
  };
}

function options(overrides) {
  return {
    log: () => undefined,
    readProjection: async () => undefined,
    writeProjection: async () => undefined,
    ...overrides,
  };
}

async function actualStamp(path) {
  const value = await fileStat(path);
  return {
    path,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    ino: value.ino,
  };
}

test("session catalog honors an explicit latest name clear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-catalog-name-"));
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          id: "name-clear",
          cwd: "/workspace",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({ type: "session_info", name: "Old title" }),
        JSON.stringify({ type: "session_info", name: "   " }),
      ].join("\n"),
    );
    const stats = await fileStat(path);
    const info = await readSessionInfo(path, {
      path,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
    });
    assert.equal(info?.name, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session catalog shares a concurrent refresh", async () => {
  let scans = 0;
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const catalog = new SessionCatalog(
    options({
      scan: async () => {
        scans += 1;
        await waiting;
        return [stamp("/sessions/one.jsonl")];
      },
      readInfo: async (path) => session(path),
      canonicalize: async (path) => `/real${path}`,
    }),
  );

  const first = catalog.snapshot(4);
  const second = catalog.snapshot(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a, b);
  assert.equal((await catalog.snapshot(4)), a);
  assert.equal(scans, 1);
  assert.equal(a.canonicalPaths.has("/real/sessions/one.jsonl"), true);
});

test("session catalog only reparses files whose stamp changed", async () => {
  let files = [
    stamp("/sessions/one.jsonl", 10, 100, 1),
    stamp("/sessions/two.jsonl", 20, 200, 2),
  ];
  const reads = [];
  const canonicalized = [];
  const catalog = new SessionCatalog(
    options({
      scan: async () => files,
      readInfo: async (path) => {
        reads.push(path);
        return session(path);
      },
      canonicalize: async (path) => {
        canonicalized.push(path);
        return `/real${path}`;
      },
    }),
  );

  await catalog.snapshot(1);
  assert.deepEqual(reads, ["/sessions/one.jsonl", "/sessions/two.jsonl"]);

  await catalog.snapshot(2);
  assert.equal(reads.length, 2, "unchanged files were parsed again");
  assert.equal(canonicalized.length, 2, "unchanged paths were resolved again");

  files = [
    stamp("/sessions/one.jsonl", 11, 300, 1),
    stamp("/sessions/two.jsonl", 20, 200, 2),
  ];
  await catalog.snapshot(3);
  assert.deepEqual(reads, [
    "/sessions/one.jsonl",
    "/sessions/two.jsonl",
    "/sessions/one.jsonl",
  ]);
  assert.equal(canonicalized.length, 3);

  // Rename writes preserve mtime intentionally, so ctime must also invalidate
  // an otherwise same-sized projection.
  files = [
    stamp("/sessions/one.jsonl", 11, 300, 1, 301),
    stamp("/sessions/two.jsonl", 20, 200, 2),
  ];
  await catalog.snapshot(4);
  assert.equal(reads.length, 4);
});

test("session catalog removes deleted paths and treats renames as new files", async () => {
  let files = [stamp("/sessions/old.jsonl")];
  const reads = [];
  const catalog = new SessionCatalog(
    options({
      scan: async () => files,
      readInfo: async (path) => {
        reads.push(path);
        return session(path);
      },
      canonicalize: async (path) => `/real${path}`,
    }),
  );

  await catalog.snapshot(1);
  files = [stamp("/sessions/new.jsonl")];
  const renamed = await catalog.snapshot(2);

  assert.deepEqual(
    renamed.sessions.map((entry) => entry.path),
    ["/sessions/new.jsonl"],
  );
  assert.equal(renamed.canonicalPaths.has("/real/sessions/old.jsonl"), false);
  assert.deepEqual(reads, ["/sessions/old.jsonl", "/sessions/new.jsonl"]);
});

test("session catalog refreshes unchanged stamps after TTL without reparsing", async () => {
  let now = 1_000;
  let scans = 0;
  let reads = 0;
  const catalog = new SessionCatalog(
    options({
      scan: async () => {
        scans += 1;
        return [stamp("/sessions/one.jsonl")];
      },
      readInfo: async (path) => {
        reads += 1;
        return session(path);
      },
      canonicalize: async (path) => path,
      now: () => now,
      maxAgeMs: 50,
    }),
  );

  await catalog.snapshot(1);
  now += 50;
  await catalog.snapshot(1);
  assert.equal(scans, 2);
  assert.equal(reads, 1);
});

test("session catalog omits unparseable and non-canonical paths", async () => {
  const catalog = new SessionCatalog(
    options({
      scan: async () => [
        stamp("/sessions/good.jsonl"),
        stamp("/sessions/missing.jsonl"),
        stamp("/sessions/invalid.jsonl"),
      ],
      readInfo: async (path) =>
        path.endsWith("invalid.jsonl") ? undefined : session(path),
      canonicalize: async (path) => {
        if (path.endsWith("missing.jsonl")) throw new Error("gone");
        return `/canonical${path}`;
      },
    }),
  );

  const snapshot = await catalog.snapshot(1);
  assert.deepEqual(
    snapshot.sessions.map((entry) => entry.path),
    ["/sessions/good.jsonl"],
  );
  assert.deepEqual([...snapshot.canonicalPaths], [
    "/canonical/sessions/good.jsonl",
  ]);
});

test("session catalog fails closed and retries after a scan error", async () => {
  let scans = 0;
  const catalog = new SessionCatalog(
    options({
      scan: async () => {
        scans += 1;
        if (scans === 2) throw new Error("scan failed");
        return [stamp(`/sessions/${scans}.jsonl`)];
      },
      readInfo: async (path) => session(path),
      canonicalize: async (path) => path,
    }),
  );

  await catalog.snapshot(1);
  await assert.rejects(catalog.snapshot(2), /scan failed/);
  assert.equal(
    (await catalog.snapshot(2)).sessions[0].id,
    "/sessions/3.jsonl",
  );
  assert.equal(scans, 3);
});

test("session catalog restores a cross-instance projection without parsing", async () => {
  const files = [stamp("/sessions/one.jsonl", 10, 100, 7, 101)];
  let projection;
  let writes = 0;
  const first = new SessionCatalog(
    options({
      scan: async () => files,
      readInfo: async (path) => ({
        ...session(path, "one"),
        created: new Date("2026-01-02T03:04:05.000Z"),
        modified: new Date("2026-02-03T04:05:06.000Z"),
      }),
      canonicalize: async (path) => `/real${path}`,
      writeProjection: async (content) => {
        writes += 1;
        projection = content;
      },
    }),
  );
  await first.snapshot(1);
  assert.equal(writes, 1, "one refresh wrote more than one projection");
  assert.equal(projection.includes("allMessagesText"), false);

  let parses = 0;
  let canonicalizations = 0;
  const second = new SessionCatalog(
    options({
      scan: async () => files,
      readProjection: async () => projection,
      readInfo: async (path) => {
        parses += 1;
        return session(path);
      },
      canonicalize: async (path) => {
        canonicalizations += 1;
        return `/real${path}`;
      },
      writeProjection: async () => {
        writes += 1;
      },
    }),
  );
  const restored = await second.snapshot(1);

  assert.equal(parses, 0);
  assert.equal(canonicalizations, 1, "disk canonical path was trusted blindly");
  assert.equal(restored.canonicalPaths.has("/real/sessions/one.jsonl"), true);
  assert.equal(restored.sessions[0].created instanceof Date, true);
  assert.equal(
    restored.sessions[0].created.toISOString(),
    "2026-01-02T03:04:05.000Z",
  );
  assert.equal(
    restored.sessions[0].modified.toISOString(),
    "2026-02-03T04:05:06.000Z",
  );
  assert.equal(writes, 1, "unchanged disk projection was rewritten");
});

test("restored projection only parses files whose stamp changed", async () => {
  const original = [
    stamp("/sessions/one.jsonl", 10, 100, 1, 100),
    stamp("/sessions/two.jsonl", 20, 200, 2, 200),
  ];
  let projection;
  const first = new SessionCatalog(
    options({
      scan: async () => original,
      readInfo: async (path) => session(path),
      canonicalize: async (path) => path,
      writeProjection: async (content) => {
        projection = content;
      },
    }),
  );
  await first.snapshot(1);

  const parsed = [];
  let writes = 0;
  const second = new SessionCatalog(
    options({
      scan: async () => [
        original[0],
        stamp("/sessions/two.jsonl", 21, 201, 2, 201),
      ],
      readProjection: async () => projection,
      readInfo: async (path) => {
        parsed.push(path);
        return session(path);
      },
      canonicalize: async (path) => path,
      writeProjection: async () => {
        writes += 1;
      },
    }),
  );
  await second.snapshot(1);

  assert.deepEqual(parsed, ["/sessions/two.jsonl"]);
  assert.equal(writes, 1, "changed records were not persisted as one batch");
});

test("corrupt and mismatched projections fail soft", async () => {
  for (const projection of ["{", '{"schemaVersion":999,"records":[]}']) {
    let parses = 0;
    const catalog = new SessionCatalog(
      options({
        scan: async () => [stamp("/sessions/one.jsonl")],
        readProjection: async () => projection,
        readInfo: async (path) => {
          parses += 1;
          return session(path);
        },
        canonicalize: async (path) => path,
      }),
    );
    const snapshot = await catalog.snapshot(1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(parses, 1);
  }
});

test("projection write failure does not fail the in-memory refresh", async () => {
  const logs = [];
  const catalog = new SessionCatalog(
    options({
      scan: async () => [stamp("/sessions/one.jsonl")],
      readInfo: async (path) => session(path),
      canonicalize: async (path) => path,
      writeProjection: async () => {
        throw new Error("read-only disk");
      },
      log: (message) => logs.push(message),
    }),
  );

  const snapshot = await catalog.snapshot(1);
  assert.equal(snapshot.sessions.length, 1);
  assert.match(logs[0], /projection_write=error/);
});

test("durable checkpoint replays a verified append and rejects an in-place rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-catalog-delta-"));
  const path = join(directory, "session.jsonl");
  const initial = [
    {
      type: "session",
      id: "append-original",
      cwd: "/workspace",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    },
  ];
  try {
    await writeFile(path, `${initial.map(JSON.stringify).join("\n")}\n`);
    let projection;
    const first = new SessionCatalog(
      options({
        scan: async () => [await actualStamp(path)],
        readInfo: readSessionInfo,
        canonicalize: async (value) => value,
        writeProjection: async (content) => {
          projection = content;
        },
      }),
    );
    await first.snapshot(1);
    assert.match(projection, /"checkpoint"/);

    await appendFile(
      path,
      `${[
        {
          type: "session_info",
          id: "name",
          parentId: "m1",
          name: "Incremental title",
        },
        {
          type: "message",
          id: "m2",
          parentId: "name",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "world" }],
          },
        },
      ].map(JSON.stringify).join("\n")}\n`,
    );

    let fullReads = 0;
    const logs = [];
    let updatedProjection;
    const restored = new SessionCatalog(
      options({
        scan: async () => [await actualStamp(path)],
        readProjection: async () => projection,
        readInfo: async (...args) => {
          fullReads += 1;
          return readSessionInfo(...args);
        },
        canonicalize: async (value) => value,
        writeProjection: async (content) => {
          updatedProjection = content;
        },
        log: (message) => logs.push(message),
      }),
    );
    const appended = await restored.snapshot(1);
    assert.equal(fullReads, 0, "verified append fell back to a full JSONL scan");
    assert.equal(appended.sessions[0].id, "append-original");
    assert.equal(appended.sessions[0].name, "Incremental title");
    assert.equal(appended.sessions[0].messageCount, 2);
    assert.equal(
      appended.sessions[0].modified.toISOString(),
      "2026-01-01T00:00:02.000Z",
    );
    assert.match(logs.at(-1), /files_parsed=0 files_delta=1/);
    assert.match(updatedProjection, /"checkpoint"/);

    await appendFile(
      path,
      `${JSON.stringify({
        type: "session_info",
        id: "clear-name",
        parentId: "m2",
        name: "   ",
      })}\n`,
    );
    const cleared = await restored.snapshot(2);
    assert.equal(cleared.sessions[0].name, undefined);
    assert.equal(fullReads, 0, "name-only append triggered a full scan");

    const replacement = [
      {
        type: "session",
        id: "rewritten-session",
        cwd: "/workspace",
        timestamp: "2026-02-01T00:00:00.000Z",
      },
      {
        type: "message",
        id: "replacement-message",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        message: { role: "user", content: `replacement ${"x".repeat(4096)}` },
      },
    ];
    await writeFile(path, `${replacement.map(JSON.stringify).join("\n")}\n`);
    const rewritten = await restored.snapshot(3);
    assert.equal(fullReads, 1, "rewritten inode content was trusted as an append");
    assert.equal(rewritten.sessions[0].id, "rewritten-session");
    assert.match(logs.at(-1), /files_parsed=1 files_delta=0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("append delta rejects an older-prefix rewrite outside the previous tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mewpii-catalog-prefix-"));
  const path = join(directory, "session.jsonl");
  const originalHeader = {
    type: "session",
    id: "aaaaaaaa",
    cwd: "/workspace",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const body = {
    type: "message",
    id: "large-body",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: `body ${"x".repeat(12 * 1024)}` },
  };
  try {
    const original = `${JSON.stringify(originalHeader)}\n${JSON.stringify(body)}\n`;
    await writeFile(path, original);
    let projection;
    const initial = new SessionCatalog(
      options({
        scan: async () => [await actualStamp(path)],
        readInfo: readSessionInfo,
        canonicalize: async (value) => value,
        writeProjection: async (content) => {
          projection = content;
        },
      }),
    );
    await initial.snapshot(1);

    // Keep the inode, old size, and old tail identical while changing only an
    // equal-length header field, then append a valid entry.
    await writeFile(path, original.replace("aaaaaaaa", "bbbbbbbb"));
    await appendFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: "appended",
        parentId: "large-body",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: "after rewrite" },
      })}\n`,
    );

    let fullReads = 0;
    const restored = new SessionCatalog(
      options({
        scan: async () => [await actualStamp(path)],
        readProjection: async () => projection,
        readInfo: async (...args) => {
          fullReads += 1;
          return readSessionInfo(...args);
        },
        canonicalize: async (value) => value,
      }),
    );
    const snapshot = await restored.snapshot(1);
    assert.equal(fullReads, 1, "changed old prefix was accepted as append-only");
    assert.equal(snapshot.sessions[0].id, "bbbbbbbb");
    assert.equal(snapshot.sessions[0].messageCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
