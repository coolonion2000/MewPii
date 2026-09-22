/** @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { providerRequestLabel } from '../src/provider-request-state.ts';

test('header wait and retry have truthful, changing clocks', () => {
  const state = { phase: 'waiting_headers', transport: 'sse', startedAt: 1000, since: 2000 };
  assert.equal(providerRequestLabel(state, 'zh', 9000), '等待服务响应（SSE） · 7 秒');
  const retry = { ...state, phase: 'retrying', attempt: 1, maxAttempts: 1, retryAt: 10000 };
  assert.match(providerRequestLabel(retry, 'zh', 8000), /2 秒后重试/);
  assert.match(providerRequestLabel(retry, 'zh', 11000), /正在重新连接/);
  assert.match(providerRequestLabel(state, 'en', 9000), /response headers.*7s/);
});
