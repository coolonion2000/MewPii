/** Isolated read-only QA; serves only five explicitly named example files. @author coolonion */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = '/tmp/map-recall-mail-templates-20260910';
const allowed = new Set(['preflight-map-recall-templates.sql', 'create-map-recall-templates.sql', 'verify-map-recall-templates.sql', 'copy-review.md', 'mapRecallEmailTemplates.json'].map(name => resolve(root, name)));
const bundle = await build({ entryPoints: ['web/test/fixtures/file-links.tsx'], bundle: true, format: 'esm', outdir: '/unused-memory-output', write: false, loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).contents;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/api/file') {
    const path = resolve(root, url.searchParams.get('path') ?? '');
    let status = 200, body;
    if (path === resolve(root, 'mapRecallMailTemplates.json')) { status = 404; body = { error: 'File not found' }; }
    else if (!allowed.has(path)) { status = 403; body = { error: 'file was not authorized by this session' }; }
    else {
      try { body = { content: await readFile(path, 'utf8') }; }
      catch { status = 404; body = { error: 'File not found' }; }
    }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  const [type, body] = url.pathname === '/fixture.js' ? ['text/javascript', js] : url.pathname === '/fixture.css' ? ['text/css', css] : ['text/html', '<!doctype html><html class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;font-family:system-ui;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>'];
  res.writeHead(200, { 'Content-Type': type }); res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(`Isolated file-link UI: http://127.0.0.1:${server.address().port}`));
