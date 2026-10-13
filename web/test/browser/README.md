# Browser interaction and performance regressions

Uses the real ChatView, Composer, StatsBar and ImagePreview in an isolated fixture. Its conversations never connect; fetches are stubbed and sending is disabled. No provider calls or user-session mutations are needed. Fixture files are outside the production Vite entry and are not included in the production bundle.

Start from the repository root:

```sh
npm run dev -w web -- --port 31049 --strictPort
```

In a second terminal, use `playwright-cli` (or the Codex Playwright skill wrapper):

```sh
playwright-cli open http://127.0.0.1:31049/test/browser/fixture.html
playwright-cli run-code --filename web/test/browser/interactions.js
playwright-cli run-code --filename web/test/browser/chat-width.js
playwright-cli run-code --filename web/test/browser/attachment-layout.js
playwright-cli run-code --filename web/test/browser/mentions.js
playwright-cli run-code --filename web/test/browser/performance.js
playwright-cli run-code --filename web/test/browser/transcript-performance.js
playwright-cli run-code --filename web/test/browser/reliability.js
playwright-cli run-code --filename web/test/browser/receipt-layout.js
playwright-cli run-code --filename web/test/browser/tool-images.js
playwright-cli run-code --filename web/test/browser/recent-history.js
playwright-cli close
```

Interactions cover image zoom/pan/pinch, fit/original, close/Escape/backdrop, invalid-image retry, draft attachment preview, mutually exclusive stats, simulated visual-viewport keyboard resize, model-menu visibility, orientation, session tail positioning and incremental history rendering. Chromium is required for the CDP touch simulation. Keyboard simulation is not real iOS/Android input-method acceptance.

`mentions.js` uses `?mentions=1`, which replaces sending with an in-memory recorder (no provider calls). It checks file/folder selection, preview, draft isolation, failed-send restoration, path-only payloads, remote-agent routing, response ordering, ordinary @ text, and mobile keyboard positioning.

`receipt-layout.js` checks the lightweight server acknowledgement beside send, tooltip hover/tap/keyboard and dismissal, 320/390px compact/expanded input, stop-button visibility, light/dark themes, English labels and priority of unresolved messages. Receipt transport/draft recovery remains covered by `reliability.js`.

`tool-images.js` uses synthetic PNG tool results in `?tool-images=1`: ordered text/images, image-only and empty results, malformed/undecodable images, diff with images, live-to-final updates, restored history, keyboard preview/zoom/close, folding, mobile width and light/dark themes. It never calls a screenshot tool or opens a real conversation.

`recent-history.js` feeds a one-message snapshot and sequential stubbed history pages into the real Conversation. It checks automatic retention of at least 50 visible messages, a screenshot across the page boundary, thin reconnect/compaction snapshots, scroll-position stability, manual older history and branch isolation. Compaction is simulated locally; no model/provider call or real session mutation is performed.

The performance probe compares 120 and 2,000 synthetic messages, with images every 20 messages, in a 390×844 viewport. It reports initial load, four session switches, 40 streaming updates, 40 scroll steps, DOM nodes and browser long tasks. This is a development-build diagnostic, not a device-independent benchmark; frame measurements include two animation frames. Heap figures depend on GC and must not be treated as memory savings.

Observed locally on 2026-09-24, 2,000-message sample:

| Metric | Before history window | After history window |
| --- | ---: | ---: |
| Initial display | 508 ms | 114 ms |
| Switch back to long session | 330–341 ms | 38–43 ms |
| DOM nodes | 24,067 | 1,509 |
| Largest switch long task | 324 ms | none observed |

The window initially renders 120 recent messages. Earlier loaded messages are retained and revealed in batches; streaming keeps the first-visible message anchored. Server history retrieval is unchanged once locally hidden history is exhausted. Repeatedly expanding all history can still grow the DOM; this is not full virtualization.

`transcript-performance.js` additionally instruments finalized-message reads in the real ChatView. With 2,000 messages, 40 streaming text updates produce **zero** finalized role reads after initial indexing. It asserts history reveal, streaming with an expanded window, jump-to-bottom, session switching, and that an initializing session does not claim to be running. Its fixture is isolated from user sessions and providers.

`test/transcript-performance.test.mjs` uses deterministic operation counts: 120 finalized messages × 40 blocks × 40 tool updates parse 4,800 blocks once rather than re-parsing 192,000 blocks. Orphan-tool checks use `has` lookups without iterating/copying a 20,000-ID history set. These are work-count regressions, not wall-clock speedup claims.
