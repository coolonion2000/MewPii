async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?reliability=1&count=8');
  await page.waitForFunction(() => window.fixture);
  for (const phase of ['connecting', 'initializing', 'reconnecting', 'unresponsive', 'failed']) {
    await page.evaluate(value => window.fixture.phase(value), phase);
    await page.locator(`[data-phase="${phase}"]`).waitFor();
    check(await page.locator('.composer-session-status').count() === 1, `duplicate ${phase} banners`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${phase} causes horizontal overflow`);
  }
  await page.evaluate(() => window.fixture.phase('compacting'));
  await page.getByRole('button', {name: '中断运行', exact: true}).waitFor();
  await page.evaluate(() => window.fixture.phase('ready'));
  const editor = page.locator('.composer textarea');
  await editor.fill('Receipt lost message');
  await page.getByRole('button', {name: '发送', exact: true}).click();
  await page.locator('[data-delivery="unknown"]').waitFor();
  check(await editor.inputValue() === '', 'unknown receipt restores a resendable draft');
  await page.getByRole('button', {name: '确认发送状态', exact: true}).click();
  await page.locator('[data-delivery="accepted"]').waitFor();
  check(await page.evaluate(() => window.fixture.sent.length) === 1, 'receipt query resent a message');
  await editor.fill('Rejected after query');
  await page.getByRole('button', {name: '发送', exact: true}).click();
  await page.locator('[data-delivery="unknown"]').waitFor();
  await page.evaluate(() => { window.fixture.rejectDelivery = true; });
  await page.getByRole('button', {name: '确认发送状态', exact: true}).click();
  await page.locator('[data-delivery="failed"]').waitFor();
  check(await editor.inputValue() === 'Rejected after query', 'explicit rejection lost the original draft');
  check(await page.evaluate(() => window.fixture.sent.length) === 2, 'rejection query resent a message');
  await editor.fill('Unknown A');
  await page.getByRole('button', {name: '发送', exact: true}).click();
  await page.locator('[data-delivery="unknown"]').waitFor();
  await editor.fill('Unknown B');
  await page.getByRole('button', {name: '发送', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-delivery="unknown"]').length === 2);
  await page.getByRole('button', {name: '确认发送状态', exact: true}).first().click();
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === 'Unknown A');
  check(await page.locator('[data-delivery="unknown"]').count() === 1, 'later message hid the earlier unknown receipt');
  await page.getByRole('button', {name: '确认发送状态', exact: true}).click();
  await page.getByRole('button', {name: '追加恢复草稿', exact: true}).waitFor();
  check(await editor.inputValue() === 'Unknown A', 'rejecting B overwrote restored A');
  await page.getByRole('button', {name: '追加恢复草稿', exact: true}).click();
  check(await editor.inputValue() === 'Unknown A\n\nUnknown B', 'second rejected message was lost');
  check(await page.evaluate(() => window.fixture.sent.length) === 4, 'multi-message query replayed a prompt');
  await page.setViewportSize({width: 1440, height: 1000});
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop overflow');
  return {result: 'PASS: five connection phases, mobile layout, lost receipt, query without replay, rejected draft recovery'};
}
