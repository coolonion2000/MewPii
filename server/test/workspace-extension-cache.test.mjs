/** @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchLoader } from '../../scripts/prepare-pi-cache.mjs';
import { readFileSync } from 'node:fs';
const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
const url = new URL('./core/extensions/loader.js', entry);
const { loadExtensionsCached, clearExtensionCache } = await import(url.href);

test('workspace factory cache survives A/B/A while extension instances stay independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-cache-test-'));
  const file = join(root, 'probe.ts');
  await writeFile(file, `let count = 0;
export default function(pi) {
  pi.registerCommand('probe', {description: String(++count), handler: async () => {}});
}`);
  const load = async cwd => {
    const result = await loadExtensionsCached([file], join(root, cwd));
    assert.deepEqual(result.errors, []);
    return result;
  };
  try {
    clearExtensionCache();
    const a1 = await load('a');
    const b1 = await load('b');
    const a2 = await load('a');
    const count = result => result.extensions[0].commands.get('probe').description;
    assert.equal(count(a1), '1');
    assert.equal(count(b1), '1');
    assert.equal(count(a2), '2');
    assert.notEqual(a1.runtime, a2.runtime);
    assert.notEqual(a1.extensions[0], a2.extensions[0]);
    clearExtensionCache();
    assert.equal(count(await load('a')), '1');
    for (let i = 0; i < 8; i++) await load('other-' + i);
    assert.equal(count(await load('a')), '1', 'old workspace evicted at the capacity bound');
  } finally {
    clearExtensionCache();
    await rm(root, {recursive: true, force: true});
  }
});

test('SDK patch is idempotent and rejects unknown input', () => {
  const source = readFileSync(url, 'utf8');
  assert.equal(patchLoader(source), source);
  assert.throws(() => patchLoader('unknown SDK source'), /missing/);
});
