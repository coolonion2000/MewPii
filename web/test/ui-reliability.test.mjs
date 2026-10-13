import assert from 'node:assert/strict';
import test from 'node:test';

test('tool-heavy transcript tail retains every available visible conversation row', () => {
  const messages = [{role: 'user'}, {role: 'assistant'}, ...Array.from({length: 225}, () => ({role: 'toolResult'}))];
  assert.equal(visibleTranscriptStart(messages, 107), 0);
  assert.equal(visibleTranscriptStart([...messages, {role: 'assistant'}], 107), 0);
  assert.equal(visibleTranscriptStart([], 0), 0);
});
import {
  canFormatJson,
  visibleTranscriptStart,
  hasRecentVisibleMessages,
  canRenderMessageMarkdown,
  canRenderRichMarkdown,
  checkedJsonResponse,
  clampResizeWidth,
  clampChatWidth,
  collectToolCallIds,
  hasConversationHistory,
  isContentBlock,
  MAX_FORMATTED_JSON_CHARS,
  MAX_FINAL_MESSAGE_MARKDOWN_CHARS,
  MAX_RICH_MARKDOWN_CHARS,
  MAX_STREAMING_MESSAGE_MARKDOWN_CHARS,
  oauthCloseSucceeded,
  oauthPollDelay,
  orphanRunningTools,
  preferredToolOutput,
  sidebarResizeStep,
  sameToolCardMemoInputs,
  validContentBlocks,
} from '../src/ui-reliability.ts';

test('recent window counts 50 user/assistant rows, not hidden tool results or custom records', () => {
  const messages = Array.from({length: 80}, (_, i) => [
    { role: i % 2 ? 'assistant' : 'user' },
    { role: 'toolResult' }, { role: 'custom' }, { role: 'toolResult' },
  ]).flat();
  const start = visibleTranscriptStart(messages, messages.length - 120);
  assert.equal(start, 30 * 4);
  assert.equal(hasRecentVisibleMessages(messages.slice(start)), true);
  assert.equal(hasRecentVisibleMessages(messages.slice(start + 1)), false);
  assert.equal(visibleTranscriptStart(messages, 12), 12, 'reading older history preserves its anchor');
  assert.equal(hasRecentVisibleMessages(Array(100).fill({role: 'toolResult'})), false);
});

test('recent visible checks stop after their bounded tail budget', () => {
  let roleReads = 0;
  const messages = Array.from({length: 2000}, () => ({ get role() { roleReads++; return 'assistant'; } }));
  assert.equal(visibleTranscriptStart(messages, 1880), 1880);
  assert.equal(roleReads, 50);
  assert.equal(hasRecentVisibleMessages(messages), true);
  assert.equal(roleReads, 100);
});

test('paged assistant/tool-only history remains a conversation after streaming ends', () => {
  const page = [...Array(6).fill({ role: 'assistant' }), ...Array(5).fill({ role: 'toolResult' })];
  assert.equal(hasConversationHistory(page, 5206, 5217), true);
  assert.equal(hasConversationHistory([{ role: 'assistant' }], 0, 1), true);
  assert.equal(hasConversationHistory([{ role: 'toolResult' }], 0, 1), true);
  assert.equal(hasConversationHistory([], 100, 100), true);
  assert.equal(hasConversationHistory([], 0, 5217), true);
});

test('only truly new sessions and custom-only startup injections show the hero', () => {
  assert.equal(hasConversationHistory([], 0, 0), false);
  assert.equal(hasConversationHistory([{ role: 'custom' }], 0, 1), false);
  assert.equal(hasConversationHistory([{ role: 'user' }], 0, 0), true);
});

test('chat width reserves independent handle space inside its actual pane', () => {
  assert.equal(clampChatWidth(1200, 800), 752);
  assert.equal(clampChatWidth(800, 600), 552);
  assert.equal(clampChatWidth(800, 400), 352);
  assert.equal(clampChatWidth(800, 0), 0);
  assert.equal(clampChatWidth(600, 1200), 600);
  assert.equal(clampChatWidth(100, 1200), 480);
});

test('resize helpers clamp widths and preserve sidebar hysteresis', () => {
  assert.equal(clampResizeWidth(90, 170, 480), 170);
  assert.equal(clampResizeWidth(900, 170, 480), 480);
  let expanded = sidebarResizeStep('may-collapse', 109);
  assert.deepEqual(expanded, { phase: 'collapsed', collapsed: true, width: 46 });
  expanded = sidebarResizeStep(expanded.phase, 240);
  assert.deepEqual(expanded, { phase: 'collapsed', collapsed: true, width: 46 });

  let collapsed = sidebarResizeStep('may-expand', 170);
  assert.deepEqual(collapsed, { phase: 'may-expand', collapsed: true, width: 46 });
  collapsed = sidebarResizeStep(collapsed.phase, 171);
  assert.deepEqual(collapsed, { phase: 'expanded', collapsed: false, width: 171 });
  collapsed = sidebarResizeStep(collapsed.phase, 50);
  assert.deepEqual(collapsed, { phase: 'expanded', collapsed: false, width: 170 });
});

