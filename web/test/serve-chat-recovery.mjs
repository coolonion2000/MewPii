/** Memory-only UI QA with no production API or model calls. @author coolonion */
import { createServer } from 'node:http';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['web/test/fixtures/chat-recovery.tsx'], bundle: true, format: 'esm', jsx: 'automatic',
  outdir: '/unused-memory-output', write: false, loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).contents;
const server = createServer((req, res) => {
  const [type, body] = req.url.startsWith('/api/') ? ['application/json', '{"runs":[],"models":[],"providers":[]}'] :
    req.url === '/fixture.js' ? ['text/javascript', js] : req.url === '/fixture.css' ? ['text/css', css] :
    ['text/html', '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>'];
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(`Isolated chat recovery UI: http://127.0.0.1:${server.address().port}`));
