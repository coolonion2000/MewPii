async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html');
  await page.waitForFunction(() => window.fixture);
  await page.locator('input[type=file]').evaluate(async input => {
    const transfer = new DataTransfer();
    for (const [width, height] of [[2400, 400], [400, 2400], [800, 800]]) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#abcdef'; ctx.fillRect(0, 0, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      transfer.items.add(new File([blob], `${width}x${height}.png`, {type: 'image/png'}));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await page.waitForFunction(() => document.querySelectorAll('.image-thumb img').length === 3 && [...document.querySelectorAll('.image-thumb img')].every(i => i.complete && i.naturalWidth));
  for (const width of [1200, 390]) {
    await page.setViewportSize({width, height: 850});
    const positions = await page.locator('.image-thumb').evaluateAll(nodes => nodes.map(node => {
      const image = node.querySelector('img').getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const button = node.querySelector('.image-remove').getBoundingClientRect();
      return {gap: Math.abs(box.right - image.right), dx: Math.abs(button.right - 6 - image.right), dy: Math.abs(button.top + 6 - image.top), visible: button.right <= innerWidth && button.left >= 0};
    }));
    check(positions.every(p => p.gap < 1 && p.dx < 1 && p.dy < 1 && p.visible), `misaligned at ${width}: ${JSON.stringify(positions)}`);
  }
  await page.getByRole('button', {name: '图片预览: 2400x400.png', exact: true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', {name: '关闭', exact: true}).click();
  await page.getByRole('button', {name: '移除图片', exact: true}).first().click();
  check(await page.locator('.image-thumb').count() === 2, 'remove failed');
  check(await page.getByRole('dialog').count() === 0, 'remove opened preview');
  return 'PASS: wide/portrait/square alignment at desktop/mobile widths; preview and removal';
}
