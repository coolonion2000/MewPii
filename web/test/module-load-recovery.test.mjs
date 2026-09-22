/** Recovery from stale lazy imports after a web rebuild. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => 'zh' };
let reloads = 0;
globalThis.window = { location: { reload() { reloads++; } } };
const container = { nodeType: 1 };
globalThis.document = { querySelector: () => container, body: container };

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/ErrorBoundary.tsx', import.meta.url))],
  bundle: true, format: 'esm', platform: 'browser', write: false,
});
const { default: ErrorBoundary, isModuleLoadError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

function buttons(node) {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children ?? node.children;
  return [
    ...(node.type === 'button' ? [node] : []),
    ...(Array.isArray(children) ? children : [children]).flatMap(buttons),
  ];
}

test('failed lazy imports offer a page reload instead of retrying the cached rejection', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: http://localhost/assets/SubagentRunDialog-old.js',
    'error loading dynamically imported module: http://localhost/assets/dialog.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/dialog.css',
  ]) {
    const error = new TypeError(message);
    assert.equal(isModuleLoadError(error), true);
    const boundary = new ErrorBoundary({ children: 'chat' });
    boundary.state = { error };
    const [reload] = buttons(boundary.render());
    assert.equal(reload.props.children, '重新加载页面');
    const before = reloads;
    reload.props.onClick();
    assert.equal(reloads, before + 1);
    assert.equal(boundary.state.error, error);
  }
});

test('ordinary component errors still retry locally without reloading the page', () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'type')");
  assert.equal(isModuleLoadError(error), false);
  const boundary = new ErrorBoundary({ children: 'chat' });
  boundary.state = { error };
  boundary.setState = (state) => { boundary.state = { ...boundary.state, ...state }; };
  const before = reloads;
  const [retry] = buttons(boundary.render());
  assert.equal(retry.props.children, '重试');
  retry.props.onClick();
  assert.equal(boundary.render(), 'chat');
  assert.equal(reloads, before);
});

test('an optional dialog failure is dismissible without forcing the chat to reload', () => {
  let dismissed = 0;
  const boundary = new ErrorBoundary({ children: 'dialog', onDismiss: () => { dismissed++; } });
  assert.equal(boundary.render(), 'dialog');
  boundary.state = { error: new TypeError('Importing a module script failed.') };
  const portal = boundary.render();
  assert.equal(portal.containerInfo, container);
  const before = reloads;
  const close = buttons(portal).find((button) => button.props.children === '关闭');
  assert.ok(close);
  close.props.onClick();
  assert.equal(dismissed, 1);
  assert.equal(reloads, before);
});