test('live tool output is visible until a finalized result takes precedence', () => {
  assert.equal(preferredToolOutput(undefined, '', 'partial stdout', true), 'partial stdout');
  assert.equal(preferredToolOutput(undefined, 'final stdout', 'partial stdout', true), 'final stdout');
  assert.equal(preferredToolOutput('diff', 'final stdout', 'partial stdout', true), 'diff');
  assert.equal(preferredToolOutput(undefined, '', 'stale partial', false), '');
});

test('malformed sparse content blocks are discarded defensively', () => {
  const block = { type: 'text', text: 'ok' };
  assert.equal(isContentBlock(block), true);
  assert.equal(isContentBlock(undefined), false);
  assert.equal(isContentBlock([]), false);
  assert.deepEqual(validContentBlocks([undefined, null, block, 'bad']), [block]);
});

test('late active tools render only until their toolCall enters the timeline', () => {
  const tools = new Map([
    ['late', { toolCallId: 'late', running: true, toolName: 'bash' }],
    ['known', { toolCallId: 'known', running: true, toolName: 'read' }],
    ['done', { toolCallId: 'done', running: false, toolName: 'write' }],
  ]);
  const finalized = collectToolCallIds([
    { content: [{ type: 'toolCall', id: 'known' }] },
    { content: [null, 'malformed'] },
  ]);

  assert.deepEqual(
    orphanRunningTools(tools, finalized).map((tool) => tool.toolCallId),
    ['late'],
  );
  assert.deepEqual(
    orphanRunningTools(tools, finalized, [
      { type: 'toolCall', id: 'late' },
    ]),
    [],
  );
});

test('large rich previews fall back before blocking parsers run', () => {
  assert.equal(canRenderRichMarkdown(MAX_RICH_MARKDOWN_CHARS), true);
  assert.equal(canRenderRichMarkdown(MAX_RICH_MARKDOWN_CHARS + 1), false);
  assert.equal(canFormatJson(MAX_FORMATTED_JSON_CHARS), true);
  assert.equal(canFormatJson(MAX_FORMATTED_JSON_CHARS + 1), false);
});

test('growing and giant assistant messages avoid blocking Markdown parses', () => {
  assert.equal(
    canRenderMessageMarkdown(MAX_STREAMING_MESSAGE_MARKDOWN_CHARS, true),
    true,
  );
  assert.equal(
    canRenderMessageMarkdown(MAX_STREAMING_MESSAGE_MARKDOWN_CHARS + 1, true),
    false,
  );
  assert.equal(
    canRenderMessageMarkdown(MAX_FINAL_MESSAGE_MARKDOWN_CHARS, false),
    true,
  );
  assert.equal(
    canRenderMessageMarkdown(MAX_FINAL_MESSAGE_MARKDOWN_CHARS + 1, false),
    false,
  );
});

test('OAuth transport checks HTTP errors and uses bounded retry backoff', async () => {
  await assert.rejects(
    checkedJsonResponse(
      new Response(JSON.stringify({ error: 'expired flow' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      'oauth status',
    ),
    /expired flow/,
  );
  assert.deepEqual(
    await checkedJsonResponse(
      new Response(JSON.stringify({ done: false, events: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      'oauth status',
    ),
    { done: false, events: [] },
  );
  await assert.rejects(
    checkedJsonResponse(
      new Response('<html>upstream error</html>', { status: 200 }),
      'oauth status',
    ),
    /oauth status: invalid response/,
  );
  assert.equal(oauthPollDelay(0), 800);
  assert.equal(oauthPollDelay(1), 1_600);
  assert.equal(oauthPollDelay(50), 5_000);
});

test('manual OAuth close preserves a completed success result', () => {
  assert.equal(oauthCloseSucceeded(false, { done: false }), false);
  assert.equal(oauthCloseSucceeded(false, { done: true, error: 'denied' }), false);
  assert.equal(oauthCloseSucceeded(false, { done: true }), true);
  assert.equal(oauthCloseSucceeded(true, { done: false }), true);
});

test('localized tool cards invalidate their memo boundary on language changes', () => {
  const call = { type: 'toolCall', id: 'tool-1' };
  const activity = { toolCallId: 'tool-1', running: true };
  const previous = { call, activity, language: 'zh' };
  assert.equal(sameToolCardMemoInputs(previous, { ...previous }), true);
  assert.equal(
    sameToolCardMemoInputs(previous, { ...previous, language: 'en' }),
    false,
  );
});
