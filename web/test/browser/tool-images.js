async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?tool-images=1&count=0');
  await page.waitForFunction(() => window.fixture);
  const cards = page.locator('.tool-card');
  check(await cards.count() === 7, 'fixture cards missing');
  const mixed = cards.nth(0);
  await mixed.scrollIntoViewIfNeeded();
  await mixed.locator('.tool-result-image').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const image = document.querySelector('.tool-result-image img');
    return image?.complete && image.naturalWidth === 1600;
  });
  const order = await mixed.locator('.tool-output-content').evaluate(node => [...node.children].map(child => child.tagName));
  check(order.join(',') === 'PRE,BUTTON,PRE,BUTTON', `text/image order lost: ${order}`);
  check(await cards.nth(1).locator('.tool-result-image').count() === 1, 'image-only result missing');
  check(!(await cards.nth(1).innerText()).includes('执行中'), 'image-only result claims running');
  await cards.nth(2).locator('.tool-card-header').click();
  check((await cards.nth(2).innerText()).includes('无可显示的输出'), 'completed empty result claims running');
  check((await cards.nth(3).innerText()).includes('图片加载失败'), 'malformed image has no fallback');
  await cards.nth(4).locator('.tool-result-image').scrollIntoViewIfNeeded();
  await cards.nth(4).getByText('图片加载失败').waitFor();
  await cards.nth(4).getByRole('button', { name: '图片预览', exact: true }).click();
  await page.getByRole('dialog').getByText('图片加载失败').waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('dialog').getByText('图片加载失败').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  check(await cards.nth(5).locator('.diff-add').count() === 1, 'diff formatting lost');
  check(await cards.nth(5).locator('.tool-result-image').count() === 1, 'diff removed image');
  check(!(await cards.nth(5).innerText()).includes('Replaced edit text'), 'diff did not replace text');
  check((await cards.nth(6).innerText()).includes('Capturing screenshot...'), 'live output lost');
  await page.evaluate(() => window.fixture.finishImageTool());
  await cards.nth(6).locator('.tool-result-image').waitFor();
  check(await cards.nth(6).locator('.tool-status.running').count() === 0, 'final result retained stale running status');
  check(!(await cards.nth(6).innerText()).includes('Capturing screenshot...'), 'stale live output retained');

  await mixed.locator('.tool-card-header').click();
  check(await mixed.locator('img').count() === 0, 'folding still mounts large images');
  await mixed.locator('.tool-card-header').click();
  await mixed.locator('.tool-result-image').first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  const zoomIn = page.getByRole('button', { name: '放大', exact: true });
  await page.waitForFunction(() => !document.querySelector('.lightbox-controls button')?.disabled);
  const scale = await page.locator('.lightbox-scale').innerText();
  await zoomIn.click();
  check(await page.locator('.lightbox-scale').innerText() !== scale, 'zoom did not change');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const dark of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
      await mixed.locator('.tool-result-image').first().scrollIntoViewIfNeeded();
      const box = await mixed.locator('.tool-result-image').first().boundingBox();
      check(box && box.width > 100 && box.x >= 0 && box.x + box.width <= width, `image overflow at ${width}, dark=${dark}: ${JSON.stringify(box)}`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}, dark=${dark}`);
      await mixed.locator('.tool-result-image').first().click();
      await page.getByRole('dialog').waitFor();
      const close = await page.getByRole('button', { name: '关闭', exact: true }).boundingBox();
      check(close && close.x >= 0 && close.x + close.width <= width, `preview close outside viewport ${width}`);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    }
  }
  await page.reload();
  await page.waitForFunction(() => window.fixture);
  check(await cards.nth(0).locator('.tool-result-image').count() === 2, 'restored historical images missing');
  check(await cards.nth(1).locator('.tool-result-image').count() === 1, 'restored image-only result missing');
  await page.setViewportSize({ width: 390, height: 844 });
  await mixed.locator('.tool-result-image').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/pii-tool-images-mobile.png' });
  return 'PASS: mixed/image-only/history PNGs, malformed/invalid images, diff, live-to-final, folding, keyboard preview/zoom/close, mobile/tablet/desktop and light/dark';
}
