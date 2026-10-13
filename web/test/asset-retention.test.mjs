/** Retention only touches disposable build fixtures. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { planAssetRetention, retainWebAssets, RETENTION_MS } from '../../scripts/retain-web-assets.mjs';
import { compressWebAssets } from '../../scripts/compress-web-assets.mjs';

const DAY = 86400000;
const file = (name, time = 0) => ({ name: `assets/${name}.js`, mtimeMs: time, bytes: 10 });
const plan = (assets, files, previous, now) => planAssetRetention({ assets: assets.map((name) => `assets/${name}.js`), files, previous, now });

test('adopts existing assets with a full grace period and retains the last three complete builds', () => {
  const files = ['legacy', 'a', 'b', 'c', 'd', 'lazy'].map((name) => file(name));
  let state = plan(['a', 'lazy'], files, null, 30 * DAY).state;
  assert.equal(state.assets['assets/legacy.js'], 30 * DAY);
  assert.equal(plan(['a', 'lazy'], files, state, 31 * DAY).removed.length, 0);
  state = plan(['b'], files, state, 31 * DAY).state;
  // Retirement starts when the asset ceases to be current, not when the old build was created.
  assert.equal(state.assets['assets/a.js'], 31 * DAY);
  state = plan(['c'], files, state, 50 * DAY).state;
  const kept = plan(['c'], files, state, 80 * DAY);
  assert.ok(!kept.removed.some((entry) => ['assets/a.js', 'assets/lazy.js'].includes(entry.name)));
  const expired = plan(['d'], files, kept.state, 81 * DAY);
  assert.ok(expired.removed.some((entry) => entry.name === 'assets/a.js'));
  assert.ok(expired.removed.some((entry) => entry.name === 'assets/lazy.js'));
  assert.ok(!expired.removed.some((entry) => ['assets/b.js', 'assets/c.js', 'assets/d.js'].includes(entry.name)));
  assert.equal(expired.state.builds.length, 3);
});

test('rejects unsafe state/paths and missing current dependencies; recent rewrites cannot expire', () => {
  assert.throws(() => plan(['../private'], [file('../private')], null, 1), /Invalid current/);
  assert.throws(() => plan(['a'], [file('a')], { version: 1, assets: { '../secret': 0 }, builds: [] }, 1), /Invalid asset retention/);
  assert.throws(() => plan(['a', 'missing-lazy'], [file('a')], null, 1), /Current build asset missing/);
  const previous = { version: 1, assets: { 'assets/old.js': 0 }, builds: [] };
  assert.deepEqual(plan(['a'], [file('a'), file('old', 30 * DAY)], previous, 30 * DAY).removed, []);
});

test('dry-run is read-only, expiration deletes companions and preserves current nested assets and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-retention-'));
  try {
    await mkdir(join(root, 'assets/nested'), { recursive: true });
    await writeFile(join(root, 'index.html'), 'current');
    const assets = ['assets/nested/current.js', 'assets/nested/style.css', 'assets/nested/image.png'];
    for (const name of [...assets, 'assets/legacy.js', 'assets/legacy.js.br', 'assets/legacy.js.gz']) {
      await writeFile(join(root, name), name);
      await utimes(join(root, name), 0, 0);
    }
    await writeFile(join(root, 'outside.txt'), 'never delete');
    await symlink(join(root, 'outside.txt'), join(root, 'assets/link.js'));
    const start = 30 * DAY;
    await retainWebAssets({ root, assets, dryRun: false, now: start });
    const before = await readFile(join(root, '.vite/mewpii-asset-retention.json'), 'utf8');
    const result = await retainWebAssets({ root, now: start + RETENTION_MS + 1 });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.candidates.sort(), ['assets/legacy.js', 'assets/legacy.js.br', 'assets/legacy.js.gz']);
    assert.equal(await readFile(join(root, '.vite/mewpii-asset-retention.json'), 'utf8'), before);
    assert.equal(await readFile(join(root, 'assets/legacy.js'), 'utf8'), 'assets/legacy.js');
    await retainWebAssets({ root, dryRun: false, now: start + RETENTION_MS + 1 });
    assert.deepEqual((await readdir(join(root, 'assets'))).sort(), ['link.js', 'nested']);
    assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'never delete');
    for (const name of assets) assert.equal(await readFile(join(root, name), 'utf8'), name);
    await writeFile(join(root, '.vite/mewpii-asset-retention.json'), 'broken json');
    await assert.rejects(retainWebAssets({ root, dryRun: false }), /JSON/);
    for (const name of assets) assert.equal(await readFile(join(root, name), 'utf8'), name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compression reuses unchanged files and excludes retention metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-compression-'));
  try {
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, '.vite'));
    const path = join(root, 'assets/current.js');
    await writeFile(path, 'first'.repeat(1000));
    await writeFile(join(root, '.vite/metadata.json'), 'private-metadata'.repeat(1000));
    assert.equal((await compressWebAssets(root)).written, 2);
    assert.equal((await compressWebAssets(root)).skipped, 1);
    await writeFile(path, 'second'.repeat(1000));
    await utimes(`${path}.br`, 0, 0);
    await utimes(`${path}.gz`, 0, 0);
    assert.equal((await compressWebAssets(root)).written, 2);
    assert.equal(brotliDecompressSync(await readFile(`${path}.br`)).toString(), 'second'.repeat(1000));
    assert.equal(gunzipSync(await readFile(`${path}.gz`)).toString(), 'second'.repeat(1000));
    await writeFile(path, 'small');
    await utimes(`${path}.br`, 0, 0);
    await utimes(`${path}.gz`, 0, 0);
    assert.equal((await compressWebAssets(root)).written, 2);
    assert.equal(gunzipSync(await readFile(`${path}.gz`)).toString(), 'small');
    assert.deepEqual(await readdir(join(root, '.vite')), ['metadata.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
