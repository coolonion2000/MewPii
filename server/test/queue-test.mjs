import WebSocket from 'ws';

const cwd = '/Users/cosmo010225/Pii';
const sessionPath = process.argv[2];
const url = 'ws://127.0.0.1:31041/ws?cwd=' + encodeURIComponent(cwd) + (sessionPath ? '&session=' + encodeURIComponent(sessionPath) : '');
const ws = new WebSocket(url);
let phase = 0;
let lastQueue = null;
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === 'snapshot' && phase === 0 && msg.snapshot.model) {
    phase = 1;
    console.log('session:', msg.snapshot.sessionFile);
    ws.send(JSON.stringify({ id: '1', type: 'prompt', message: '用 bash 运行: sleep 6 && echo done。' }));
  } else if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.type === 'turn_start' && phase === 1) {
      phase = 2;
      // queue a follow-up and a steer while running
      setTimeout(() => ws.send(JSON.stringify({ id: '2', type: 'followUp', message: '排队消息：完成后告诉我现在几点' })), 300);
      setTimeout(() => ws.send(JSON.stringify({ id: '3', type: 'steer', message: '介入消息：echo 时顺便输出当前目录' })), 800);
    }
    if (ev.type === 'queue_update') {
      lastQueue = { steering: ev.steering, followUp: ev.followUp };
      console.log('[queue_update]', JSON.stringify(lastQueue));
    }
    if (ev.type === 'agent_settled') {
      console.log('[settled] final queue:', JSON.stringify(lastQueue));
      process.exit(0);
    }
  }
});
setTimeout(() => { console.log('TIMEOUT lastQueue=', JSON.stringify(lastQueue)); process.exit(2); }, 90000);
