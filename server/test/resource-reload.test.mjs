/** @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ResourceWatch } from '../dist/resource-watch.js';
import { SessionHost } from '../dist/session-host.js';

test('resource changes mark dirty once without starting reload or affecting active work', () => {
  const messages = [];
  const host = Object.create(SessionHost.prototype);
  host.resourcesDirty = false;
  host.broadcast = message => messages.push(message);
  host.runSlash = () => { throw new Error('automatic reload must not run'); };
  host.markResourcesChanged(['settings.json']);
  host.markResourcesChanged(['skills/example.md']);
  assert.equal(host.resourcesDirty, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /\/reload/);
  host.disposed = true;
  host.resourcesDirty = false;
  host.markResourcesChanged(['settings.json']);
  assert.equal(host.resourcesDirty, false);
});

test('resource watch reports changed file paths and cancels pending callbacks on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-resource-test-'));
  const file = join(root, 'settings.json');
  await writeFile(file, '{}');
  const changes = [];
  const watcher = new ResourceWatch([root], [file], paths => changes.push(paths));
  try {
    await writeFile(file, '{"test":1}');
    for (let i = 0; i < 20 && !changes.length; i++) await delay(100);
    assert.ok(changes.flat().includes(file));
    assert.ok(!changes.flat().some(path => path.includes('settings.json/settings.json')));
    watcher.close();
    const before = changes.length;
    await writeFile(file, '{}');
    await delay(600);
    assert.equal(changes.length, before);
  } finally {
    watcher.close();
    await rm(root, {recursive: true, force: true});
  }
});
