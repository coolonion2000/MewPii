import assert from 'node:assert/strict';
import test from 'node:test';
import { trackMobileViewport } from '../src/mobile-viewport.ts';
test('keyboard resize and pan are batched; page zoom is preserved and desktop styles are removed', () => {
  const values = new Map();
  let pending;
  const visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 844, visualViewport,
    document: { documentElement: { style: { setProperty: (k,v) => values.set(k,v), removeProperty: k => values.delete(k) } } },
    requestAnimationFrame: cb => { pending = cb; return 1; }, cancelAnimationFrame: () => { pending = undefined; },
  });
  const dispose = trackMobileViewport(win);
  assert.equal(values.get('--mobile-viewport-height'), '844px');
  visualViewport.height = 420; visualViewport.offsetTop = 30;
  visualViewport.dispatchEvent(new Event('resize')); pending();
  assert.equal(values.get('--mobile-viewport-height'), '420px');
  assert.equal(values.get('--mobile-viewport-top'), '30px');
  visualViewport.scale = 2; visualViewport.height = 200;
  visualViewport.dispatchEvent(new Event('resize')); pending();
  assert.equal(values.get('--mobile-viewport-height'), '420px');
  win.innerWidth = 1280; win.dispatchEvent(new Event('resize')); pending();
  assert.equal(values.size, 0);
  dispose();
});
