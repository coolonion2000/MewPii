import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:31041/ws?cwd=' + encodeURIComponent('/Users/cosmo010225/Pii'));
let streamingText = '';
ws.on('open', () => console.log('[open]'));
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === 'snapshot') {
    console.log('[snapshot]', JSON.stringify({
      sessionId: msg.snapshot.sessionId,
      sessionFile: msg.snapshot.sessionFile,
      model: msg.snapshot.model,
      isStreaming: msg.snapshot.isStreaming,
      messages: msg.snapshot.messages.length,
    }));
    if (!sent) {
      sent = true;
      ws.send(JSON.stringify({ id: '1', type: 'prompt', message: 'Reply with exactly: hello from pi' }));
    }
  } else if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.type === 'message_update') {
      const sub = ev.assistantMessageEvent;
      if (sub?.type === 'text_delta') {
        streamingText += sub.delta;
        process.stdout.write(sub.delta);
      }
    } else if (ev.type === 'agent_end') {
      console.log('\n[agent_end] messages:', ev.messages?.length);
      console.log('[streamed text]:', JSON.stringify(streamingText));
      process.exit(0);
    } else if (['message_start', 'message_end', 'turn_start', 'turn_end', 'agent_start'].includes(ev.type)) {
      console.log('[event]', ev.type);
    }
  } else {
    console.log('[msg]', JSON.stringify(msg).slice(0, 200));
  }
});
let sent = false;
ws.on('close', (code, reason) => { console.log('[close]', code, String(reason)); process.exit(1); });
ws.on('error', (err) => { console.error('[error]', err.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
