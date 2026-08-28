/** @author coolonion */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFlowCapability,
  flowCapabilityMatches,
  mutationRequestAllowed,
  resolveWorkspacePath,
  safeNextPath,
  webSocketOriginAllowed,
} from '../dist/security.js';

function request(method, headers = {}, encrypted = false) {
  return { method, headers, socket: { encrypted } };
}

test('OAuth flow capabilities are unguessable and compared by digest', () => {
  const first = createFlowCapability();
  const second = createFlowCapability();
  assert.notEqual(first.secret, second.secret);
  assert.equal(flowCapabilityMatches(first.secret, first.hash), true);
  assert.equal(flowCapabilityMatches(second.secret, first.hash), false);
  assert.equal(flowCapabilityMatches('forged', first.hash), false);
});

test('safeNextPath only accepts same-site absolute paths', () => {
  assert.equal(safeNextPath('/chat?id=1#last'), '/chat?id=1#last');
  assert.equal(safeNextPath('javascript:alert(1)'), '/');
  assert.equal(safeNextPath('//evil.example/path'), '/');
  assert.equal(safeNextPath('/\\evil.example'), '/');
});

test('mutation guard blocks cross-site browser writes and permits same-origin or CLI', () => {
  assert.equal(mutationRequestAllowed(request('POST', { host: '127.0.0.1:31041', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(mutationRequestAllowed(request('POST', { host: 'pi.example', origin: 'https://pi.example', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(mutationRequestAllowed(request('POST', { host: '127.0.0.1:31041' })), true);
  assert.equal(mutationRequestAllowed(request('GET', { host: '127.0.0.1:31041', origin: 'http://evil.example' })), true);
});

test('websocket origin guard compares externally visible scheme and host', () => {
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example' })), true);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example', origin: 'http://pi.example' })), true);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example', origin: 'https://pi.example' })), false);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'internal:31041', 'x-forwarded-host': 'pi.example', 'x-forwarded-proto': 'https', origin: 'https://pi.example' })), true);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example', origin: 'https://pi.example' }, true)), true);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example', origin: 'http://pi.example' }, true)), false);
  assert.equal(webSocketOriginAllowed(request('GET', { host: 'pi.example', origin: 'https://evil.example', 'x-forwarded-proto': 'https' })), false);
});

test('workspace resolver rejects traversal and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-security-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(workspace, 'escape'));

  await assert.rejects(resolveWorkspacePath(workspace, '../outside/secret.txt', { extraRoots: [root] }), /escapes workspace/);
  await assert.rejects(resolveWorkspacePath(workspace, 'escape/secret.txt', { extraRoots: [root] }), /symlink escapes workspace/);
  const safe = await resolveWorkspacePath(workspace, 'new/deep/file.txt', { write: true, extraRoots: [root] });
  assert.equal(safe.path, join(await realpath(workspace), 'new/deep/file.txt'));
});
