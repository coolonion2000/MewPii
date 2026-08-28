/** Generate/check the browser protocol mirror from the server canonical source. @author coolonion */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = `${root}/server/src/protocol.ts`;
const targetPath = `${root}/web/src/types.ts`;
const source = await readFile(sourcePath, 'utf8');

if (process.argv.includes('--check')) {
  const target = await readFile(targetPath, 'utf8');
  if (target === source) {
    console.log('protocol mirror matches server/src/protocol.ts');
  } else {
    console.error('Protocol mirror is stale. Run: npm run sync-protocol');
    process.exitCode = 1;
  }
} else {
  await writeFile(targetPath, source);
  console.log('updated web/src/types.ts from server/src/protocol.ts');
}
