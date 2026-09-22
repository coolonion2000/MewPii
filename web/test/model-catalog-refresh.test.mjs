/** Background discovery must not delay the first render or poll indefinitely. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: [new URL('../src/api.ts', import.meta.url).pathname], bundle: true,
  format: 'esm', platform: 'browser', write: false });
let sequence = 0;
async function fixture(respond) {
  const timers = new Map(); let id = 0, calls = 0, notifications = 0;
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalFetch = globalThis.fetch;
  globalThis.setTimeout = (callback) => { timers.set(++id, callback); return id; };
  globalThis.clearTimeout = (key) => timers.delete(key);
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { protocol: 'http:', host: 'localhost', pathname: '/', search: '' };
  globalThis.window = new EventTarget();
  window.fetch = async () => respond(++calls);
  globalThis.fetch = window.fetch;
  window.addEventListener('pii:model-catalog-changed', () => notifications++);
  const api = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text + `\n// ${++sequence}`).toString('base64'));
  return { api, timers, get calls() { return calls; }, get notifications() { return notifications; },
    async tick() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); await entry[1](); },
    dispose() { globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; globalThis.fetch = originalFetch; },
  };
}
const list = (id, refreshing) => ({ providers: [], models: [{ provider: 'deepseek', id }], catalogRefreshing: refreshing });
const reply = value => ({ ok: true, json: async () => value });

test('local list returns first; background completion populates cache and notifies mounted views once', async () => {
  const f = await fixture(n => reply(list(n === 1 ? 'deepseek-v4-flash' : 'deepseek-flash', n === 1)));
  try {
    const first = await f.api.fetchModels();
    assert.equal(first.models[0].id, 'deepseek-v4-flash'); assert.equal(f.calls, 1);
    await f.api.fetchModels(); assert.equal(f.calls, 1); assert.equal(f.timers.size, 1);
    await f.tick();
    assert.equal((await f.api.fetchModels()).models[0].id, 'deepseek-flash');
    assert.equal(f.calls, 2); assert.equal(f.notifications, 1); assert.equal(f.timers.size, 0);
  } finally { f.dispose(); }
});

test('failed background polling stops after its budget and never announces a failed result', async () => {
  const f = await fixture(n => { if (n > 1) throw Error('offline'); return reply(list('cached', true)); });
  try {
    assert.equal((await f.api.fetchModels()).models[0].id, 'cached');
    for (let i = 0; i < 25; i++) await f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.calls, 26); assert.equal(f.notifications, 0);
  } finally { f.dispose(); }
});

test('a stale initial response cannot overwrite a forced refresh or restart polling', async () => {
  let release;
  const old = new Promise(resolve => { release = resolve; });
  const f = await fixture(n => n === 1 ? old : reply(list('new', false)));
  try {
    const pending = f.api.fetchModels();
    await f.api.fetchModels(true);
    release(reply(list('old', true))); await pending;
    assert.equal((await f.api.fetchModels()).models[0].id, 'new'); assert.equal(f.timers.size, 0);
  } finally { f.dispose(); }
});
