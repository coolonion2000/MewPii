import assert from 'node:assert/strict';
import test from 'node:test';
import { imageDataUrl, imageFit, clampImageZoom } from '../src/image-preview-utils.ts';
test('thumbnail and preview share a safe MIME fallback', () => {
  for (const mime of [undefined, null, 3, '', 'text/html', 'image/png;bad']) {
    assert.equal(imageDataUrl('abc', mime), 'data:image/png;base64,abc');
  }
  assert.equal(imageDataUrl('abc', 'image/webp'), 'data:image/webp;base64,abc');
});
test('fit keeps large images in phone and landscape viewports without upscaling small images', () => {
  assert.equal(imageFit(100, 100, 390, 844), 1);
  for (const [w, h] of [[390, 844], [844, 390], [1280, 720]]) {
    const fit = imageFit(4000, 3000, w, h);
    assert.ok(4000 * fit <= w - 40 + .001);
    assert.ok(3000 * fit <= h - 140 + .001);
  }
  assert.ok(imageFit(4000, 3000, 20, 80) > 0);
});
test('zoom is bounded but original size is reachable for very large images', () => {
  assert.equal(clampImageZoom(0, .1), .25);
  assert.equal(clampImageZoom(100, .5), 5);
  assert.equal(clampImageZoom(1 / .01, .01) * .01, 1);
});
