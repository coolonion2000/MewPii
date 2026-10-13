import assert from 'node:assert/strict';
import test from 'node:test';
import { hasToolResultImage, toolResultContent } from '../src/tool-result-content.ts';
import { imageDataUrl } from '../src/image-preview-utils.ts';

const firstImage = Object.freeze({ type: 'image', data: 'cG5n', mimeType: 'image/png' });
const secondImage = Object.freeze({ type: 'image', data: 'd2VicA==', mimeType: 'image/webp' });

test('tool results preserve text-image-text order and multiple image MIME types', () => {
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: 'Screenshot captured.' }),
    firstImage,
    Object.freeze({ type: 'text', text: 'Original size 2560x1262.' }),
    secondImage,
    Object.freeze({ type: 'text', text: 'Second screenshot.' }),
  ]);
  const output = toolResultContent(content);
  assert.deepEqual(output, content);
  assert.notEqual(output, content);
  assert.equal(hasToolResultImage(content), true);
});

test('image-only results remain visible without inventing text or an executing state', () => {
  assert.deepEqual(toolResultContent([firstImage]), [firstImage]);
  assert.deepEqual(toolResultContent([firstImage, secondImage]), [firstImage, secondImage]);
  assert.equal(hasToolResultImage([firstImage]), true);
});

test('malformed blocks are ignored and malformed image data becomes an explicit placeholder', () => {
  const content = [
    undefined, null, false, 17, [], 'bare block', {},
    { type: 'text', text: 17 }, { type: 'text', text: '' },
    { type: 'audio', data: 'audio' },
    { type: 'image' }, { type: 'image', data: null },
    { type: 'image', data: 17 }, { type: 'image', data: '' },
    { type: 'image', data: ' \n\t' },
    firstImage,
  ];
  assert.deepEqual(toolResultContent(content), [
    ...Array.from({ length: 5 }, () => ({ type: 'invalidImage' })), firstImage,
  ]);
  assert.equal(hasToolResultImage([{ type: 'image', data: '' }]), true,
    'malformed images should still reveal their failure placeholder');
});

test('a diff replaces all original text once without dropping or reordering images', () => {
  const content = Object.freeze([
    firstImage,
    Object.freeze({ type: 'text', text: 'Edited file.' }),
    secondImage,
    Object.freeze({ type: 'text', text: 'Verbose original output.' }),
  ]);
  assert.deepEqual(toolResultContent(content, '- old\n+ new'), [
    firstImage, { type: 'text', text: '- old\n+ new' }, secondImage,
  ]);
  assert.equal(content[1].text, 'Edited file.');
  assert.deepEqual(toolResultContent([firstImage, secondImage], '+ new'), [
    { type: 'text', text: '+ new' }, firstImage, secondImage,
  ]);
});

test('plain text and empty results keep existing diff fallback semantics', () => {
  assert.deepEqual(toolResultContent('plain output'), [{ type: 'text', text: 'plain output' }]);
  assert.deepEqual(toolResultContent('plain output', '+ diff'), [{ type: 'text', text: '+ diff' }]);
  for (const diff of [undefined, null, false, 17, {}, '']) {
    assert.deepEqual(toolResultContent('plain output', diff), [{ type: 'text', text: 'plain output' }]);
  }
  for (const content of [undefined, null, false, 17, {}, '', [], [null, {}]]) {
    assert.deepEqual(toolResultContent(content), []);
    assert.deepEqual(toolResultContent(content, '+ diff'), [{ type: 'text', text: '+ diff' }]);
    assert.equal(hasToolResultImage(content), false);
  }
});

test('image metadata uses the existing safe data URL helper rather than arbitrary URLs', () => {
  for (const mimeType of [undefined, null, 17, '', 'text/html', 'image/png;bad', 'image/png\" onerror=\"alert(1)']) {
    const [block] = toolResultContent([{ type: 'image', data: 'cG5n', mimeType }]);
    assert.equal(block.type, 'image');
    assert.equal(imageDataUrl(block.data, block.mimeType), 'data:image/png;base64,cG5n');
  }
  const [webp] = toolResultContent([secondImage]);
  assert.equal(imageDataUrl(webp.data, webp.mimeType), 'data:image/webp;base64,d2VicA==');
  const [urlLikeData] = toolResultContent([{ type: 'image', data: 'https://example.invalid/image.png' }]);
  assert.equal(imageDataUrl(urlLikeData.data, urlLikeData.mimeType),
    'data:image/png;base64,https://example.invalid/image.png');
});

test('default-open image detection never reads or constructs large image payloads', () => {
  const image = {
    type: 'image',
    get data() { throw new Error('Image payload must not be read to decide whether a card is open'); },
    get mimeType() { throw new Error('MIME metadata must not be read to decide whether a card is open'); },
  };
  assert.equal(hasToolResultImage([null, [], { type: 'text', text: 'before' }, image]), true);
  assert.equal(hasToolResultImage([{ type: 'text', text: 'image' }]), false);
});
