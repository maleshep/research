# ego-lite Cursor / Loading UI Research

**Date:** 2026-08-10
**Question:** What is the macOS "moving cursor" + "loading" UI the user saw, and can any of it be replicated on Windows via chrome-research MCP or ego-windows-host?

## TL;DR

| Question | Answer |
|---|---|
| Is there a custom cursor that moves to clicks? | **Yes.** Implemented as `ego.animationHighlightMouseToPosition(x, y)`, called before every click/hover/drag in `pointer.ts`. |
| Is there a loading / task-state indicator? | **Yes.** `ego.setAgentTaskState(label)` sets the working state + label, shown in browser chrome. |
| Is there an agent overlay (separate from cursor)? | **Yes.** `ego.takeOverTaskSpace()` shows the overlay; `ego.handOffTaskSpace()` hides it. |
| Kernel-level (macOS-only) or CDP-replicable? | **macOS-only.** The `ego` global is injected by the closed-source macOS app binary, not by the public skill repo. The repo only *calls* these methods. |
| Does ego-windows-host (PR #228) implement them? | **No.** Only CDP passthrough, tabs, task spaces, snapshot. The visual methods silently no-op (optional chaining in the skill). |
| Can we replicate on Windows via CDP? | **Partially.** Custom cursor element + element highlight + loading overlay are all injectable via `page.evaluate`. We cannot replicate the browser-chrome task-state badge or the takeOver/handOff overlay. |

## What the cursor UI actually is

The ego-lite macOS app injects a `globalThis.ego` object into every page. The skill layer (the part that's in the public `citrolabs/ego-lite` repo) calls into it before each pointer action. Source: `package/ego-browser/src/driver/pointer.ts`.

### The three visual hooks

In `pointer.ts` (~line 566):

```ts
function maybeHighlight(point: Point, label?: string) {
  const ego = (globalThis as any).ego;
  if (!ego) return;                              // no-op on Windows host
  ego.animationHighlightMouseToPosition?.(point.x, point.y);   // CURSOR ANIMATION
  if (label) {
    ego.setAgentTaskState?.(label);              // LOADING / TASK-STATE BADGE
  }
}
```

`maybeHighlight` is called from `click`, `hover`, and `drag` (lines 69, 119, 153 of `pointer.ts`). It runs **before** `Input.dispatchMouseEvent`, so the user sees the cursor move to the target, then the click happens.

In `helpers.ts` (the task-space facade), there's a third visual hook — the "agent overlay":

- `ego.takeOverTaskSpace()` — shows the agent overlay ("work has resumed" — `helpers.ts:343`)
- `ego.handOffTaskSpace()` — hides it ("hand off a task space back to the user, hiding the agent overlay" — `helpers.ts:320`)
- `ego.completeTaskSpace()` — closes or dismisses the overlay depending on `{ keep: true | false }`

So the visual feedback has **three layers**:

1. **Per-action cursor animation** (`animationHighlightMouseToPosition`) — the "moving cursor" the user described. An animated cursor moves from its last position to the click target.
2. **Per-action task-state label** (`setAgentTaskState`) — a small text label shown alongside, e.g. "Clicking 'Submit'", "Filling 'Email'". This is the "loading" feel.
3. **Per-task overlay** (`takeOverTaskSpace` / `handOffTaskSpace`) — a chrome-level overlay indicating the agent has control of the Space vs. has handed it back to the user.

### What it is NOT

- It is **not** a CSS `cursor:` property change. The skill code never touches `style.cursor`.
- It is **not** an element border highlight (the Playwright `locator.highlight()` style). There's no `outline:` or `box-shadow:` injection in the skill.
- It is **not** CDP's `Input.dispatchMouseEvent` producing a visible cursor — CDP's `Input.dispatchMouseEvent` does NOT move the OS cursor or render anything visible by default. The cursor animation is rendered by the macOS app's compositor, not by the web page.
- It is **not** documented on the marketing site, the blog, or in the docs. `lite.ego.app/`, `/blog/browser-for-run-browser-automation-tasks-in-parallel`, and `lite.ego.app/document/en/docs/{space,product-introduce}` all describe *that* you can watch the agent work but never *what* it looks like. The cursor/loading/overlay UI is visible only in the demo video (`https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc`, linked from the README).

## Where the rendering lives (kernel vs CDP)

```
┌──────────────────────────────────────────────────────────────┐
│  macOS ego-lite app binary  (CLOSED SOURCE — not in repo)    │
│                                                              │
│  - Injects globalThis.ego into every page                    │
│  - Implements:                                                │
│      ego.animationHighlightMouseToPosition(x, y)             │  ← renders cursor animation
│      ego.setAgentTaskState(label)                            │  ← renders task-state badge in chrome
│      ego.takeOverTaskSpace() / handOffTaskSpace()            │  ← shows/hides agent overlay
│      ego.sendCDPMessage(payload)                             │  ← raw CDP passthrough
│      ego.snapshot() / listTabs() / taskSpaces.*              │  ← kernel-level snapshot, etc.
│                                                              │
│  These are all CHROME-LEVEL renders, not page-level.         │
│  The cursor / badge / overlay are drawn by the browser's     │
│  compositor / window chrome, not by the page DOM.            │
└──────────────────────────────────────────────────────────────┘
                          ▲
                          │ calls into
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Public skill layer  (citrolabs/ego-lite on GitHub)          │
│                                                              │
│  package/ego-browser/src/driver/pointer.ts                   │
│    maybeHighlight(point, label) {                            │
│      ego.animationHighlightMouseToPosition?.(x, y)           │  ← conditional call
│      ego.setAgentTaskState?.(label)                          │  ← conditional call
│    }                                                         │
│                                                              │
│  package/ego-browser/src/helpers.ts                          │
│    handOffTaskSpace / takeOverTaskSpace / completeTaskSpace │
│                                                              │
│  Optional chaining (?.) means these are silent no-ops when  │
│  ego is absent or doesn't implement them.                    │
└──────────────────────────────────────────────────────────────┘
```

The macOS app's binary is the renderer. The public repo only contains the *calls*. There is no Chromium fork in the repo (no `chromium/`, `cef/`, `electron/`, or kernel patches visible). The "kernel-level customization" language in the README refers to the snapshot engine, not to cursor rendering — but the cursor/badge/overlay rendering is also macOS-app-side, just not specifically called out.

## What's replicable on Windows

### What's NOT replicable

| Feature | Why not |
|---|---|
| Browser-chrome task-state badge | Lives in the macOS app's window chrome (above the page). Stock Chrome via CDP has no API to draw in the chrome. |
| `takeOverTaskSpace` / `handOffTaskSpace` overlay | Same — rendered at chrome level, not page level. |
| The smooth animated cursor that moves between clicks | The macOS app renders this in its compositor. CDP `Input.dispatchMouseEvent` does NOT move the OS cursor or draw anything; you'd have to fake it with a DOM element (see below). |
| Kernel-level snapshot | Already known — ego-windows-host uses CDP `Accessibility.getFullAXTree` instead. |

### What IS replicable via `page.evaluate` (CDP)

All three are page-level DOM injections. They work on stock Chrome today.

#### 1. Custom cursor element that follows mouse moves

Inject a `<div>` overlay with `position: fixed; pointer-events: none; z-index: 2147483647;`, then drive it from the agent side. Two flavors:

**Flavor A — drive from agent side (simpler, what ego-lite effectively does):**

```js
// Inject once per navigation
await page.evaluate(() => {
  if (document.getElementById('__ego_cursor')) return;
  const el = document.createElement('div');
  el.id = '__ego_cursor';
  el.style.cssText = 'position:fixed;width:24px;height:24px;'
    + 'border-radius:50%;border:2px solid #FF6B35;background:rgba(255,107,53,0.25);'
    + 'pointer-events:none;z-index:2147483647;transition:left 200ms ease,'
    + 'top 200ms ease;left:-100px;top:-100px;';
  document.documentElement.appendChild(el);
  window.__egoMoveCursor = (x, y) => {
    el.style.left = (x - 12) + 'px';
    el.style.top = (y - 12) + 'px';
  };
});

// Then before each click:
await page.evaluate(({x, y}) => window.__egoMoveCursor(x, y), {x, y});
await new Promise(r => setTimeout(r, 200));   // let transition run
await page.mouse.click(x, y);                   // actual CDP click
```

The CSS `transition` is what produces the "moving to the click" animation — the div glides from its last position to the new one over 200ms. This is almost certainly the same effect the macOS app produces, just rendered in the page instead of in the chrome.

**Flavor B — listen to real mouse moves (only useful if a human is watching live):**

```js
document.addEventListener('mousemove', (e) => window.__egoMoveCursor(e.clientX, e.clientY));
```

This would mirror the real cursor — but the agent doesn't fire `mousemove` events when it calls `Input.dispatchMouseEvent`, so Flavor A is what you want for the agent-driving case.

#### 2. Element highlight before click (Playwright `locator.highlight()` equivalent)

Playwright's `locator.highlight()` (v1.20+, optionally with `{ style: 'outline: 2px dashed red' }` in v1.60+) is the canonical version. If driving via Playwright, just call it. If driving via raw CDP / chrome-research MCP, do the same thing manually:

```js
// Highlight the element resolved to point (x, y)
await page.evaluate(({x, y}) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const prev = el.style.outline;
  el.style.outline = '2px solid #FF6B35';
  el.__prevOutline = prev;
  setTimeout(() => { el.style.outline = prev; }, 400);
}, {x, y});
await new Promise(r => setTimeout(r, 200));
await page.mouse.click(x, y);
```

This is what the user might also be remembering — a brief border flash before the click. ego-lite's macOS app does NOT do this (it does the cursor animation instead), but it's a common Playwright pattern and trivial to add.

#### 3. Loading indicator overlay

A small fixed-position banner showing "Working… <label>":

```js
await page.evaluate((label) => {
  let el = document.getElementById('__ego_status');
  if (!el) {
    el = document.createElement('div');
    el.id = '__ego_status';
    el.style.cssText = 'position:fixed;top:12px;right:12px;'
      + 'background:rgba(17,17,17,0.92);color:#fff;font:13px/1.4 system-ui;'
      + 'padding:8px 14px;border-radius:6px;z-index:2147483647;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.documentElement.appendChild(el);
  }
  el.textContent = '🤖 ' + label;
  el.style.display = 'block';
}, 'Clicking "Submit"');

// Later, hide it:
await page.evaluate(() => {
  const el = document.getElementById('__ego_status');
  if (el) el.style.display = 'none';
});
```

This is what `ego.setAgentTaskState(label)` renders in macOS chrome — but a page-level version is 90% as good for "is the agent doing something" feedback.

### Caveats for all three

- **Survives navigation? No.** A full page navigation (not SPA route change) wipes injected DOM. Re-inject after `page.goto()` / `waitForLoadState`. A `MutationObserver` on `documentElement` can re-inject automatically if needed.
- **Cross-origin iframes? No.** Each iframe needs its own injection. For same-origin iframes, walk `document.querySelectorAll('iframe')` and inject into each `contentDocument`.
- **Interferes with page CSS?** Use `!important` sparingly and pick a `z-index` higher than any modal the page might show. `2147483647` (max int32) is the practical ceiling.
- **Shadow DOM?** Closed shadow roots hide elements from `elementFromPoint`. Open ones work fine.
- **Print/screenshots?** The injected cursor and overlay will appear in `take_screenshot` output, which may or may not be desired. Strip them before screenshotting if you want clean captures.

### What chrome-research MCP gives you today

The chrome-research MCP tools (`evaluate_script`, `click`, `fill`, `navigate_page`, `take_screenshot`) are sufficient to do all three patterns above by composing `evaluate_script` calls. There's no built-in `--show-clicks` flag on the MCP — you compose it. The `click` tool does not currently emit a highlight; you'd wrap it with an `evaluate_script` before/after pair.

The chrome-devtools MCP variant has the same shape. Neither exposes a "show me where the agent clicked" mode out of the box.

## Recommendation for the user

If you want the ego-lite macOS cursor/loading feel on Windows, build a thin helper that wraps every chrome-research MCP `click` / `fill` / `navigate` call with:

1. `evaluate_script` to inject + move the cursor div to the element's bounding-box center (Flavor A above).
2. Brief outline pulse on the target element (the Playwright-style highlight).
3. Status badge with the action label ("Clicking 'Submit'", "Filling 'Email'").
4. The actual click/fill via the MCP tool.
5. After a short delay, hide the status badge.

This can be packaged as a tiny wrapper around the chrome-research MCP tools, or as a pre/post hook in the agent's click/fill code path. None of it requires kernel access — pure DOM injection via CDP.

The one thing you cannot replicate on Windows is the chrome-level overlay that ego-lite shows when the agent takes over a Space. That requires either (a) a custom Chromium build (out of scope), or (b) drawing in the page only, accepting that the "agent has control" indicator is a page-level banner rather than a chrome-level one.

## Sources

- **Public skill repo:** https://github.com/citrolabs/ego-lite
  - `package/ego-browser/src/driver/pointer.ts` — `maybeHighlight`, `installClickProbe`, `dispatchMouse` (lines 65-95, 224-300, 566-580)
  - `package/ego-browser/src/helpers.ts` — `handOffTaskSpace`, `takeOverTaskSpace`, `completeTaskSpace` (lines 255-360)
  - `package/ego-browser/src/browser-runtime.ts` — `isBrowserRuntime`, `browserEgo()` (lines 25-35)
  - `package/ego-browser/README.md` — confirms `ego-browser (Chromium) -> globalThis.ego -> Playwright-style helper facades` architecture
  - `AGENTS.md` — confirms `globalThis.ego` bindings are provided by the closed-source ego lite app
  - `README.md` — demo video at `https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc`
- **Marketing site:** https://lite.ego.app/ — silent on cursor/loading UI
- **Blog:** https://lite.ego.app/blog/browser-for-run-browser-automation-tasks-in-parallel — silent on cursor/loading UI
- **Docs:** https://lite.ego.app/document/en/docs/space and `/product-introduce` — describe *that* you can watch the agent, never *what* it looks like
- **PR #228 (Windows host):** https://github.com/citrolabs/ego-lite/pull/228 — implements `sendCDPMessage`, tabs, task spaces, snapshot. Does NOT implement `animationHighlightMouseToPosition`, `setAgentTaskState`, `takeOverTaskSpace`, or any visual overlay. Those methods silently no-op because the skill code uses optional chaining.
- **Playwright reference for highlight:** https://playwright.dev/docs/api/class-locator#locator-highlight — `locator.highlight()` (v1.20+) and `locator.highlight({ style })` (v1.60+) — the canonical page-level highlight API.
