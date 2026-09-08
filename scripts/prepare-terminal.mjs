/** Restore executable mode omitted by node-pty 1.1.0 macOS prebuilds. @author coolonion */
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
if (process.platform === 'darwin') {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const directory of [`prebuilds/darwin-${process.arch}`, 'build/Release', 'build/Debug']) {
    const helper = join(root, directory, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
