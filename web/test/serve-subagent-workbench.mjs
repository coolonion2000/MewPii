/** Manual browser QA server; no build output or runtime writes. @author coolonion */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { presentRun } from '../../server/src/subagent-presentation.ts';

let fixture = {
  runId: 'fixture-run', agent: 'worker', task: '实现围巾下架与补偿', state: 'paused', lastUpdate: Date.now() - 120000,
  cwd: '/workspace/example', log: '', previewStep: 0,
  presentation: { effectiveState: 'unknown', stateSource: 'unconfirmed', statusStale: true, updatedAt: Date.now(), toolCallId: 'fixture-call', title: '实现围巾下架与补偿', steps: [{ key: 'implement', effectiveState: 'unknown' }] },
  steps: [{ key: 'implement', state: 'paused', agent: 'worker', model: 'test-model', tokens: 120000, cost: 0.3 }],
  preview: { truncated: false, messages: [
    { role: 'assistant', text: '已经完成参数校验，继续补充测试。', outputText: '已经完成参数校验，继续补充测试。', timestamp: Date.now() - 10000 },
    { role: 'assistant', summary: 'write src/jobs/compensation.ts', text: '[write] {"path":"src/jobs/compensation.ts"}', timestamp: Date.now() },
  ] },
};
// Optional real read-only snapshot: no host/session is attached or resumed.
const runId = process.env.MEWPII_TEST_RUN_ID;
if (runId) {
  const response = await fetch(`http://127.0.0.1:31041/api/subagent-run?runId=${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(`snapshot status=${response.status}`);
  fixture = await response.json();
  for (const scope of (await readdir(tmpdir())).filter(name => name.startsWith('pi-subagents-'))) {
    const dir = join(tmpdir(), scope, 'async-subagent-runs', runId);
    try {
      const record = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
      fixture.presentation = await presentRun(record, dir, []);
      const { readSessionPreview } = await import('../../server/src/subagent-run-details.ts');
      fixture.preview = await readSessionPreview(fixture.steps?.[fixture.previewStep ?? 0]?.sessionFile);
      break;
    } catch { /* Try the next native scope. */ }
  }
  if (!fixture.presentation) throw new Error('Missing native status projection');
}
const bundle = await build({ entryPoints: ['web/test/fixtures/subagent-workbench.tsx'], bundle: true, format: 'esm', outdir: '/unused-memory-output', write: false, loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).contents;
const html = '<!doctype html><html class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}button{font:inherit}.chat-header>button{margin-left:12px}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>';
const server = createServer((req, res) => {
  const route = req.url?.split('?')[0];
  const [type, body] = route === '/fixture.js' ? ['text/javascript', js] : route === '/fixture.css' ? ['text/css', css] : route === '/fixture.json' ? ['application/json', JSON.stringify(fixture)] : ['text/html', html];
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(`Isolated subagent UI: http://127.0.0.1:${server.address().port}`));
