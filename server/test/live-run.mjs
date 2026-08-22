import WebSocket from 'ws';

const cwd = '/Users/cosmo010225/Pii';
const sessionPath = process.argv[2];
const url = 'ws://127.0.0.1:31041/ws?cwd=' + encodeURIComponent(cwd) + (sessionPath ? '&session=' + encodeURIComponent(sessionPath) : '');
const ws = new WebSocket(url);
let sent = false;
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === 'snapshot' && !sent && msg.snapshot.model) {
    sent = true;
    console.log('sessionFile:', msg.snapshot.sessionFile);
    ws.send(JSON.stringify({ id: '1', type: 'prompt', message: '用 bash 运行: for i in 1 2 3; do echo line$i; sleep 1; done，然后用 edit 工具把 server/package.json 的 description 末尾加上一个句号。' }));
  }
});
setTimeout(() => process.exit(0), 20000);
