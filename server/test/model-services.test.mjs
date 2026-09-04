import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelServicesCache,
  validateModelConfigFile,
} from "../dist/model-services.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeServices(id, error) {
  return {
    runtime: { id },
    registry: { id, getError: () => error },
  };
}

test("model services cold initialization is single-flight", async () => {
  const gate = deferred();
  let creates = 0;
  const expected = fakeServices("cold");
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: "m1", auth: "a1" }),
    create: async () => {
      creates += 1;
      await gate.promise;
      return expected;
    },
    refreshAuth: async () => assert.fail("unexpected auth refresh"),
  });

  const requests = [cache.get(), cache.get(), cache.get()];
  await new Promise((done) => setImmediate(done));
  assert.equal(creates, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all(requests), [expected, expected, expected]);
});

test("auth changes refresh the warm runtime once and model changes recreate it", async () => {
  let revision = { models: "m1", auth: "a1" };
  let creates = 0;
  let authRefreshes = 0;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ ...revision }),
    create: async () => fakeServices(`runtime-${++creates}`),
    refreshAuth: async () => {
      authRefreshes += 1;
    },
  });

  const first = await cache.get();
  revision = { ...revision, auth: "a2" };
  const [afterAuthA, afterAuthB] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(afterAuthA, first);
  assert.equal(afterAuthB, first);
  assert.equal(authRefreshes, 1);
  assert.equal(creates, 1);

  revision = { models: "m2", auth: "a2" };
  const afterModels = await cache.get();
  assert.notEqual(afterModels, first);
  assert.equal(creates, 2);
  assert.equal(authRefreshes, 1);
});

test("a failed warm refresh keeps the last complete model list and retries", async () => {
  let revision = { models: "m1", auth: "a1" };
  let fail = true;
  let refreshes = 0;
  const errors = [];
  const cache = new ModelServicesCache({
    readRevision: async () => ({ ...revision }),
    create: async () => fakeServices("stable"),
    refreshAuth: async () => {
      refreshes += 1;
      if (fail) throw new Error("partially written auth file");
    },
    onError: (reason, error) => errors.push([reason, error.message]),
  });

  const stable = await cache.get();
  revision = { ...revision, auth: "a2" };
  assert.equal(await cache.get(), stable);
  assert.deepEqual(errors, [["auth", "partially written auth file"]]);

  fail = false;
  assert.equal(await cache.get(), stable);
  assert.equal(refreshes, 2, "failed refresh was incorrectly cached");
});

test("explicit invalidation recreates services even when file stamps collide", async () => {
  let creates = 0;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: "same", auth: "same" }),
    create: async () => fakeServices(`runtime-${++creates}`),
  });

  const before = await cache.get();
  cache.invalidate();
  const after = await cache.get();
  assert.notEqual(after, before);
  assert.equal(creates, 2);
});

test("callers converge when model files change during initialization", async () => {
  let revision = { models: "m1", auth: "a1" };
  const firstCreate = deferred();
  const createStarted = deferred();
  let creates = 0;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ ...revision }),
    create: async () => {
      creates += 1;
      if (creates === 1) {
        createStarted.resolve();
        await firstCreate.promise;
      }
      return fakeServices(`runtime-${creates}`);
    },
  });

  const first = cache.get();
  await createStarted.promise;
  revision = { models: "m2", auth: "a1" };
  const second = cache.get();
  firstCreate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(creates, 2);
  assert.equal(firstResult.runtime.id, "runtime-2");
  assert.equal(secondResult.runtime.id, "runtime-2");
});

test("default cache observes credentials written by another process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-model-services-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(join(agentDir, "auth.json"), "{}\n"),
    writeFile(
      join(agentDir, "models.json"),
      `${JSON.stringify({
        providers: {
          "cache-probe": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "probe-model" }],
          },
        },
      })}\n`,
    ),
  ]);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const cache = new ModelServicesCache();
    const before = await cache.get();
    const model = before.registry.find("cache-probe", "probe-model");
    assert.ok(model);
    assert.equal(before.registry.hasConfiguredAuth(model), false);

    await writeFile(
      join(agentDir, "auth.json"),
      `${JSON.stringify({
        "cache-probe": { type: "api_key", key: "test-only-key" },
      })}\n`,
    );
    const after = await cache.get();
    assert.equal(after, before, "auth-only changes rebuilt the entire runtime");
    assert.equal(after.registry.hasConfiguredAuth(model), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed models.json cannot replace a warm healthy model list", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-model-services-invalid-warm-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        "cache-probe": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          models: [{ id: "stable-model" }],
        },
      },
    })}\n`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const errors = [];
    const cache = new ModelServicesCache({
      onError: (reason, error) => errors.push([reason, error.message]),
    });
    const healthy = await cache.get();
    assert.ok(healthy.registry.find("cache-probe", "stable-model"));

    await writeFile(join(agentDir, "models.json"), '{"providers":');
    const afterMalformed = await cache.get();
    assert.equal(afterMalformed, healthy);
    assert.ok(afterMalformed.registry.find("cache-probe", "stable-model"));
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "models");
    assert.match(errors[0][1], /Failed to parse models\.json/);

    // A failed revision is deliberately not cached: an unchanged bad file is
    // retried, then a later complete write replaces the old snapshot.
    assert.equal(await cache.get(), healthy);
    assert.equal(errors.length, 2);
    await writeFile(
      join(agentDir, "models.json"),
      `${JSON.stringify({
        providers: {
          "cache-probe": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "recovered-model" }],
          },
        },
      })}\n`,
    );
    const recovered = await cache.get();
    assert.notEqual(recovered, healthy);
    assert.ok(recovered.registry.find("cache-probe", "recovered-model"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed models.json fails cold initialization with its parse error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-model-services-invalid-cold-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(join(agentDir, "auth.json"), "{}\n"),
    writeFile(join(agentDir, "models.json"), '{"providers":'),
  ]);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const cache = new ModelServicesCache({ onError: () => undefined });
    await assert.rejects(
      cache.get(),
      /model registry refresh failed: Failed to parse models\.json/,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation rejects an empty model id without live auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "mewpii-model-candidate-"));
  const candidate = join(root, "candidate.json");
  try {
    await writeFile(
      candidate,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "" }],
          },
        },
      }),
    );
    await assert.rejects(
      validateModelConfigFile(candidate),
      /providers\.custom\.models\.0\.id/,
    );

    await writeFile(
      candidate,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "valid-model" }],
          },
        },
      }),
    );
    await validateModelConfigFile(candidate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
