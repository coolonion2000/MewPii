async (page) => {
  page.setDefaultTimeout(10000);
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html?count=2000');
  await page.waitForFunction(() => window.fixture && document.querySelectorAll('.msg-row').length === 120);
  await page.evaluate(() => window.fixture.observeFinalizedReads());
  const reads = await page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    const before = window.fixture.finalizedRoleReads();
    for (let i = 1; i <= 40; i++) { window.fixture.stream(i); await frame(); }
    return { before, after: window.fixture.finalizedRoleReads() };
  });
  check(reads.after === reads.before, `40 text deltas re-read finalized history: ${reads.after - reads.before}`);
  const older = page.getByRole('button', { name: '加载更早的消息 (1880)', exact: true });
  await older.scrollIntoViewIfNeeded();
  await older.click();
  await page.waitForFunction(() => document.querySelectorAll('.msg-row').length === 241);
  await page.waitForTimeout(200); // The tail follower's explicit pointer-release timer.
  check(await page.evaluate(() => { const n = document.querySelector('.chat-scroll'); return n.scrollHeight - n.scrollTop - n.clientHeight > 100; }), 'history reveal jumped to the bottom');
  await page.getByRole('button', { name: '加载更早的消息 (1760)', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.stream(41));
  check(await page.locator('.msg-row').count() === 241, 'streaming reset the expanded history window');
  await page.getByRole('button', { name: '↓ 回到底部', exact: true }).click();
  await page.waitForFunction(() => { const n = document.querySelector('.chat-scroll'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  await page.evaluate(() => window.fixture.setInitializing(true));
  check(await page.locator('.chat-header').getByText('运行中', { exact: true }).count() === 0, 'initializing session still claims to be running');
  await page.evaluate(() => window.fixture.switchSession());
  await page.waitForFunction(() => { const n = document.querySelector('.chat-scroll'); return n && n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  check(await page.locator('.msg-row').count() === 8, 'new session retained old transcript window');
  return { result: 'PASS: 2000-message window, history reveal, anchored streaming, jump to tail, session switch, initialization guard', finalizedReadsDuring40Deltas: reads.after - reads.before };
}
