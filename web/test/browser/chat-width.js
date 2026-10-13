async (page) => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('http://127.0.0.1:31049/test/browser/fixture.html');
  await page.evaluate(() => localStorage.setItem('pii-chat-w', '2000'));
  await page.reload();
  await page.waitForFunction(() => window.fixture);
  // Use the production sidebar hit-zone CSS, without connecting a live session.
  await page.evaluate(() => {
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.style.width = '300px';
    sidebar.innerHTML = '<div class="sidebar-resize"></div>';
    sidebar.querySelector('div').addEventListener('pointerdown', () => sidebar.dataset.hit = 'yes');
    document.querySelector('.app').prepend(sidebar);
  });
  const geometry = () => page.evaluate(() => {
    const main = document.querySelector('.chat-main').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar-resize').getBoundingClientRect();
    const handles = [...document.querySelectorAll('.chat-width-resize')].map(node => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, hit: document.elementFromPoint(r.x + r.width / 2, r.y + 80) === node };
    });
    return { main: {left: main.left, right: main.right}, sidebar: sidebar.right, handles,
      width: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-content-width')) };
  });
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-content-width')) < 1000);
  const initial = await geometry();
  check(initial.handles[0].left > initial.sidebar, 'sidebar and chat hot zones overlap');
  check(initial.handles.every(h => h.hit && h.left >= initial.main.left && h.right <= initial.main.right), 'handle clipped or intercepted');
  for (const selector of ['.chat-width-resize:not(.right)', '.chat-width-resize.right']) {
    const before = (await geometry()).width;
    const r = await page.locator(selector).boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + 80);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + (selector.endsWith('.right') ? -30 : 30), r.y + 80, {steps: 5});
    await page.mouse.up();
    check((await geometry()).width < before, 'chat drag did not resize');
    check(await page.locator('.sidebar').getAttribute('data-hit') === null, 'chat drag reached sidebar');
  }
  await page.locator('.sidebar-resize').click();
  check(await page.locator('.sidebar').getAttribute('data-hit') === 'yes', 'sidebar handle stopped receiving input');
  await page.evaluate(() => { document.querySelector('.sidebar').style.width = '480px'; });
  await page.setViewportSize({width: 1000, height: 800});
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-content-width')) < 480);
  const narrow = await geometry();
  check(narrow.handles[0].left > narrow.sidebar && narrow.handles.every(h => h.hit), 'narrow pane lost independent handles');
  return {initial, narrow, bothChatHandlesDraggable: true, sidebarReceivesInput: true};
}
