async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?reliability=1&count=8');
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => { window.fixture.receipt(); window.fixture.phase('running'); });
  await frame();
  const before = await page.locator('.composer').boundingBox();
  await page.evaluate(() => window.fixture.receipt('accepted'));
  const receipt = page.locator('.composer-receipt');
  const trigger = receipt.locator('button');
  await receipt.waitFor();
  const after = await page.locator('.composer').boundingBox();
  check(Math.abs(before.height - after.height) < 1, 'acknowledgement adds a full row');
  check(await page.locator('.composer-deliveries').count() === 0, 'accepted banner remains below input');
  check(await trigger.getAttribute('aria-label') === '服务端已接收（不代表任务已完成）', 'receipt implies task completion');
  const iconBox = await trigger.boundingBox(), stopBox = await page.locator('.send-circle').boundingBox();
  check(iconBox.x + iconBox.width <= stopBox.x && stopBox.x - iconBox.x - iconBox.width < 16, 'receipt is not beside send');
  await trigger.hover();
  await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  await page.mouse.move(0, 0);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tooltip').waitFor();
  await page.locator('.chat-header').click();
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const dark of [false, true]) {
      await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
      await page.locator('.chat-header').click();
      check(await page.locator('.composer').evaluate(node => node.classList.contains('mobile-compact')), 'phone input did not collapse');
      await trigger.waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '中断运行', exact: true }).waitFor({ state: 'visible' });
      check(await receipt.locator('.composer-receipt-label').isVisible() === false, 'phone receipt should be icon only');
      check((await page.locator('.composer').boundingBox()).height < 60, 'receipt expands the compact phone input');
      await trigger.dispatchEvent('click'); // Touch-style activation: no preceding mouse hover.
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      const tip = await tooltip.boundingBox();
      check(tip.x >= 0 && tip.x + tip.width <= width, 'tooltip extends outside phone viewport');
      const send = await page.locator('.send-circle').boundingBox();
      check(tip.y + tip.height <= send.y, 'tooltip covers send/stop');
      await page.locator('.chat-header').click();
      await tooltip.waitFor({ state: 'hidden' });
      await page.locator('.composer textarea').click();
      await frame();
      await page.getByRole('button', { name: '中断运行', exact: true }).waitFor({ state: 'visible' });
      const button = await page.locator('.send-circle').boundingBox(), badge = await trigger.boundingBox();
      check(Math.abs(button.y + button.height / 2 - badge.y - badge.height / 2) < 3, 'receipt wraps away from send on phone');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone horizontal overflow');
    }
  }
  await page.evaluate(() => window.fixture.phase('ready'));
  await page.locator('.composer textarea').fill('Unconfirmed message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('[data-delivery="unknown"]').waitFor();
  await page.evaluate(() => window.fixture.receipt('accepted'));
  check(await receipt.count() === 0, 'latest accepted badge hides an older unconfirmed message');
  await page.getByRole('button', { name: '确认发送状态', exact: true }).waitFor({ state: 'visible' });
  await page.evaluate(() => localStorage.setItem('pii-lang', 'en'));
  await page.reload();
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => { window.fixture.receipt('accepted'); window.fixture.phase('running'); });
  await page.locator('.composer textarea').click();
  check(await trigger.getAttribute('aria-label') === 'Received by server (task is not necessarily complete)', 'English description missing');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'English layout overflows');
  await page.evaluate(() => localStorage.setItem('pii-lang', 'zh'));
  return { result: 'PASS: inline receipt, hover/tap/keyboard detail, outside/Escape close, 320/390px compact/expanded, light/dark, unresolved priority, English' };
}
