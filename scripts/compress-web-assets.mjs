/** Pre-compress immutable web assets so the server never compresses them on request. */
import { brotliCompress, gzip } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants } from "node:zlib";
import { fileURLToPath } from "node:url";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const root = fileURLToPath(new URL("../web/dist/", import.meta.url));
const compressible = new Set([".css", ".html", ".js", ".json", ".svg"]);
const minimumBytes = 1024;

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

await mkdir(root, { recursive: true });
const files = (await filesBelow(root)).filter(
  (path) => compressible.has(extname(path)) && !/\.(?:br|gz)$/.test(path),
);

let written = 0;
for (const path of files) {
  const input = await readFile(path);
  if (input.byteLength < minimumBytes) continue;
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

process.stdout.write(`[build] compressed_web_assets files=${files.length} outputs=${written}\n`);
