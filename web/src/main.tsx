// Report uncaught client errors to the server so we can debug render crashes.
import { createRoot } from 'react-dom/client';

let _lastErr = 0;
function reportClientError(msg: string, stack?: string): void {
  const now = Date.now();
  if (now - _lastErr < 1000) return; // throttle
  _lastErr = now;
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(msg).slice(0, 2000), stack: String(stack ?? '').slice(0, 4000), url: location.pathname, ts: now }),
    }).catch(() => undefined);
  } catch { /* ignore */ }
}
window.addEventListener('error', (e) => reportClientError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportClientError(String(e.reason), (e.reason as { stack?: string })?.stack));
import App from './App';
import './theme.css';
import './app.css';

createRoot(document.getElementById('root')!).render(<App />);
