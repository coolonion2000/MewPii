/** Chat file-link routing and Markdown sanitization. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageLink } from '../src/message-links.ts';
import { successfulFileToolPaths, resolveToolAuthorizedPreviewPath } from '../../server/src/file-preview-access.ts';

test('resolve absolute, relative, escaped paths without changing symlink traversal', () => {
  for (const [href, path] of [
    ['/tmp/report.sql', '/tmp/report.sql'],
    ['./docs/report.sql', '/work/./docs/report.sql'],
    ['../other/report.sql', '/work/../other/report.sql'],
    ['README.md', '/work/README.md'],
    ['docs/%E4%B8%AD%E6%96%87%20a.md#section', '/work/docs/中文 a.md'],
    ['/tmp/a%23b%3Fc.sql?download=1', '/tmp/a#b?c.sql'],
  ]) assert.deepEqual(messageLink(href, '/work'), { kind: 'file', path });
  assert.deepEqual(messageLink('a.md'), { kind: 'invalid' });
});

test('web and fragment links stay distinct; invalid URLs are inert', () => {
  for (const href of ['https://example.com/a', 'http://localhost/', '//example.com', 'mailto:a@example.com'])
    assert.deepEqual(messageLink(href, '/work'), { kind: 'web', href });
  assert.deepEqual(messageLink('#section'), { kind: 'anchor', href: '#section' });
  for (const href of ['', undefined, 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', '/tmp/%00x', '/tmp/%zz', 'a\nb'])
    assert.deepEqual(messageLink(href, '/work'), { kind: 'invalid' });
});

test('assistant links alone never grant external preview permission', () => {
  assert.deepEqual(successfulFileToolPaths([{ role: 'assistant', content: [{ type: 'text', text: '[SQL](/tmp/private.sql)' }] }]), []);
});

test('server source authorizes only successful exact file calls, not adjacent files or prose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mewpii-link-test-'));
  try {
    const file = join(dir, 'allowed.sql'), other = join(dir, 'denied.sql');
    await writeFile(file, '-- preview only'); await writeFile(other, '-- not authorized');
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'read1', name: 'read', arguments: { path: file } }] },
      { role: 'toolResult', toolCallId: 'read1', isError: false },
    ];
    assert.equal(await resolveToolAuthorizedPreviewPath('/workspace', file, messages), await realpath(file));
    assert.equal(await resolveToolAuthorizedPreviewPath('/workspace', other, messages), undefined);
    assert.equal(await resolveToolAuthorizedPreviewPath('/workspace', file, [{ role: 'assistant', content: [{ type: 'text', text: `[SQL](${file})` }] }]), undefined);
    messages[1].isError = true;
    assert.equal(await resolveToolAuthorizedPreviewPath('/workspace', file, messages), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import Markdown from './src/components/MessageMarkdownBody';
    export const render = (text, enabled=true) => renderToStaticMarkup(<Markdown text={text} cwd="/work" onOpenFile={enabled ? () => {} : undefined}/>);
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
  bundle: true, format: 'esm', platform: 'node', write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require = createRequire(${JSON.stringify(fileURLToPath(new URL('../package.json', import.meta.url)))});` },
});
const { render } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
test('local files are keyboard accessible preview buttons, never navigation anchors', () => {
  const html = render('[SQL](/tmp/check.sql) [relative](docs/a.md) [web](https://example.com)');
  assert.match(html, /<button type="button" class="message-file-link" title="\/tmp\/check.sql">SQL<\/button>/);
  assert.match(html, /title="\/work\/docs\/a.md"/);
  assert.doesNotMatch(html, /href="\/tmp/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(render('[SQL](/tmp/a.sql)', false), /disabled=""/);
});
test('default sanitization remains active for links and images', () => {
  const html = render('[bad](javascript:alert) [file](file:///tmp/a) ![bad](javascript:alert)');
  assert.doesNotMatch(html, /(?:href|src)="(?:javascript|file):/);
  assert.doesNotMatch(html, /src=""/);
  assert.doesNotMatch(html, /message-file-link/);
});
