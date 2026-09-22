/** Old open tabs retain their lazy chunks across local builds. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

test('a second build preserves every immutable asset needed by an already open tab', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mewpii-build-assets-')));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>');
    await writeFile(join(root, 'src/main.js'), 'window.openDialog = () => import("./dialog.js");');
    await writeFile(join(root, 'src/dialog.js'), 'import "./dialog.css"; export default "version-one";');
    await writeFile(join(root, 'src/dialog.css'), '.dialog { color: red }');
    const options = {
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      root, logLevel: 'silent',
    };
    await build(options);
    const assets = join(root, 'dist/assets');
    const oldAssets = new Map(await Promise.all((await readdir(assets)).map(async (name) =>
      [name, await readFile(join(assets, name), 'utf8')],
    )));
    assert.ok([...oldAssets.keys()].some((name) => name.startsWith('dialog-') && name.endsWith('.js')));
    assert.ok([...oldAssets.keys()].some((name) => name.endsWith('.css')));
    const oldIndex = await readFile(join(root, 'dist/index.html'), 'utf8');
    await writeFile(join(root, 'src/dialog.js'), 'import "./dialog.css"; export default "version-two";');
    await writeFile(join(root, 'src/dialog.css'), '.dialog { color: blue }');
    await build(options);
    assert.notEqual(await readFile(join(root, 'dist/index.html'), 'utf8'), oldIndex);
    assert.ok((await readdir(assets)).length > oldAssets.size);
    for (const [name, content] of oldAssets)
      assert.equal(await readFile(join(assets, name), 'utf8'), content, `${name} must remain unchanged`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
