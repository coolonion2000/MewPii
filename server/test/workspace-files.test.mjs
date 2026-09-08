/** File content, upload and Git filename regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readTextPreview, saveUpload, parseGitStatus, gitChanges, gitDiff, listFiles, searchFiles, handleWorkspaceFiles } from '../dist/workspace-files.js';
import { resolveWorkspacePath } from '../dist/security.js';

test('text detection accepts dotfiles and extensionless text but rejects binary and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-file-types-'));
  try {
    for (const name of ['.gitignore', 'Dockerfile', 'LICENSE', 'unknown.format']) {
      await writeFile(join(root, name), '中文\nplain text\n');
      assert.equal(await readTextPreview(join(root, name)), '中文\nplain text\n');
    }
    await writeFile(join(root, 'binary.txt'), Buffer.from([1, 0, 2, 3]));
    await assert.rejects(readTextPreview(join(root, 'binary.txt')), e => e.status === 415);
    await writeFile(join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
    await assert.rejects(readTextPreview(join(root, 'large.txt')), e => e.status === 413);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uploads reject collisions, allow explicit replacement, and never leave temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-upload-'));
  try {
    const path = join(root, 'report.txt');
    await saveUpload(path, Buffer.from('original'));
    await assert.rejects(saveUpload(path, Buffer.from('new')), e => e.status === 409);
    assert.equal(await readFile(path, 'utf8'), 'original');
    await saveUpload(path, Buffer.from('replacement'), true);
    assert.equal(await readFile(path, 'utf8'), 'replacement');
    const results = await Promise.allSettled([saveUpload(join(root, 'race'), Buffer.from('one')), saveUpload(join(root, 'race'), Buffer.from('two'))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.deepEqual((await readdir(root)).sort(), ['race', 'report.txt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git NUL records preserve renames, whitespace, Chinese names, and both status columns', () => {
  assert.deepEqual(parseGitStatus('RM 新 文件.ts\0旧 文件.ts\0?? weird\nname.txt\0 D removed.ts\0'), [
    { path: '新 文件.ts', originalPath: '旧 文件.ts', status: 'RM', staged: 'R', unstaged: 'M' },
    { path: 'weird\nname.txt', originalPath: undefined, status: '??', staged: '?', unstaged: '?' },
    { path: 'removed.ts', originalPath: undefined, status: 'D', staged: ' ', unstaged: 'D' },
  ]);
});

test('search respects hidden filters and never follows directory symlinks outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-file-search-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'Report.md'), 'report');
    await writeFile(join(root, '.report'), 'hidden');
    await writeFile(join(root, 'node_modules', 'report.js'), 'dependency');
    await symlink(tmpdir(), join(root, 'outside'));
    const listed = await listFiles(root, '.', false);
    assert.ok(!listed.some(i => i.name === 'node_modules' || i.name === '.report'));
    assert.equal(listed.find(i => i.name === 'outside').isDir, false);
    assert.deepEqual((await searchFiles(root, 'report', false)).items.map(i => i.path), ['src/Report.md']);
    assert.equal((await searchFiles(root, 'report', true)).items.length, 3);
    await assert.rejects(listFiles(root, '../', true), /escapes workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git previews cover unborn repositories, staged and working edits, deleted and renamed paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-file-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init');
    await writeFile(join(root, 'edit.txt'), 'first\n');
    git('add', 'edit.txt');
    await writeFile(join(root, 'edit.txt'), 'second\n');
    assert.match(await gitDiff(root, 'edit.txt', 'all'), /\+second/);
    assert.match(await gitDiff(root, 'edit.txt', 'staged'), /\+first/);
    await writeFile(join(root, 'deleted.txt'), 'remove me\n');
    await writeFile(join(root, '旧 文件.txt'), 'rename me\n');
    git('add', '.');
    git('-c', 'user.name=File Test', '-c', 'user.email=file-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test fixture');
    await writeFile(join(root, 'edit.txt'), 'staged edit\n');
    git('add', 'edit.txt');
    await writeFile(join(root, 'edit.txt'), 'working edit\n');
    await rm(join(root, 'deleted.txt'));
    await rename(join(root, '旧 文件.txt'), join(root, '新 文件.txt'));
    git('add', '--', '旧 文件.txt', '新 文件.txt');
    await writeFile(join(root, 'new.txt'), 'untracked\n');
    const changes = (await gitChanges(root)).changes;
    assert.equal(changes.find(c => c.path === 'edit.txt').status, 'MM');
    assert.equal(changes.find(c => c.path === '新 文件.txt').originalPath, '旧 文件.txt');
    assert.match(await gitDiff(root, 'edit.txt', 'staged'), /\+staged edit/);
    assert.match(await gitDiff(root, 'edit.txt', 'unstaged'), /\+working edit/);
    assert.match(await gitDiff(root, 'deleted.txt', 'all'), /-remove me/);
    assert.match(await gitDiff(root, '新 文件.txt', 'staged'), /rename from/);
    assert.match(await gitDiff(root, 'new.txt', 'all'), /\+untracked/);
    assert.equal(await gitDiff(root, 'new.txt', 'staged'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP file routes surface conflicts and stream downloads independently of preview support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pii-file-http-'));
  const server = createServer((req, res) => { void handleWorkspaceFiles(req, res, new URL(req.url, 'http://localhost'), {
    roots: async () => [root],
    preview: async (cwd, path) => (await resolveWorkspacePath(cwd, path, { extraRoots: [root] })).path,
  }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = (route, path, extra = '') => `http://127.0.0.1:${server.address().port}/api/${route}?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${extra}`;
  try {
    assert.equal((await fetch(url('files/upload', 'a.bin'), { method: 'POST', body: Buffer.from([0, 1, 2]) })).status, 200);
    assert.equal((await fetch(url('files/upload', 'a.bin'), { method: 'POST', body: 'replace' })).status, 409);
    assert.equal((await fetch(url('file', 'a.bin'))).status, 415);
    const download = await fetch(url('file', 'a.bin', '&download=1'));
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from([0, 1, 2]));
    assert.equal((await fetch(url('files/upload', 'a.bin', '&replace=1'), { method: 'POST', body: 'replacement' })).status, 200);
    assert.equal((await (await fetch(url('file', 'a.bin'))).json()).content, 'replacement');
    assert.equal((await fetch(url('file', '../outside'))).status, 400);
    const list = await (await fetch(url('files', '.', '&hidden=0'))).json();
    assert.equal(list.items[0].path, 'a.bin');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
