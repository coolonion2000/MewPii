/** Persistent bottom terminal dock; hiding preserves its PTY connection. @author coolonion */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { withAgent } from '../api';
import { t } from '../i18n';
import { IconX, IconTerminal } from '../icons';

interface Props { cwd: string; agent?: string; visible: boolean; dark: boolean; onHide: () => void; onClose: () => void }
const theme = (dark: boolean) => dark
  ? { background: '#161616', foreground: '#e4e4e4', cursor: '#e4e4e4', selectionBackground: '#3b4766' }
  : { background: '#ffffff', foreground: '#242424', cursor: '#242424', selectionBackground: '#cbdcf5' };

export default function TerminalPanel({ cwd, agent, visible, dark, onHide, onClose }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  const [height, setHeight] = useState(() => {
    try { const stored = Number(localStorage.getItem('pii-terminal-height')); return Number.isFinite(stored) && stored >= 160 ? Math.min(700, stored) : 280; }
    catch { return 280; }
  });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'ended' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [exitCode, setExitCode] = useState<number>();
  const [shell, setShell] = useState('');
  const initialDark = useRef(dark);

  useEffect(() => {
    if (!container.current) return;
    setStatus('connecting'); setError(''); setExitCode(undefined);
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, Consolas, monospace', scrollback: 5000, theme: theme(initialDark.current), allowProposedApi: false });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(container.current);
    terminal.current = term; fit.current = addon;
    const refit = () => { if (container.current && container.current.clientWidth > 0 && container.current.clientHeight > 0) addon.fit(); };
    refit();
    const endpoint = new URL(withAgent(`/ws/terminal?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`, agent), location.href);
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(endpoint);
    let disposed = false; let ready = false; let ended = false;
    const send = (data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
    const input = term.onData(data => {
      if (!ready) return;
      // Keep pasted input below the server's frame bound, including JSON escaping.
      for (let offset = 0; offset < data.length; offset += 4096) send({ type: 'input', data: data.slice(offset, offset + 4096) });
    });
    const resized = term.onResize(({ cols, rows }) => { if (ready) send({ type: 'resize', cols, rows }); });
    ws.onmessage = event => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          ready = true; setStatus('ready'); setShell(message.shell); refit();
          send({ type: 'resize', cols: term.cols, rows: term.rows });
          if (container.current?.clientHeight) term.focus();
        } else if (message.type === 'output' && typeof message.data === 'string') {
          term.write(message.data, () => { if (!disposed) send({ type: 'ack', length: message.data.length }); });
        } else if (message.type === 'exit') {
          ready = false; ended = true; setExitCode(message.exitCode); setStatus('ended');
        } else if (message.type === 'error') { ended = true; ready = false; setError(message.error); setStatus('error'); }
      } catch { setStatus('error'); setError(t('terminalDisconnected')); ws.close(); }
    };
    ws.onerror = () => { if (!disposed) { setStatus('error'); setError(t('terminalDisconnected')); } };
    ws.onclose = () => { ready = false; if (!disposed && !ended) { setStatus('error'); setError(t('terminalDisconnected')); } };
    const observer = new ResizeObserver(refit); observer.observe(container.current);
    return () => {
      disposed = true; observer.disconnect(); input.dispose(); resized.dispose();
      send({ type: 'close' }); ws.close(); term.dispose(); terminal.current = undefined; fit.current = undefined;
    };
  }, [cwd, agent, attempt]);
  useEffect(() => { initialDark.current = dark; if (terminal.current) terminal.current.options.theme = theme(dark); }, [dark]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => { try { localStorage.setItem('pii-terminal-height', String(height)); } catch { /* optional preference */ } }, [height]);
  const boundedHeight = (value: number) => Math.max(160, Math.min(700, (panel.current?.parentElement?.clientHeight ?? 800) - 160, value));
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); resizeCleanup.current?.(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientY; const current = panel.current?.getBoundingClientRect().height ?? height;
    const move = (e: PointerEvent) => setHeight(boundedHeight(current + start - e.clientY));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); resizeCleanup.current = undefined; };
    resizeCleanup.current = end; window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
  };
  return <section ref={panel} className="terminal-panel" aria-label={t('terminal')} hidden={!visible} style={{ height }}>
    <div className="terminal-resize" role="separator" aria-label={t('terminalResize')} aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={160} aria-valuemax={700} tabIndex={0} onPointerDown={resize}
      onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setHeight(boundedHeight(height + (e.key === 'ArrowUp' ? 24 : -24))); } }} />
    <header className="terminal-header">
      <IconTerminal size={15} /><strong>{t('terminal')}</strong>
      <span className="terminal-project" title={`${t('terminalDirectory')}: ${cwd}`}>{cwd.split('/').pop() || cwd}</span>
      <span className="terminal-shell">{agent ? `${agent} · ` : ''}{shell}</span>
      <span className="terminal-status" role="status">{status === 'connecting' ? t('terminalConnecting') : status === 'ended' ? `${t('terminalExited')} (${exitCode ?? 0})` : status === 'error' ? t('terminalFailed') : ''}</span>
      {(status === 'ended' || status === 'error') && <button className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}>{t('terminalRestart')}</button>}
      <button className="btn btn-icon" title={t('terminalHide')} aria-label={t('terminalHide')} onClick={onHide}>─</button>
      <button className="btn btn-icon" title={t('terminalClose')} aria-label={t('terminalClose')} onClick={onClose}><IconX size={14} /></button>
    </header>
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div ref={container} className="terminal-screen" />
  </section>;
}
