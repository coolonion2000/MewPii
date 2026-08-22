import WebSocket from 'ws';

const cwd = '/Users/cosmo010225/Pii';
const ws = new WebSocket('ws://127.0.0.1:31041/ws?cwd=' + encodeURIComponent(cwd));
const toolEvents = [];
let sent = false;
let lastSnapshot;

ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === 'snapshot') {
    lastSnapshot = msg.snapshot;
    if (!sent && msg.snapshot.model) {
      sent = true;
      ws.send(JSON.stringify({ id: '1', type: 'prompt', message: 'Run `echo pii-test` with the bash tool, then stop.' }));
    }
  } else if (msg.type === 'event') {
    const ev = msg.event;
    if (String(ev.type).startsWith('tool_execution')) {
      toolEvents.push({ type: ev.type, tool: ev.toolName, isError: ev.isError });
    }
    if (ev.type === 'agent_end') {
      setTimeout(() => {
        const s = lastSnapshot;
        console.log('toolEvents:', JSON.stringify(toolEvents));
        console.log('stats:', JSON.stringify(s?.stats));
        console.log('messages with entryId:', s?.messages.filter((m) => m._entryId).length, '/', s?.messages.length);
        const roles = s?.messages.map((m) => m.role).join(',');
        console.log('roles:', roles);
        process.exit(0);
      }, 600);
    }
  }
});
ws.on('close', (c, r) => { console.log('[close]', c, String(r)); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT', JSON.stringify(toolEvents)); process.exit(2); }, 120000);
