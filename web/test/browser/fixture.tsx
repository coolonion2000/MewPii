// Isolated real-component harness. Never connects a Conversation or sends to a provider.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatView from '../../src/components/ChatView';
import ImagePreview from '../../src/components/ImagePreview';
import { Conversation, DeliveryUnknownError, type MessageDelivery } from '../../src/api';
import { trackMobileViewport } from '../../src/mobile-viewport';
import '../../src/theme.css';
import '../../src/app.css';

const requests: string[] = [], sent: unknown[] = [];
window.fetch = async (input) => {
  const url = new URL(String(input), location.origin); requests.push(url.href);
  let body: unknown = { providers: [], models: [], runs: [], active: [] };
  if (url.searchParams.get('mode') === 'mention') {
    const q = url.searchParams.get('q');
    if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
    body = { mentionSearch: true, cwd: '/fixture', items: q === 'none' ? [] : q === 'src' ? [{ name: 'src', path: 'src', isDir: true }] : [{ name: q === 'slow' ? 'Stale.tsx' : 'Composer.tsx', path: q === 'slow' ? 'src/Stale.tsx' : 'src/Composer.tsx', isDir: false }], truncated: false };
  }
  if (url.pathname === '/api/file') body = { path: 'src/Composer.tsx', name: 'Composer.tsx', content: 'fixture file preview' };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
const image = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#5b8def"/><text x="200" y="400" font-size="100">Preview regression fixture</text></svg>');
const toolImageCanvas = document.createElement('canvas');
toolImageCanvas.width = 1600; toolImageCanvas.height = 800;
const toolImageContext = toolImageCanvas.getContext('2d')!;
toolImageContext.fillStyle = '#5b8def'; toolImageContext.fillRect(0, 0, 1600, 800);
toolImageContext.fillStyle = '#fff'; toolImageContext.font = '64px sans-serif'; toolImageContext.fillText('Tool screenshot fixture', 80, 200);
const toolImage = { type: 'image', mimeType: 'image/png', data: toolImageCanvas.toDataURL('image/png').split(',')[1] };
const now = Date.now();
function conversation(id: string, count: number) {
  const conv = new Conversation('/fixture', `/fixture/${id}.jsonl`, 'fixture');
  conv.messages = Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', _entryId: `${id}-${i}`, timestamp: now + i,
    content: i % 20 === 0 ? [{ type: 'image', mimeType: 'image/svg+xml', data: image }] : [{ type: 'text', text: `Message ${i}\n\n${'Fixture content with **Markdown** and a short paragraph. '.repeat(8)}` }] }));
  if (new URLSearchParams(location.search).has('tool-images')) {
    const results = [
      [{ type: 'text', text: 'Before screenshot' }, toolImage, { type: 'text', text: 'After screenshot' }, toolImage],
      [toolImage], [],
      [{ type: 'image', data: '' }],
      [{ type: 'image', data: 'invalid-base64', mimeType: 'image/png' }],
      [{ type: 'text', text: 'Replaced edit text' }, toolImage],
    ];
    const ids = ['mixed', 'image-only', 'empty', 'malformed', 'broken', 'diff', 'live'];
    conv.messages = [
      { role: 'user', _entryId: 'tool-request', content: 'Show the screenshots' },
      { role: 'assistant', _entryId: 'tool-calls', content: ids.map(id => ({ type: 'toolCall', id, name: 'mcp', arguments: { tool: 'chrome-devtools_take_screenshot', args: { pageId: 18, format: 'png' } } })) },
      ...results.map((content, i) => ({ role: 'toolResult', _entryId: `result-${ids[i]}`, toolCallId: ids[i], content, ...(i === 5 ? { details: { diff: '-before\n+after' } } : {}) })),
    ];
    count = conv.messages.length;
    conv.tools.set('live', { toolCallId: 'live', toolName: 'mcp', running: true, liveOutput: 'Capturing screenshot...' });
  }
  conv.snapshot = { sessionId: id, sessionFile: conv.sessionPath, cwd: conv.cwd, name: id, isStreaming: false, thinkingLevel: 'medium', messages: conv.messages,
    totalMessages: count, historyFrom: 0, tools: [], slashCommands: [], queue: { steering: [], followUp: [] }, queueCapabilities: { revision: 0, reorder: false, remove: false },
    stats: { userMessages: count / 2, assistantMessages: count / 2, toolCalls: 100, tokens: { input: 10000, output: 2000, cacheRead: 4000, cacheWrite: 0, total: 16000 }, cost: .1, contextTokens: 2000, contextWindow: 10000, contextPercent: 20 } };
  conv.connected = true;
  conv.syncEditorText = () => {};
  conv.send = async () => { throw Error('Sending is disabled in the UI fixture'); };
  if (new URLSearchParams(location.search).has('reliability')) {
    const deliveries = new Map<string, MessageDelivery>();
    conv.getDelivery = id => deliveries.get(id);
    Object.defineProperty(conv, 'unsettledDeliveries', {get: () => [...deliveries.values()].filter(item => item.state === 'unknown' || item.state === 'sending')});
    conv.send = async command => {
      sent.push(command);
      conv.delivery = { id: `fixture-delivery-${sent.length}`, type: 'prompt', state: 'unknown', updatedAt: Date.now() };
      deliveries.set(conv.delivery.id, conv.delivery);
      (conv as any).emit();
      throw new DeliveryUnknownError(conv.delivery.id);
    };
    conv.checkDelivery = async (id = conv.delivery?.id) => {
      const failed = (window as any).fixture.rejectDelivery;
      const status: MessageDelivery = {id: id!, type: 'prompt', state: failed ? 'failed' : 'accepted', updatedAt: Date.now()};
      deliveries.set(id!, status);
      if (conv.delivery?.id === id) conv.delivery = status;
      (conv as any).emit();
      if (failed) throw Error('fixture rejection');
      return {accepted: true};
    };
  }
  if (new URLSearchParams(location.search).has('mentions')) {
    conv.waitUntilReady = async () => {};
    conv.send = async command => {
      sent.push(command);
      if ((window as any).fixture.failNext) { (window as any).fixture.failNext = false; throw Error('fixture send failure'); }
      if (command.type === 'prompt') {
        conv.messages = [...conv.messages, { role: 'user', content: command.message, _entryId: `sent-${sent.length}` }];
        (conv as any).emit();
      }
      return {};
    };
  }
  return conv;
}
const large = conversation('large', Number(new URLSearchParams(location.search).get('count') ?? 120));
const small = conversation('small', 8);
function Fixture() {
  const [conv, setConv] = useState(large);
  const [preview, setPreview] = useState<string>();
  useEffect(() => trackMobileViewport(), []);
  useEffect(() => {
    let finalizedRoleReads = 0;
    let historyRows: typeof conv.messages = [];
    let historyBranch = 'history-main';
    const historySnapshot = () => ({
      ...conv.snapshot!, initializing: false, pagingProvisional: false, branchHeadId: historyBranch,
      messages: historyRows.slice(-1), totalMessages: historyRows.length,
      historyFrom: Math.max(0, historyRows.length - 1), historyBeforeEntryId: historyRows.at(-2)?._entryId,
    });
    (window as any).fixture = {
      requests, sent,
      receipt: (state?: MessageDelivery['state']) => {
        conv.delivery = state ? { id: `receipt-${state}`, type: 'prompt', state, updatedAt: Date.now() } : undefined;
        conv.snapshot = { ...conv.snapshot!, model: { provider: 'fixture', id: 'fixture-model', name: 'GPT-6 Astra medium long model' } };
        (conv as any).emit();
      },
      recentHistoryStart: () => {
        historyRows = Array.from({ length: 227 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', _entryId: `history-${i}`,
          content: [{ type: 'text', text: `History conversation ${i}` }] }));
        historyRows[224] = { role: 'assistant', _entryId: 'history-224', content: [{ type: 'toolCall', id: 'history-image-call', name: 'mcp', arguments: { tool: 'chrome-devtools_take_screenshot' } }] };
        historyRows[225] = { role: 'toolResult', _entryId: 'history-225', toolCallId: 'history-image-call', content: [toolImage] };
        historyRows[226] = { role: 'assistant', _entryId: 'history-226', content: [{ type: 'text', text: 'Latest screenshot response' }] };
        conv.send = async command => {
          if (command.type !== 'history') throw Error('Only history reads are enabled in this fixture');
          sent.push(command);
          const before = Math.max(0, command.before - 10);
          const response = { type: 'history', requestId: command.requestId, before, messages: historyRows.slice(before, command.before), sessionId: conv.snapshot!.sessionId, branchHeadId: historyBranch };
          await new Promise(resolve => setTimeout(resolve, 25));
          (conv as any).handleMessage(response);
          return {};
        };
        (conv as any).handleMessage({ type: 'snapshot', snapshot: historySnapshot() });
      },
      recentHistoryRefresh: () => (conv as any).handleMessage({ type: 'snapshot', snapshot: historySnapshot() }),
      recentHistoryCompact: () => {
        (conv as any).handleMessage({ type: 'event', event: { type: 'compaction_start', reason: 'threshold' } });
        historyRows.push({ role: 'assistant', _entryId: 'history-new-tail', content: [{ type: 'text', text: 'New response after compaction' }] });
        historyBranch = 'history-compacted';
        (conv as any).handleMessage({ type: 'event', event: { type: 'compaction_end', compactionState: { status: 'completed', reason: 'threshold' } } });
        (conv as any).handleMessage({ type: 'snapshot', snapshot: historySnapshot() });
      },
      recentHistoryBranch: () => {
        historyBranch = 'different-branch';
        historyRows = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', _entryId: `other-${i}`, content: `Other branch ${i}` }));
        (conv as any).handleMessage({ type: 'snapshot', snapshot: { ...historySnapshot(), messages: historyRows, historyFrom: 0, historyBeforeEntryId: undefined } });
      },
      recentHistoryState: () => ({ loaded: conv.messages.length, visible: conv.messages.filter(m => m.role === 'user' || m.role === 'assistant').length, before: conv.historyFrom, requests: sent.length, inFlight: conv.historyInFlight }),
      finishImageTool: () => {
        conv.messages = [...conv.messages, { role: 'toolResult', _entryId: 'result-live', toolCallId: 'live', content: [toolImage] }];
        // Keep the stale running activity to check that the final result wins.
        (conv as any).emit();
      },
      phase: (phase: string) => {
        conv.connected = ['ready', 'running', 'initializing', 'compacting'].includes(phase);
        conv.compaction = phase === 'compacting' ? {reason: 'manual'} : undefined;
        conv.transportOpen = phase !== 'connecting' && phase !== 'failed';
        conv.reconnecting = phase === 'reconnecting';
        conv.serviceUnresponsive = phase === 'unresponsive';
        conv.error = phase === 'failed' ? 'fixture connection failure' : undefined;
        conv.snapshot = {...conv.snapshot!, initializing: phase === 'initializing', isStreaming: phase === 'running'};
        (conv as any).emit();
      },
      observeFinalizedReads: () => {
        conv.messages = conv.messages.map(message => ({
          ...message,
          get role() { finalizedRoleReads++; return message.role; },
        }));
        (conv as any).emit();
      },
      finalizedRoleReads: () => finalizedRoleReads,
      setInitializing: (initializing: boolean) => {
        conv.snapshot = { ...conv.snapshot!, initializing };
        (conv as any).emit();
      },
      connection: (connected: boolean, unresponsive: boolean) => {
        conv.connected = connected; conv.serviceUnresponsive = unresponsive;
        (conv as any).emit();
      },
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
