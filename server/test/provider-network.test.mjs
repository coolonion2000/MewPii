/** Only a loopback server is contacted; no model requests. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { initializeProviderNetwork } from '../src/provider-network.ts';

test('network bootstrap is idempotent and fetch decodes compressed loopback responses', async () => {
  const before = globalThis.fetch;
  initializeProviderNetwork();
  const installed = globalThis.fetch;
  assert.notEqual(installed, before);
  initializeProviderNetwork();
  assert.equal(globalThis.fetch, installed);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(gzipSync('{"ok":true}'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(2000) })).json(), { ok: true });
  } finally { server.closeAllConnections(); server.close(); }
});
