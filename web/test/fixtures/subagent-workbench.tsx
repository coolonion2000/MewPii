/** Isolated browser fixture using production components and polling. @author coolonion */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SubagentContext, useSubagentStore } from '../../src/subagent-store';
import SubagentTaskCard from '../../src/components/SubagentTaskCard';
import SubagentPanel from '../../src/components/SubagentPanel';
import SubagentRunDialog from '../../src/components/SubagentRunDialog';
import '../../src/theme.css';
import '../../src/app.css';

const fixture = await (await fetch('/fixture.json')).json();
const controls = { fail: false, requests: 0, delayNext: false, release: undefined as undefined | (() => void), state: undefined as string | undefined };
(window as any).workbench = controls;
window.fetch = async (input) => {
  controls.requests++;
  const url = new URL(String(input), location.href);
  const current = structuredClone(fixture);
  if (controls.delayNext) {
    controls.delayNext = false;
    await new Promise<void>(resolve => { controls.release = resolve; });
  }
  if (controls.fail) return new Response('{}', { status: 503 });
  if (controls.state) current.presentation.effectiveState = controls.state;
  if (url.pathname === '/api/subagent-run') return Response.json(current);
  return Response.json({ runs: url.searchParams.get('parent') === 'parent-B' ? [] : [{
    id: current.runId, path: `pi-subagents-run://${current.runId}`, name: current.agent, cwd: current.cwd, presentation: current.presentation,
  }] });
};
function Workbench() {
  const [parent, setParent] = useState('parent-A');
  const [file, setFile] = useState(false);
  const store = useSubagentStore(parent);
  return <div className="app"><div className="main">
    <div className="chat-header"><span>子任务 · 隔离验证</span><button onClick={() => setParent(parent === 'parent-A' ? 'parent-B' : 'parent-A')}>切换会话</button><button onClick={() => { store.close(); setFile(true); }}>文件预览</button><button onClick={() => document.body.toggleAttribute('data-ds-dark-theme')}>主题</button></div>
    <SubagentContext.Provider value={{ ...store, open: id => { setFile(false); store.open(id); } }}>
      <div className={`chat-body ${store.selected ? 'has-subagent-detail' : ''}`}>
        <div className="chat-main"><div style={{ flex: 1, overflow: 'auto', padding: '40px 30px', maxWidth: 860, width: '100%', margin: 'auto', boxSizing: 'border-box' }}>
          <h3>正在检查子任务进度</h3><p className="dim">聊天保留上下文，子任务状态与详情使用同一份数据。</p>
          <SubagentTaskCard call={{ type: 'toolCall', name: 'subagent', id: fixture.presentation.toolCallId, arguments: { agent: 'worker', task: fixture.task || fixture.presentation.title } }} output="调用已返回" />
        </div><div className="composer-wrap"><SubagentPanel /><div className="composer"><textarea aria-label="草稿" placeholder="输入消息…" style={{ minHeight: 110 }} /></div></div></div>
        {store.selected && <SubagentRunDialog key={store.selected} width={440} />}
        {file && !store.selected && <aside className="file-preview-pane">文件预览<button onClick={() => setFile(false)}>关闭文件</button></aside>}
      </div>
    </SubagentContext.Provider>
  </div></div>;
}
createRoot(document.getElementById('root')!).render(<Workbench />);
