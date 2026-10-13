/** @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { configureExtensionStartup } from '../dist/extension-startup-policy.js';
test('host defaults to quick startup without overriding operator policy', () => {
  const env = {};
  configureExtensionStartup(env);
  assert.equal(env.PI_LENS_STARTUP_MODE, 'quick');
  for (const value of ['full', 'minimal', 'quick', '']) {
    const explicit = {PI_LENS_STARTUP_MODE: value};
    configureExtensionStartup(explicit);
    assert.equal(explicit.PI_LENS_STARTUP_MODE, value);
  }
});
