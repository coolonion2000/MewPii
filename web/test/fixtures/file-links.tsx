/** Real message and preview components in an isolated browser harness. @author coolonion */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MessageItem from '../../src/components/MessageItem';
import FilePreview from '../../src/components/FilePreview';
import '../../src/theme.css';
import '../../src/app.css';

const cwd = '/tmp/map-recall-mail-templates-20260910';
const text = '[查重 SQL](./preflight-map-recall-templates.sql)\n\n[创建14个模板的 SQL](/tmp/map-recall-mail-templates-20260910/create-map-recall-templates.sql)\n\n[写入后校验 SQL](verify-map-recall-templates.sql)\n\n[文案对照清单](copy-review.md) · [FDC 模板映射](mapRecallEmailTemplates.json)\n\n[不存在的文件](mapRecallMailTemplates.json) · [无权限文件](/tmp/private.sql) · [外部网页](https://example.com)';
const noop = () => {};
function Fixture() {
  const [path, setPath] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState('尚未发送的草稿');
  return <div style={{ display: 'flex', height: '100vh' }}>
    <main style={{ flex: 1, minWidth: 0, padding: 24, overflow: 'auto' }}>
      <button onClick={() => setStreaming(v => !v)}>切换流式输出</button>
      <MessageItem message={{ role: 'assistant', content: [{ type: 'text', text }] }} streaming={streaming}
        toolResults={new Map()} tools={new Map()} cwd={cwd} language="zh" onFork={noop} onBranch={noop} onOpenFile={setPath} />
      <textarea aria-label="草稿" value={draft} onChange={e => setDraft(e.target.value)} />
    </main>
    {path && <FilePreview cwd={cwd} path={path} sessionId="isolated-fixture" language="zh" width={650} onClose={() => setPath(undefined)} onNavigate={setPath} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
