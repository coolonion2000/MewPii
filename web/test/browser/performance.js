async (page) => {
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    if (window.longTasks) return;
    window.longTasks = [];
    new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true });
  });
  const results = [];
  for (const count of [120, 2000]) {
    await page.setViewportSize({ width: 390, height: 844 });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:31049/test/browser/fixture.html?count=${count}`);
    await page.waitForFunction(() => window.fixture && document.querySelector('.composer'));
    await page.waitForFunction(() => { const n = document.querySelector('.chat-scroll'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
    const initialMs = Date.now() - start;
    const metrics = await page.evaluate(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await frame();
      const initialLongTasks = window.longTasks.splice(0);
      const nodes = document.querySelectorAll('*').length;
      const switchMs = [];
      for (let i = 0; i < 4; i++) {
        const start = performance.now(); window.fixture.switchSession(); await frame(); switchMs.push(Math.round(performance.now() - start));
      }
      const switchLongTasks = window.longTasks.splice(0);
      const streamMs = [];
      for (let i = 1; i <= 40; i++) {
        const start = performance.now(); window.fixture.stream(i); await frame(); streamMs.push(Math.round(performance.now() - start));
      }
      const streamLongTasks = window.longTasks.splice(0);
      const scroll = document.querySelector('.chat-scroll');
      const scrollMs = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now(); scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (1 - i / 40); await frame(); scrollMs.push(Math.round(performance.now() - start));
      }
      const summary = a => ({ max: Math.round(Math.max(0, ...a)), count: a.length });
      const p95 = a => [...a].sort((a,b) => a-b)[Math.floor(a.length * .95)];
      return { nodes, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, switchMs, streamP95Ms: p95(streamMs), scrollP95Ms: p95(scrollMs), initialLongTasks: summary(initialLongTasks), switchLongTasks: summary(switchLongTasks), streamLongTasks: summary(streamLongTasks), scrollLongTasks: summary(window.longTasks) };
    });
    results.push({ count, initialMs, ...metrics });
  }
  return results;
}
