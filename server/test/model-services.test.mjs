import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
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

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Pi catalog persists new models and an already open session can reload them without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-catalog-store-'));
  const server = createServer();
  let requests = 0;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const options = {
      modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
      modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false,
      catalogBaseUrl: `http://127.0.0.1:${server.address().port}`,
    };
    await writeFile(options.authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'test-only-placeholder' } }));
    const session = await ModelRuntime.create(options);
    const baseline = session.getModel('deepseek', 'deepseek-v4-flash');
    assert.ok(baseline);
    server.on('request', (req, res) => {
      requests++;
      assert.equal(req.url, '/api/models/providers/deepseek');
      assert.equal(req.headers.authorization, undefined, 'public catalog needs no user key');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Last-Modified': new Date('2030-01-01').toUTCString() });
      res.end(JSON.stringify([{ ...baseline, id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', input: ['text', 'image'] }]));
    });
    const candidate = await ModelRuntime.create(options);
    const result = await candidate.refresh({ providers: ['deepseek'], allowNetwork: true });
    assert.equal(result.errors.size, 0);
    assert.equal(candidate.getModel('deepseek', 'deepseek-flash').name, 'DeepSeek V4.1 Flash');
    assert.equal(session.getModel('deepseek', 'deepseek-flash'), undefined);
    await session.refresh({ allowNetwork: false });
    assert.deepEqual(session.getModel('deepseek', 'deepseek-flash').input, ['text', 'image']);
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('background catalog is nonblocking, single-flight and throttled after success', async () => {
  const gate = deferred();
  const local = fakeServices('local'), remote = fakeServices('remote');
  let calls = 0;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: 'm', auth: 'a' }),
    create: async () => local,
    refreshCatalog: async () => { calls++; await gate.promise; return remote; },
  });
  assert.equal(await cache.get(), local);
  assert.equal(cache.catalogRefreshing, true);
  assert.equal(await cache.get(), local);
  assert.equal(calls, 1);
  gate.resolve(); await tick();
  assert.equal(cache.catalogRefreshing, false);
  assert.equal(await cache.get(), remote);
  assert.equal(calls, 1);
});

test('partial catalog publishes available updates and retries unavailable providers sooner', async () => {
  let now = 100, calls = 0;
  const local = fakeServices('local'), updated = fakeServices('updated');
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: 'm', auth: 'a' }), create: async () => local,
    now: () => now,
    refreshCatalog: async () => { calls++; return { services: updated, retrySoon: true }; },
  });
  await cache.get(); await tick();
  assert.equal(await cache.get(), updated); assert.equal(calls, 1);
  now += 60_001;
  await cache.get(); await tick(); assert.equal(calls, 2);
});

test('catalog failure preserves local models and has retry backoff', async () => {
  let now = 100, calls = 0;
  const local = fakeServices('local');
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: 'm', auth: 'a' }), create: async () => local,
    now: () => now,
    refreshCatalog: async () => { calls++; throw new Error('offline'); },
  });
  assert.equal(await cache.get(), local); await tick();
  assert.equal(await cache.get(), local); assert.equal(calls, 1);
  now += 60_001;
  assert.equal(await cache.get(), local); await tick(); assert.equal(calls, 2);
});

test('timed out catalog cannot publish its late result', async () => {
  const gate = deferred(), local = fakeServices('local');
  let signal;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ models: 'm', auth: 'a' }), create: async () => local,
    catalogTimeoutMs: 10,
    refreshCatalog: async (_, s) => { signal = s; await gate.promise; return fakeServices('late'); },
  });
  await cache.get();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(signal.aborted, true); assert.equal(cache.catalogRefreshing, false);
  gate.resolve(); await tick();
  assert.equal(await cache.get(), local);
});

test('catalog candidate cannot overwrite a newer credential or config revision', async () => {
  const gate = deferred(), local = fakeServices('local');
  let revision = { models: 'm1', auth: 'a1' }, calls = 0;
  const cache = new ModelServicesCache({
    readRevision: async () => ({ ...revision }), create: async () => local,
    refreshAuth: async () => {},
    refreshCatalog: async () => { calls++; if (calls === 1) await gate.promise; return local; },
  });
  await cache.get(); revision.auth = 'a2'; await cache.get();
  gate.resolve(); await tick();
  assert.equal(await cache.get(), local); await tick();
  assert.equal(calls, 2, 'stale candidate must permit a fresh background check');
});

test("model services cold initialization is single-flight", async () => {
  const gate = deferred();
  let creates = 0;
  const expected = fakeServices("cold");
  const cache = new ModelServicesCache({ refreshCatalog: false,
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
  const cache = new ModelServicesCache({ refreshCatalog: false,
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
  const cache = new ModelServicesCache({ refreshCatalog: false,
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
  const cache = new ModelServicesCache({ refreshCatalog: false,
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
  const cache = new ModelServicesCache({ refreshCatalog: false,
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
    const cache = new ModelServicesCache({ refreshCatalog: false });
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
    const cache = new ModelServicesCache({ refreshCatalog: false,
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
    const cache = new ModelServicesCache({ refreshCatalog: false, onError: () => undefined });
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
