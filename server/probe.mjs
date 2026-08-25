import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:31041/ws?cwd=' + encodeURIComponent('/Users/cosmo010225/Pii'), {
  headers: { Authorization: 'Basic ' + Buffer.from('pi:testpass').toString('base64') }
});
let sent = false;
ws.on('message', (d) => {
  const msg = JSON.parse(String(d));
  if (msg.type === 'snapshot' && !sent && msg.snapshot.model) {
    sent = true;
    const m = 'vis-probe-' + Date.now();
    console.log('sent:', m);
    ws.send(JSON.stringify({ id: '1', type: 'prompt', message: m }));
    // 2s 后直接抓 API 原始返回
    setTimeout(async () => {
      const res = await fetch('http://127.0.0.1:31041/api/sessions');
      const text = await res.text();
      console.log('contains sent msg:', text.includes(m));
      process.exit(text.includes(m) ? 0 : 1);
    }, 2000);
  }
});
setTimeout(() => process.exit(2), 15000);
