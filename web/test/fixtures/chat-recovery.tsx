/** Exercise the real ChatView with isolated conversations. @author coolonion */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../src/api';
import ChatView from '../../src/components/ChatView';
import '../../src/theme.css';
import '../../src/app.css';

function makeConversation(id: string, compacting = false) {
  const c = new Conversation('/isolated-ui-' + id);
  c.connected = true;
  const messages = [{ role: 'user', content: '会话 ' + id, timestamp: 1 },
    { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: Array.from({ length: 45 }, (_, i) => `${id} 历史段落 ${i}`).join('\n\n') + '\n\n最新消息 ' + id }] }];
  Object.assign(c, { messages, totalMessages: 2, snapshot: {
    sessionId: id, cwd: c.cwd, name: id, isStreaming: false, thinkingLevel: 'medium', messages, totalMessages: 2,
    historyFrom: 0, queue: { steering: [], followUp: [] }, queueCapabilities: { revision: 0, reorder: true, remove: true },
    tools: [], slashCommands: [], compactionState: compacting ? { status: 'running', reason: 'overflow', startedAt: Date.now() } : null,
  }, compaction: compacting ? { reason: 'overflow' } : undefined });
  return c;
}
const a = makeConversation('A'), b = makeConversation('B', true);
function Fixture() {
  const [conv, setConv] = useState(a);
  const [, update] = useState(0);
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <div style={{ display: 'flex', gap: 16, padding: 10 }}>
      <button onClick={() => setConv(a)}>会话 A</button><button onClick={() => setConv(b)}>会话 B（压缩中）</button>
      <button onClick={() => { const target = document.querySelector('.chat-column'); const el = document.createElement('div'); el.textContent = '异步内容加载完成'; el.style.height = '600px'; target?.append(el); }}>内容高度变化</button>
      <button onClick={() => {
        conv.compaction = undefined;
        if (conv.snapshot) conv.snapshot.compactionState = { status: 'completed', reason: 'overflow', tokensBefore: 922317, estimatedTokensAfter: 84691, endedAt: Date.now() };
        update(n => n + 1);
      }}>压缩完成</button>
    </div>
    <div className="main" style={{ minHeight: 0 }}><ChatView key={conv.snapshot?.sessionId} conv={conv} onRefresh={() => {}} dark={false} language="zh" /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
