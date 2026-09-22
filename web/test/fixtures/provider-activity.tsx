/** Isolated provider status QA, no connection to the running service. @author coolonion */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProviderActivity from '../../src/components/ProviderActivity';
import type { ProviderRequestState } from '../../src/types';
import '../../src/app.css';

function Fixture() {
  const [state, setState] = useState<ProviderRequestState | undefined>();
  const show = (phase: ProviderRequestState['phase']) => setState({ phase, transport: 'sse',
    startedAt: Date.now(), since: Date.now(), attempt: 1, maxAttempts: 1, retryAt: Date.now() + 3000 });
  return <main style={{ maxWidth: 800, margin: '100px auto', padding: 24 }}>
    <h2>连接状态验证（隔离环境）</h2>
    <div style={{ display: 'flex', gap: 12, marginBottom: 30 }}>
      <button onClick={() => show('connecting')}>连接</button>
      <button onClick={() => show('waiting_headers')}>等待响应</button>
      <button onClick={() => show('retrying')}>重试</button>
      <button onClick={() => show('streaming')}>开始响应</button>
      <button onClick={() => setState(undefined)}>结束</button>
    </div>
    {state && <ProviderActivity state={state} language="zh" />}
    <textarea aria-label="输入框" placeholder="验证等待期间仍可输入" style={{ width: '100%', marginTop: 24 }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
