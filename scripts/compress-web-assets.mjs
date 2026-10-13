/** Pre-compress immutable web assets so the server never compresses them on request. */
import { brotliCompress, gzip } from "node:zlib";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants } from "node:zlib";
import { fileURLToPath } from "node:url";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const defaultRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const compressible = new Set([".css", ".html", ".js", ".json", ".svg"]);
const minimumBytes = 1024;

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink()).map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

export async function compressWebAssets(root = defaultRoot) {
  const files = (await filesBelow(root)).filter(
    (path) => compressible.has(extname(path)) && !/\.(?:br|gz)$/.test(path),
  );

  let written = 0;
  let skipped = 0;
  for (const path of files) {
    const source = await stat(path);
    const variants = await Promise.all(['br', 'gz'].map((suffix) => lstat(`${path}.${suffix}`).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    if (variants.some((variant) => variant && !variant.isFile())) throw new Error(`Unsafe compressed asset: ${path}`);
    if (variants.every((variant) => variant && variant.mtimeMs >= source.mtimeMs)) {
      skipped++;
      continue;
    }
    const input = await readFile(path);
    // A public/index file may shrink: refresh existing variants rather than serving stale bytes.
    if (input.byteLength < minimumBytes && variants.every((variant) => variant === null)) continue;
    const [br, gz] = await Promise.all([
      brotli(input, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        },
      }),
      gzipAsync(input, { level: 9 }),
    ]);
    await Promise.all([
      writeFile(`${path}.br`, br),
      writeFile(`${path}.gz`, gz),
    ]);
    written += 2;
  }

  return { files: files.length, written, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await compressWebAssets();
  process.stdout.write(`[build] compressed_web_assets files=${result.files} outputs=${result.written} skipped=${result.skipped}\n`);
}
