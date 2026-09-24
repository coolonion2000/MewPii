// Isolated real-component harness. Never connects a Conversation or sends to a provider.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatView from '../../src/components/ChatView';
import ImagePreview from '../../src/components/ImagePreview';
import { Conversation } from '../../src/api';
import { trackMobileViewport } from '../../src/mobile-viewport';
import '../../src/theme.css';
import '../../src/app.css';

window.fetch = async () => new Response(JSON.stringify({ providers: [], models: [], runs: [], active: [] }), { headers: { 'Content-Type': 'application/json' } });
const image = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#5b8def"/><text x="200" y="400" font-size="100">Preview regression fixture</text></svg>');
const now = Date.now();
function conversation(id: string, count: number) {
  const conv = new Conversation('/fixture', `/fixture/${id}.jsonl`, 'fixture');
  conv.messages = Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', _entryId: `${id}-${i}`, timestamp: now + i,
    content: i % 20 === 0 ? [{ type: 'image', mimeType: 'image/svg+xml', data: image }] : [{ type: 'text', text: `Message ${i}\n\n${'Fixture content with **Markdown** and a short paragraph. '.repeat(8)}` }] }));
  conv.snapshot = { sessionId: id, sessionFile: conv.sessionPath, cwd: conv.cwd, name: id, isStreaming: false, thinkingLevel: 'medium', messages: conv.messages,
    totalMessages: count, historyFrom: 0, tools: [], slashCommands: [], queue: { steering: [], followUp: [] }, queueCapabilities: { revision: 0, reorder: false, remove: false },
    stats: { userMessages: count / 2, assistantMessages: count / 2, toolCalls: 100, tokens: { input: 10000, output: 2000, cacheRead: 4000, cacheWrite: 0, total: 16000 }, cost: .1, contextTokens: 2000, contextWindow: 10000, contextPercent: 20 } };
  conv.connected = true;
  conv.syncEditorText = () => {};
  conv.send = async () => { throw Error('Sending is disabled in the UI fixture'); };
  return conv;
}
const large = conversation('large', Number(new URLSearchParams(location.search).get('count') ?? 120));
const small = conversation('small', 8);
function Fixture() {
  const [conv, setConv] = useState(large);
  const [preview, setPreview] = useState<string>();
  useEffect(() => trackMobileViewport(), []);
  useEffect(() => {
    (window as any).fixture = {
      switchSession: () => setConv(c => c === large ? small : large),
      preview: (invalid = false) => setPreview(invalid ? 'data:image/png;base64,invalid' : `data:image/svg+xml;base64,${image}`),
      stream: (n: number) => {
        conv.snapshot = { ...conv.snapshot!, isStreaming: true };
        conv.streaming = { role: 'assistant', content: [{ type: 'text', text: 'streaming delta '.repeat(n) }] };
        (conv as any).emit();
      },
    };
  }, [conv]);
  return <div className="app"><div className="main-workspace"><ChatView key={conv.sessionPath} conv={conv} onRefresh={() => {}} language="zh" dark={false} /></div>
    {preview && <ImagePreview src={preview} onClose={() => setPreview(undefined)} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
