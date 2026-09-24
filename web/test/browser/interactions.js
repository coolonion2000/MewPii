async (page) => {
  page.setDefaultTimeout(8000);
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html');
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.preview());
  await page.getByRole('button', { name: '原始大小', exact: true }).click();
  check(await page.locator('.lightbox-scale').innerText() === '100%', 'original size is not 100%');
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  check(await page.locator('.lightbox-scale').innerText() === '80%', 'zoom out failed');
  const view = page.locator('.lightbox-viewport');
  await view.hover(); await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => document.querySelector('.lightbox-scale').textContent !== '80%');
  const before = await view.evaluate(n => n.scrollLeft);
  const rect = await view.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 - 80, rect.y + rect.height / 2, { steps: 4 }); await page.mouse.up();
  check(await view.evaluate(n => n.scrollLeft) > before, 'drag did not pan');
  await page.getByRole('button', { name: '适应窗口', exact: true }).click();
  await page.keyboard.press('Escape');
  check(await page.getByRole('dialog').count() === 0, 'Escape failed');
  await page.evaluate(() => window.fixture.preview());
  await page.mouse.click(2, 2);
  check(await page.getByRole('dialog').count() === 0, 'outside click failed');
  await page.evaluate(() => window.fixture.preview(true));
  await page.getByRole('status').filter({ hasText: '图片加载失败' }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '图片加载失败' }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '展开输入框', exact: true }).click();
  await page.getByRole('textbox').fill('unsent fixture draft');
  await page.locator('input[type=file]').evaluate(input => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'fixture.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: '图片预览: fixture.png', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  check(await page.getByRole('textbox').inputValue() === 'unsent fixture draft', 'preview lost draft');
  await page.getByRole('button', { name: '移除图片', exact: true }).click();
  await page.locator('.stats-footer button').first().click();
  await page.locator('.stats-footer > button, .stats-footer .stats-chip').count();
  const stats = page.locator('.stats-footer button[aria-expanded]');
  await stats.nth(1).click();
  check(await page.locator('.stats-popover').count() === 1, 'stats popovers overlap');
  await page.mouse.click(2, 2);
  check(await page.locator('.stats-popover').count() === 0, 'stats outside click failed');
  await page.getByRole('textbox').click();

  // Simulate an overlay keyboard: layout viewport unchanged, visual viewport shrinks.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--mobile-viewport-height') === '420px');
  check((await page.locator('.composer').boundingBox()).y + (await page.locator('.composer').boundingBox()).height <= 420, 'keyboard hides composer');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const menu = await page.locator('.combined-menu').boundingBox();
  check(menu && menu.y >= 0 && menu.y + menu.height <= 420, 'keyboard hides model menu');
  await page.getByRole('textbox').click();
  await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
  await page.setViewportSize({ width: 844, height: 390 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'landscape overflows');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.fixture.preview());
  await page.getByRole('button', { name: '原始大小', exact: true }).waitFor();
  const client = await page.context().newCDPSession(page);
  const box = await view.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const percentage = await page.locator('.lightbox-scale').innerText();
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 70, y, id: 1 }, { x: x + 70, y, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(old => document.querySelector('.lightbox-scale').textContent !== old, percentage);
  await client.detach();
  const close = await page.getByRole('button', { name: '关闭', exact: true }).boundingBox();
  check(close.x >= 0 && close.x + close.width <= 390 && close.y >= 0, 'phone close button out of viewport');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.fixture.switchSession());
  await page.waitForFunction(() => { const n = document.querySelector('.chat-scroll'); return n && n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?count=2000');
  await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 120);
  const older = page.getByRole('button', { name: '加载更早的消息 (1880)', exact: true });
  await older.scrollIntoViewIfNeeded();
  await older.click();
  await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 240);
  // Tail-follow pointer release settles after 100 ms; assert after that timer too.
  await page.waitForTimeout(200);
  check(await page.evaluate(() => { const n = document.querySelector('.chat-scroll'); return n.scrollHeight - n.scrollTop - n.clientHeight > 100; }), 'revealing history jumped to bottom');
  await page.getByRole('button', { name: '加载更早的消息 (1760)', exact: true }).waitFor();
  return 'PASS: zoom, original, wheel, drag, pinch, close, error/retry, attachment/draft, stats exclusivity, mobile keyboard/menu, landscape, session tail, incremental history';
}
