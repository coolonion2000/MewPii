/** Provider status is observational, not inferred from missing tool results. @author coolonion */
import type { ProviderRequestState } from './types';

export function providerRequestLabel(state: ProviderRequestState, language: string, now: number): string {
  const zh = language.startsWith('zh');
  const elapsed = Math.max(0, Math.floor((now - state.since) / 1000));
  if (state.phase === 'retrying') {
    const remaining = Math.max(0, Math.ceil(((state.retryAt ?? now) - now) / 1000));
    return zh
      ? `连接异常 · 重试 ${state.attempt ?? 1}/${state.maxAttempts ?? 1} · ${remaining > 0 ? `${remaining} 秒后重试` : '正在重新连接'}`
      : `Connection interrupted · Retry ${state.attempt ?? 1}/${state.maxAttempts ?? 1} · ${remaining > 0 ? `in ${remaining}s` : 'Reconnecting'}`;
  }
  const labels = zh ? {
    preparing: '准备模型请求', connecting: '正在连接模型', waiting_headers: '等待服务响应（SSE）',
    streaming: '已收到响应，等待后续输出', failed: '本次连接失败',
  } : {
    preparing: 'Preparing request', connecting: 'Connecting to model', waiting_headers: 'Waiting for response headers (SSE)',
    streaming: 'Response received; waiting for output', failed: 'Request failed',
  };
  return `${labels[state.phase]} · ${elapsed}${zh ? ' 秒' : 's'}`;
}
