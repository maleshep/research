# ego-lite on Windows: Vision Unlock Architecture

**Goal:** Replicate ego-lite's macOS capabilities on Windows — fast, parallel, stable, with vision — using chrome-research as the driver.

## The Architecture (proven 2026-08-10)

```
┌─────────────────────────────────────────────────────────────┐
│  Slot4 Chrome (port 5192)                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ego-windows-host (EGO_HOST_DEBUG_PORT=5192)           │  │
│  │  Drives: page.goto, fill, click, evaluate, snapshot    │  │
│  │  Manages: taskSpaces, browser tabs                      │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  chrome-research MCP (connects to same port 5192)      │  │
│  │  Vision: take_screenshot → inline in agent context      │  │
│  │  Action: evaluate_script, navigate_page, click, fill    │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Default Chrome (port 9222) — your normal browsing     │  │
│  │  NOT connected to ego or chrome-research               │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## How to launch

```bash
# 1. Launch Slot4 Chrome (chrome-research's profile, port 5192)
powershell.exe -ExecutionPolicy Bypass -File C:/Users/M316235/repo/research/scripts/launch-research.ps1

# 2. Run ego-windows-host against the SAME browser (port 5192)
cd C:\Users\M316235\repo\ego-lite\package\ego-windows-host
EGO_HOST_DEBUG_PORT=5192 node bin/ego-windows-host.mjs -e "<script>"

# 3. chrome-research MCP tools now see what ego drives — take_screenshot works inline
```

## The vision unlock (the key discovery)

On macOS, ego-lite's terminal renders screenshots inline and the agent sees them immediately. On Windows, `page.screenshot()` returns a file path on disk — the agent can't see the PNG content via `Read` tool in Claude Code's terminal.

**The solution:** Use chrome-research MCP's `take_screenshot` tool. It connects to the same Chrome on port 5192 and returns the screenshot **inline in the agent's visual context** — the agent (Claude Code, with vision) sees the rendered page immediately.

This works because:
- ego-windows-host uses `--remote-debugging-port=5192` (configurable via EGO_HOST_DEBUG_PORT)
- chrome-research MCP connects to `http://127.0.0.1:5192/json/version`
- Both attach to the same Chrome instance, sharing tabs and state
- chrome-research's screenshots are rendered as inline images in the agent's message context

## Proven workflow: Google Maps canvas (2026-08-10)

1. ego-windows-host navigates to Google Maps (canvas-heavy page)
2. ego fills search input via `page.evaluate` (fill() fails on Maps input — use evaluate to focus + set value + dispatch input event)
3. ego presses Enter via `page.keyboard.press('Enter')`
4. ego extracts structured data from sidebar via `page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/maps/place/"])).map(...))`
5. chrome-research takes screenshot → agent sees the map with red pins + sidebar with restaurant names

Result: both structured data AND visual confirmation in one pass. Canvas content (map tiles) invisible to AX snapshot but fully visible via screenshot.

## Known limitations

- **Lichess and chess.com blocked** by corporate firewall (net::ERR_ABORTED). Need a canvas-based chess site that isn't blocked, or a local HTML chess board.
- **page.screenshot() returns a file path string**, not PNG bytes. For vision, use chrome-research's take_screenshot instead.
- **page.locator().fill() fails on Google Maps search input** (input[name="q"] with id="ucc-1"). Use `page.evaluate()` to focus + set value + dispatch input event, then `page.keyboard.press('Enter')`.
- **Tabs accumulate**: ego-windows-host creates a new tab on each `openOrReuseTab` call when a task space is fresh. Old tabs persist in the Slot4 profile. Periodically clean up via `browser.closeTab(targetId)` or `taskSpaces.complete(name, { keep: false })`.
- **Parallel limit on 32GB laptop**: ~3-4 concurrent task spaces before Chrome RSS approaches ceiling (9GB headroom after corporate bloat). Each parallel job runs 3-7x slower than serial due to renderer contention.

## Files

- `C:\Users\M316235\repo\ego-lite\` — the ego-lite repo (branch pr-228)
- `C:\Users\M316235\repo\ego-lite\package\ego-windows-host\` — the Windows host
- `C:\Users\M316235\repo\ego-lite\package\ego-windows-host\gauntlet\` — form-filling test scripts + REPORT.md
- `C:\Users\M316235\repo\ego-lite\package\ego-windows-host\parallel-load-test.mjs` — parallel vs serial benchmark
- `C:\Users\M316235\repo\ego-lite\package\ego-windows-host\cap-test.mjs` — 12-capability baseline test
- `C:\Users\M316235\repo\research\ego-lite-website-hero.png` — website hero screenshot
- `C:\Users\M316235\repo\research\ego-lite-parallel-section.png` — parallel multitasking section screenshot
- `C:\Users\M316235\.claude\projects\...\memory\project_ego_lite_windows.md` — project memory
- `C:\Users\M316235\.claude\projects\...\memory\feedback_ego_browser_api_gotchas.md` — API gotchas
