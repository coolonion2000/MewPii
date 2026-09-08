/** File navigation and Markdown resource path regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ancestorDirectories, fullFilePath, markdownFilePath, loadFileWorkspace } from '../src/file-workspace.ts';

test('relative preview resources use the file directory and preserve boundary traversal for the server', () => {
  assert.equal(markdownFilePath('docs/guide.md', '../web/logo.png'), 'web/logo.png');
  assert.equal(markdownFilePath('docs/guide.md', './another%20file.md#section'), 'docs/another file.md');
  assert.equal(markdownFilePath('README.md', '../outside.txt'), '../outside.txt');
  assert.equal(markdownFilePath('/work/docs/a.md', '../image.png'), '/work/image.png');
  assert.equal(markdownFilePath('docs/a.md', 'https://example.com/image.png'), undefined);
  assert.equal(markdownFilePath('docs/a.md', '#section'), undefined);
  assert.equal(fullFilePath('/work', '/work/file.txt'), '/work/file.txt');
  assert.deepEqual(ancestorDirectories('web/src/components/FilesPanel.tsx'), ['.', 'web', 'web/src', 'web/src/components']);
});

test('invalid saved state cannot restore escaping paths or unusable widths', () => {
  globalThis.localStorage = { getItem: () => JSON.stringify({ selected: '../secret', directory: '/outside', open: ['.', '../escape', 'web/src'], width: 9999 }) };
  try {
    assert.deepEqual(loadFileWorkspace('test'), { selected: undefined, directory: '.', open: ['.', 'web/src'], hidden: false, width: 480 });
  } finally { delete globalThis.localStorage; }
});
