#!/usr/bin/env node
// pii-web CLI: starts the pii web server (serves web/dist + drives pi via SDK).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(entry)) {
  console.error('pii-web is not built. Run `npm run build` first.');
  process.exit(1);
}
await import(entry);
