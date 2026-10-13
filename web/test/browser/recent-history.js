async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?count=0');
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.recentHistoryStart());
  await page.waitForFunction(() => window.fixture.recentHistoryState().visible >= 50 && !window.fixture.recentHistoryState().inFlight);
  const hydrated = await page.evaluate(() => window.fixture.recentHistoryState());
  check(hydrated.requests >= 5 && hydrated.requests <= 6, `background hydration failed or repeated: ${JSON.stringify(hydrated)}`);
  check(await page.locator('.msg-row').count() >= 50, 'loaded messages are hidden by DOM window');
  check(await page.locator('.tool-result-image').count() === 1, 'screenshot/tool call was stranded on a previous page');
  const beforeRefresh = await page.locator('.msg-row').count();
  await page.evaluate(() => window.fixture.recentHistoryRefresh());
  check(await page.locator('.msg-row').count() === beforeRefresh, 'thin reconnect snapshot erased loaded messages');

  // Reading an older message must not jump to the newest response on compaction.
  const middle = page.getByText('History conversation 195', { exact: true });
  await middle.scrollIntoViewIfNeeded();
  await page.locator('.chat-scroll').hover();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(250);
  const before = await middle.boundingBox();
  await page.evaluate(() => window.fixture.recentHistoryCompact());
  await page.getByText('New response after compaction', { exact: true }).waitFor({ state: 'attached' });
  await page.waitForTimeout(250);
  const after = await middle.boundingBox();
  check(before && after && Math.abs(after.y - before.y) < 4, `compaction moved reading position: ${JSON.stringify({ before, after })}`);
  check(await page.locator('.msg-row').count() === beforeRefresh + 1, 'compaction new tail replaced prior history');
  check(await page.locator('.tool-result-image').count() === 1, 'compaction removed historical image');
  check((await page.evaluate(() => window.fixture.recentHistoryState())).requests === hydrated.requests, 'compaction needlessly fetched retained history');

  const older = page.getByRole('button', { name: /加载更早的消息/ });
  await older.scrollIntoViewIfNeeded();
  await older.click();
  await page.waitForFunction(count => window.fixture.recentHistoryState().loaded > count && !window.fixture.recentHistoryState().inFlight, hydrated.loaded + 1);
  check(await page.locator('.msg-row').count() > beforeRefresh + 1, 'manual older history stopped working');
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow after backfill');
  await page.evaluate(() => window.fixture.recentHistoryBranch());
  await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 50);
  check(await page.getByText('History conversation 195', { exact: true }).count() === 0, 'old branch contaminated switched branch');
  check(await page.getByText('Other branch 49', { exact: true }).count() === 1, 'new branch missing');
  return { result: 'PASS: automatic 50-message hydration, screenshot retained, thin reconnect/compaction continuity, stable scroll, manual older history and branch isolation', hydrated };
}
