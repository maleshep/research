# ego-lite on Windows: Final Verdict (2026-08-13)

## Conclusion

**We tested ego-lite extensively on Windows and concluded it does not replace our existing CDP-based approach.** ego-windows-host (PR #228) is a CDP wrapper — every operation (`page.evaluate`, `page.snapshot`, `page.goto`, `page.locator`) is a CDP call under the hood. chrome-research MCP already gives us direct CDP access with better stability.

## What we tested

1. **Use case verification** — flights, chess (canvas), social media scraping, CSOD/SAP SF form filling, LinkedIn Easy Apply
2. **Vision unlock** — chrome-research `take_screenshot` returns images inline in agent context; ego's `page.screenshot()` returns a file path
3. **Parallel task spaces** — ego creates isolated browser contexts, but also creates about:blank placeholder tabs and can launch Edge when misconfigured
4. **Cursor/status UI** — injected via DOM, works but static (doesn't update during actions)
5. **Snapshot iframe fix** — patched ego-bridge.ts to enumerate child frames (10,360 → 20,800 chars on w3schools)
6. **File upload** — CSOD's 50-char filename limit was the blocker, not the toolchain; `DOM.setFileInputFiles` via page-level websocket works on all tools
7. **Parallel apply** — Douglas (SAP SF) + SIXT filled simultaneously via ego task spaces + chrome-research vision

## Why ego-lite doesn't replace CDP for us

| ego-lite adds | But we already have it via |
|---|---|
| `page.evaluate()` | chrome-research `evaluate_script` — same CDP `Runtime.evaluate` |
| `page.snapshot()` | chrome-research `take_snapshot` — same CDP `Accessibility.getFullAXTree` |
| `page.goto()` | chrome-research `navigate_page` — same CDP `Page.navigate` |
| `page.locator().fill()` | chrome-research `fill(uid, value)` — more reliable for React forms |
| `page.screenshot()` | chrome-research `take_screenshot` — returns inline, not file path |
| Task spaces | Multiple chrome-research tabs on same Chrome |
| Cursor/status badge | Nice-to-have, doesn't affect functionality |

## What ego-lite got wrong on Windows

1. **Launches Edge by default** — `browser-locator.ts` prefers Edge over Chrome; must always set `EGO_HOST_BROWSER_PATH`
2. **Creates about:blank tabs** — every `openOrReuseTab` spawns a placeholder tab
3. **`page.locator().fill()` fails on React** — falls back to `evaluate` anyway
4. **`page.screenshot()` returns file path** — not inline in agent context; useless for vision
5. **`page.goto()` times out** on heavy SPA redirects (SAP SF)
6. **PR #228 stalled** — zero activity since Aug 6, no reviews, no comments

## What we keep from this work

1. **chrome-research as sole browser driver** — proven across Google Flights, CSOD, SAP SF, SIXT, LinkedIn, Yahoo Finance, Google Maps
2. **Blitz fill pattern** — one `evaluate_script` with `setVal` + `clickRadioByValue` fills an entire form in ~4 seconds
3. **File upload via page-level websocket** — `DOM.setFileInputFiles` with `backendNodeId`, short filenames (< 50 chars)
4. **Snapshot iframe fix** — `Page.getFrameTree` + `getFullAXTree({frameId})` per child frame (patched in ego-bridge.ts, also applicable via CDP)
5. **Vision for canvas/WebGL** — Google Flights, chess boards, maps all require `take_screenshot`; DOM/snapshot returns nothing
6. **Status badge injection** — `🤖 Task description` overlay via DOM, useful for visual feedback during long runs

## Files in this research

- `ARCHITECTURE.md` — port 5192 shared-browser architecture
- `CONCLUSION.md` — initial conclusion (overly favorable, revised)
- `FINAL_COMPARISON.md` — chrome-research vs CDP detailed comparison
- `FINAL_VERDICT.md` — this file, the actual conclusion
- `CDP_APPLY_FLOW_ANALYSIS.md` — how testgrounds CDP approach works
- `CHROME_RESEARCH_APPLY_FLOW.md` — chrome-research apply verification
- `APPLY_FLOW_CONCLUSION.md` — Simon-Kucher CSOD apply test
- `USE_CASE_FLIGHTS.md` — Munich→NYC flight search (vision required)
- `USE_CASE_SOCIAL_MEDIA.md` — LinkedIn post scraping
- `CHESS_USE_CASE.md` — local canvas chess board
- `CURSOR_UI_RESEARCH.md` — macOS cursor/status UI analysis
- `chess-board.html` — local chess board for canvas vision testing
- `upload-file.mjs` — CDP file upload via page-level websocket

## Recommendation

**Drop ego-windows-host. Keep chrome-research MCP as the sole browser driver.** The blitz scripts from testgrounds work identically via `evaluate_script` — they're toolchain-agnostic JS strings. Use the page-level websocket pattern for file uploads. Use `take_screenshot` for vision on canvas/WebGL pages.

The ego-lite project is promising on macOS (kernel-level snapshot, native cursor, profile import) but on Windows it's just a CDP wrapper with extra steps and instability.
