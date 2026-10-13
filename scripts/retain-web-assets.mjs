/** Bound immutable asset retention without breaking recently opened tabs. @author coolonion */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const RETAINED_BUILDS = 3;
const stateName = '.vite/mewpii-asset-retention.json';
const currentName = '.vite/mewpii-current-assets.json';
const isAsset = (name) => typeof name === 'string' && name.startsWith('assets/')
  && !name.includes('\\') && !name.split('/').some((part) => !part || part === '.' || part === '..')
  && !/\.(?:br|gz)$/.test(name);
const baseAsset = (name) => name.replace(/\.(?:br|gz)$/, '');

/** Symlinks are never followed or removed, including the assets directory itself. */
export async function listAssetFiles(root) {
  const files = [];
  async function visit(relative) {
    let stat;
    try { stat = await lstat(join(root, relative)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await readdir(join(root, relative))) await visit(`${relative}/${entry}`);
    } else if (stat.isFile()) files.push({ name: relative, mtimeMs: stat.mtimeMs, bytes: stat.size });
  }
  await visit('assets');
  return files;
}

function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.builds) || !value.assets
    || typeof value.assets !== 'object' || Array.isArray(value.assets)) throw new Error('Invalid asset retention state');
  if (!value.builds.every((build) => typeof build.id === 'string' && Array.isArray(build.assets)
    && build.assets.every(isAsset))) throw new Error('Invalid asset retention builds');
  if (!Object.entries(value.assets).every(([name, retiredAt]) => isAsset(name)
    && (retiredAt === null || (Number.isFinite(retiredAt) && retiredAt >= 0)))) {
    throw new Error('Invalid asset retention timestamps');
  }
  return value;
}

/** Pure planner: adoption starts a fresh grace period; only aged, known assets expire. */
export function planAssetRetention({ assets, files, previous, now = Date.now() }) {
  if (!Array.isArray(assets) || !assets.length || !assets.every(isAsset)) throw new Error('Invalid current asset list');
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid retention clock');
  const old = previous ? validateState(previous) : { version: 1, builds: [], assets: {} };
  const current = [...new Set(assets)].sort();
  const currentSet = new Set(current);
  const names = new Set(files.map((file) => file.name));
  const present = new Set(files.map((file) => baseAsset(file.name)).filter(isAsset));
  for (const name of current) {
    if (!names.has(name)) throw new Error(`Current build asset missing: ${name}`);
  }
  const id = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  const builds = [{ id, assets: current }, ...old.builds.filter((build) => build.id !== id)].slice(0, RETAINED_BUILDS);
  const protectedAssets = new Set(builds.flatMap((build) => build.assets));
  const tracked = {};
  for (const name of present) {
    tracked[name] = currentSet.has(name) ? null : (old.assets[name] ?? now);
  }
  const cutoff = now - RETENTION_MS;
  const removed = files.filter((file) => {
    const name = baseAsset(file.name);
    const retiredAt = tracked[name];
    return isAsset(name) && !protectedAssets.has(name) && retiredAt !== null
      && retiredAt <= cutoff && file.mtimeMs <= cutoff;
  });
  // Keep an entry until all variants expire; a freshly rewritten compression sidecar is protected too.
  const removedNames = new Set(removed.map((file) => file.name));
  const surviving = new Set(files.filter((file) => !removedNames.has(file.name)).map((file) => baseAsset(file.name)));
  for (const name of Object.keys(tracked)) {
    if (!surviving.has(name)) delete tracked[name];
  }
  return { state: { version: 1, builds, assets: tracked }, removed };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readJson(path, fallback) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Not a regular retention file: ${path}`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

/** Explicit assets are supplied only by a successful build. CLI cleanup reuses its saved inventory. */
export async function retainWebAssets({ root, assets, dryRun = true, now = Date.now() }) {
  root = resolve(root);
  // Require a real build, and never redirect metadata or cleanup through directory symlinks.
  if (!(await lstat(join(root, 'index.html'))).isFile()) throw new Error('Missing regular build index.html');
  for (const name of ['assets', '.vite']) {
    try {
      if (!(await lstat(join(root, name))).isDirectory()) throw new Error(`Unsafe build directory: ${name}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const previous = await readJson(join(root, stateName), null);
  const current = assets ?? (await readJson(join(root, currentName))).assets;
  const files = await listAssetFiles(root);
  const plan = planAssetRetention({ assets: current, files, previous, now });
  const removed = [];
  if (!dryRun) {
    await mkdir(dirname(join(root, stateName)), { recursive: true });
    if (assets) await atomicJson(join(root, currentName), { version: 1, assets: [...new Set(assets)].sort() });
    for (const file of plan.removed) {
      // Another build/compressor may have refreshed a file since planning. Fail safe and retain it.
      const path = join(root, file.name);
      const stat = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isFile() && stat.mtimeMs === file.mtimeMs && stat.size === file.bytes) {
        await unlink(path);
        removed.push(file);
      }
      else if (stat) plan.state.assets[baseAsset(file.name)] = now;
    }
    await atomicJson(join(root, stateName), plan.state);
  }
  return {
    dryRun, candidates: plan.removed.map((file) => file.name),
    bytes: plan.removed.reduce((sum, file) => sum + file.bytes, 0),
    removed: removed.map((file) => file.name), removedBytes: removed.reduce((sum, file) => sum + file.bytes, 0),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  if (rootFlag < 0 || !args[rootFlag + 1] || args.some((arg, index) => index !== rootFlag + 1 && !['--root', '--dry-run', '--apply'].includes(arg))
    || (args.includes('--dry-run') && args.includes('--apply'))) {
    throw new Error('Usage: node scripts/retain-web-assets.mjs --root /absolute/web/dist [--dry-run | --apply]');
  }
  const result = await retainWebAssets({ root: args[rootFlag + 1], dryRun: !args.includes('--apply') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
