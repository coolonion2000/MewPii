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
playwright-cli run-code --filename web/test/browser/performance.js
playwright-cli close
```

Interactions cover image zoom/pan/pinch, fit/original, close/Escape/backdrop, invalid-image retry, draft attachment preview, mutually exclusive stats, simulated visual-viewport keyboard resize, model-menu visibility, orientation, session tail positioning and incremental history rendering. Chromium is required for the CDP touch simulation. Keyboard simulation is not real iOS/Android input-method acceptance.

The performance probe compares 120 and 2,000 synthetic messages, with images every 20 messages, in a 390×844 viewport. It reports initial load, four session switches, 40 streaming updates, 40 scroll steps, DOM nodes and browser long tasks. This is a development-build diagnostic, not a device-independent benchmark; frame measurements include two animation frames. Heap figures depend on GC and must not be treated as memory savings.

Observed locally on 2026-09-24, 2,000-message sample:

| Metric | Before history window | After history window |
| --- | ---: | ---: |
| Initial display | 508 ms | 114 ms |
| Switch back to long session | 330–341 ms | 38–43 ms |
| DOM nodes | 24,067 | 1,509 |
| Largest switch long task | 324 ms | none observed |

The window initially renders 120 recent messages. Earlier loaded messages are retained and revealed in batches; streaming keeps the first-visible message anchored. Server history retrieval is unchanged once locally hidden history is exhausted. Repeatedly expanding all history can still grow the DOM; this is not full virtualization.
