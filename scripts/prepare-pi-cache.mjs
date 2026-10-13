/** Bounded, workspace-isolated factory cache for Pi 0.85.1. @author coolonion */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const marker = '// mewpii-workspace-cache-v1';
function patchHostModules(source) {
  if (source.includes('// mewpii-host-modules-v1')) return source;
  const before = ': { alias: getAliases() }),';
  if (source.split(before).length !== 2) throw new Error('Pi host module patch source mismatch');
  return source.replace(before, `: process.env.PII_EXTENSION_MODULES === 'virtual'
                    // mewpii-host-modules-v1: same SDK objects as the bundled CLI.
                    ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
                    : { alias: getAliases() }),`);
}
export function patchLoader(source) {
  if (source.includes(marker)) return patchHostModules(source);
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pi cache patch source mismatch; review SDK version before proceeding');
    source = source.replace(before, after);
  };
  const start = source.indexOf('let extensionCacheCwd;');
  const end = source.indexOf('/**', start);
  if (start < 0 || end < 0) throw new Error('Pi cache block missing');
  source = source.slice(0, start) + `${marker}
let extensionCacheGeneration = 0;
const workspaceExtensionCaches = new Map();
export function clearExtensionCache() {
    workspaceExtensionCaches.clear();
    extensionCacheGeneration++;
}
function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    let cache = workspaceExtensionCaches.get(resolvedCwd);
    if (!cache) cache = new Map();
    workspaceExtensionCaches.delete(resolvedCwd);
    workspaceExtensionCaches.set(resolvedCwd, cache);
    while (workspaceExtensionCaches.size > 8)
        workspaceExtensionCaches.delete(workspaceExtensionCaches.keys().next().value);
    return { cwd: resolvedCwd, generation: extensionCacheGeneration, cache };
}
` + source.slice(end);
  replace('extensionCacheCwd === cacheToken.cwd', 'workspaceExtensionCaches.get(cacheToken.cwd) === cacheToken.cache');
  replace('extensionCache.get(extensionPath)', 'cacheToken.cache.get(extensionPath)');
  replace('extensionCache.set(extensionPath, factory);', `cacheToken.cache.set(extensionPath, factory);
        while (cacheToken.cache.size > 128) cacheToken.cache.delete(cacheToken.cache.keys().next().value);`);
  replace('const factory = await loadExtensionModule(resolvedPath, cacheToken);', `const importStartedAt = performance.now();
        const cacheHit = isCurrentCacheToken(cacheToken) && cacheToken.cache.has(resolvedPath);
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        console.info('[extensions] module_loaded cwd=' + JSON.stringify(cwd) + ' path=' + JSON.stringify(resolvedPath) + ' cache_hit=' + cacheHit + ' duration_ms=' + Math.round(performance.now() - importStartedAt));`);
  replace('await factory(load.api);', `const factoryStartedAt = performance.now();
        try { await factory(load.api); }
        finally { console.info('[extensions] factory_finished cwd=' + JSON.stringify(cwd) + ' path=' + JSON.stringify(resolvedPath) + ' duration_ms=' + Math.round(performance.now() - factoryStartedAt)); }`);
  return patchHostModules(source);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8'));
  if (pkg.version !== '0.85.1') throw new Error(`Pi cache patch requires 0.85.1, found ${pkg.version}`);
  const file = fileURLToPath(new URL('./core/extensions/loader.js', entry));
  const original = readFileSync(file, 'utf8');
  const patched = patchLoader(original);
  if (patched !== original) writeFileSync(file, patched);
  console.info('[prepare] pi_workspace_cache version=0.85.1 status=ready');
}
