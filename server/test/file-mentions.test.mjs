import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { searchMentionFiles, mentionScore } from '../dist/file-mentions.js';
import { handleWorkspaceFiles } from '../dist/workspace-files.js';

test('mention matching ranks exact, prefix, substring, path, and subsequence', () => {
  assert.equal(mentionScore('src/Composer.tsx', 'composer.tsx'), 0);
  assert.equal(mentionScore('src/Composer.tsx', 'com'), 1);
  assert.equal(mentionScore('src/Composer.tsx', 'poser'), 2);
  assert.equal(mentionScore('src/Composer.tsx', 'src/com'), 3);
  assert.equal(mentionScore('src/Composer.tsx', 'cmps'), 4);
  assert.equal(mentionScore('src/Composer.tsx', 'xyz'), Infinity);
  assert.equal(mentionScore('docs/中文 说明.md', '中文'), 1);
});

test('bounded mention search excludes hidden, generated and symlink paths and does not cross workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-mentions-'));
  const other = await mkdtemp(join(tmpdir(), 'pii-mentions-outside-'));
  try {
    for (const dir of ['src', '.private', 'node_modules']) await mkdir(join(root, dir));
    await writeFile(join(root, 'src/Composer.tsx'), 'never returned as content');
    await writeFile(join(root, '.private/secret'), 'secret');
    await writeFile(join(root, 'node_modules/dependency'), 'dependency');
    await writeFile(join(other, 'outside'), 'outside');
    await symlink(other, join(root, 'linked'));
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(root, `item-${i}`), '')));
    assert.deepEqual((await searchMentionFiles(root, 'cmps')).items.map(x => x.path), ['src/Composer.tsx']);
    assert.equal((await searchMentionFiles(root, 'src')).items[0].isDir, true);
    assert.deepEqual((await searchMentionFiles(root, 'src/cmps')).items.map(x => x.path), ['src/Composer.tsx']);
    for (const q of ['secret', 'dependency', 'outside', 'linked']) assert.equal((await searchMentionFiles(root, q)).items.length, 0);
    const many = await searchMentionFiles(root, 'item');
    assert.equal(many.items.length, 24); assert.equal(many.truncated, true);
    assert.equal((await searchMentionFiles(other, 'Composer')).items.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('mention API retains workspace validation and returns paths without loading file content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-mention-api-'));
  const server = createServer((req, res) => {
    void handleWorkspaceFiles(req, res, new URL(req.url, 'http://localhost'), { roots: async () => [root], preview: async () => { throw Error('preview must not run'); } });
  });
  try {
    await writeFile(join(root, 'sample.md'), 'DO NOT RETURN FILE CONTENT');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/files?mode=mention`;
    const response = await fetch(`${base}&cwd=${encodeURIComponent(root)}&q=smpl`);
    const data = await response.json();
    assert.equal(data.mentionSearch, true); assert.equal(data.items[0].path, 'sample.md');
    assert.ok(!JSON.stringify(data).includes('DO NOT RETURN'));
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(`${base}&cwd=relative`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
