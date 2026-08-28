import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthUiComponent } from '../dist/auth-ui.js';

function createComponent() {
  let renders = 0;
  const component = new AuthUiComponent({ requestRender: () => { renders += 1; } }, 'Test Provider', 'Test OAuth');
  return { component, get renders() { return renders; } };
}

test('auth UI handles provider selects and secret input without rendering the secret', async () => {
  const harness = createComponent();
  const select = harness.component.prompt({
    type: 'select',
    message: 'Choose method',
    options: [
      { id: 'browser', label: 'Browser' },
      { id: 'device', label: 'Device code' },
    ],
  });
  harness.component.handleInput('\u001b[B');
  harness.component.handleInput('\r');
  assert.equal(await select, 'device');

  const secret = harness.component.prompt({ type: 'secret', message: 'API key' });
  harness.component.handleInput('sk-secret');
  assert.doesNotMatch(harness.component.render(100).join('\n'), /sk-secret/);
  assert.match(harness.component.render(100).join('\n'), /•••••••••/);
  harness.component.handleInput('\u007f');
  harness.component.handleInput('\r');
  assert.equal(await secret, 'sk-secre');
  assert.ok(harness.renders >= 4);
});

test('auth UI renders OAuth links and rejects a pending prompt on cancel', async () => {
  const { component } = createComponent();
  component.notify({ type: 'auth_url', url: 'https://example.test/login', instructions: 'Open this link' });
  assert.match(component.render(100).join('\n'), /https:\/\/example\.test\/login/);

  const prompt = component.prompt({ type: 'manual_code', message: 'Paste code' });
  component.handleInput('\u001b');
  await assert.rejects(prompt, /Login cancelled/);
  assert.equal(component.signal.aborted, true);
});
