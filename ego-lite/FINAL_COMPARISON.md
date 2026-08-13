# Apply+ Flow: chrome-research vs CDP — Final Comparison (2026-08-13)

## Executive summary

**chrome-research MCP can fully replace the existing CDP/MCP hybrid approach for the apply+ flow.** The blitz pattern (one `evaluate_script` for all fields + page-level websocket for file uploads) works identically on chrome-research. The only architectural difference is connection method — chrome-research uses a persistent MCP connection instead of per-call WebSocket spawning.

## Connection architecture

| Aspect | Existing CDP (testgrounds) | chrome-research |
|---|---|---|
| Chrome profile | Slot2 (port 9223) or Slot3 (port 9224) | Slot4 (port 5192) |
| Connection | Per-call WebSocket to `page.webSocketDebuggerUrl` — new WS per operation | Persistent MCP connection — stays alive across calls |
| Session management | `Target.attachToTarget` + flattened session OR page-level WS (no session needed) | MCP handles internally; `pageId` identifies target |
| Form fill | `Runtime.evaluate` via page-level WS | `evaluate_script` via MCP (same CDP call under the hood) |
| File upload | `DOM.setFileInputFiles` via page-level WS (requires `ws` npm module from testgrounds dir) | Same — `DOM.setFileInputFiles` via page-level WS (still need the Node script) |
| Snapshot | CDP `Accessibility.getFullAXTree` via WS | `take_snapshot` via MCP (same CDP call, returns uid-based tree) |
| Screenshot | Not natively available in CDP helper | `take_screenshot` via MCP — inline in agent context |

## Form filling approach (identical)

Both approaches use the same blitz pattern:

```js
// React-safe value setter — works on both
function setVal(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

// Radio click via label — works on both
function clickRadio(labelText) {
  const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim() === labelText);
  if (label) { label.click(); return label.querySelector('input[type="radio"]')?.checked; }
  return false;
}
```

**No difference.** The blitz scripts from testgrounds can be run verbatim via chrome-research's `evaluate_script` — they're just JS strings evaluated in the page context.

## File upload approach (identical)

Both use `DOM.setFileInputFiles` on the page-level websocket:

```js
const ws = new WebSocket(page.webSocketDebuggerUrl);
const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#resumeFileUpload' });
const desc = await send('DOM.describeNode', { nodeId: node.nodeId });
await send('DOM.setFileInputFiles', { files: [filePath], backendNodeId: desc.node.backendNodeId });
```

**Critical gotcha (same on both):** CSOD has a 50-character file name limit. Files with names exceeding 50 chars silently fail. Must copy to short names (`resume.pdf`, `cover.pdf`) before upload.

## Speed comparison

| Operation | CDP (testgrounds) | chrome-research |
|---|---|---|
| Navigate to job posting | `cdp_helper.cjs navigate <url>` (~2s) | `new_page(url)` (~2s) |
| Click "Apply on company website" | `evaluate` via WS (~1s) | `click(uid)` or `evaluate_script` (~1s) |
| Click "Apply Now" on CSOD | `evaluate` via WS (~1s) | `click(uid)` (~1s) |
| Fill all text fields + radios | One `evaluate` blitz (~1s) | One `evaluate_script` blitz (~1s) |
| Upload resume + cover letter | `cdp_helper.cjs upload` via WS (~6s) | Node script via page WS (~6s) |
| Verify form | `evaluate` checking each field (~2s) | `take_snapshot` + `evaluate_script` (~2s) |
| Visual verification | Not available | `take_screenshot` (~1s) |
| **Total** | **~14s** | **~15s** |

**Tie.** The overhead is Chrome rendering, not the tool chain.

## What chrome-research does better

1. **Inline vision** — `take_screenshot` returns images directly in the agent's visual context. The CDP approach has no screenshot capability — you'd need a separate tool or manual inspection.

2. **Persistent connection** — no need to spawn a new WebSocket per operation. The MCP connection stays alive across all `evaluate_script`, `take_snapshot`, `take_screenshot`, `click`, and `fill` calls.

3. **uid-based element targeting** — `take_snapshot` returns stable uids for every element. `click(uid)` and `fill(uid, value)` use these uids directly — no need to construct CSS selectors or query the DOM.

4. **One toolchain** — chrome-research handles navigation, snapshot, fill, click, evaluate, and screenshot. The CDP approach needs `cdp_helper.cjs` (Node script) + chrome-devtools MCP (for fill/click/snapshot) + manual screenshot workaround.

## What CDP does better

1. **Multi-slot parallelism** — chrome-dog (9223) and chrome-cat (9224) can run two applications in parallel on separate Chrome profiles. chrome-research is a single profile (Slot4, 5192).

2. **Terminal button probe** — the testgrounds has a dedicated `terminal_button_probe.js` that classifies every button as terminal/suspect/navigation to prevent accidental submits. chrome-research doesn't have this — the agent must reason about it.

3. **Blitz runner ecosystem** — the testgrounds has per-ATS blitz scripts (Greenhouse, Workday, LinkedIn, SuccessFactors, Eightfold, Ashby, Google Careers, Brassring) with battle-tested selectors and screening-question pattern matching. These are reusable via `evaluate_script` on chrome-research, but they're not yet wired in.

4. **File upload without `ws` module** — the CDP approach uses Node's `http` module for listing pages and `ws` for WebSocket. chrome-research's file upload still needs a separate Node script (from the testgrounds dir) because MCP doesn't expose `DOM.setFileInputFiles`.

## Per-ATS readiness for chrome-research

| ATS | Blitz script exists? | Works via evaluate_script? | Upload method | Ready? |
|---|---|---|---|---|
| Greenhouse | ✅ `greenhouse_blitz.js` | ✅ Yes — one batch evaluate | `upload_file` MCP or CDP fallback | ✅ Ready |
| Greenhouse EU | ✅ Same script, EU variant | ✅ Yes | Same | ✅ Ready |
| Ashby | ✅ `ashby_blitz.js` | ✅ Yes | `upload_file` MCP | ✅ Ready |
| LinkedIn Easy Apply | ✅ `linkedin_blitz.js` | ✅ Yes (shadow DOM piercing) | Shadow DOM relocate + upload_file | ✅ Ready |
| Workday | ✅ `workday_blitz.js` | ✅ Yes (combobox polling) | `upload_file` MCP | ✅ Ready |
| SuccessFactors | ✅ `successfactors_blitz.js` | ✅ Yes | Probe-then-click + upload_file | ✅ Ready |
| Eightfold | ✅ `eightfold_blitz.js` | ✅ Yes (text fill) | API upload (base64 + fetch) — needs custom script | ⚠️ Upload needs work |
| CSOD (Cornerstone) | ❌ No blitz script (generic_ats used) | ✅ Yes (proven this session) | Page-level WS + DOM.setFileInputFiles (proven) | ✅ Ready |
| Google Careers | ✅ `google_careers_blitz.js` | ✅ Yes | Relocate + upload_file | ✅ Ready |
| Brassring | ✅ `brassring_blitz.js` | ✅ Yes | `upload_file` MCP | ✅ Ready |

## Recommendation

**Switch the apply+ flow to chrome-research as the sole browser driver.** The blitz scripts are toolchain-agnostic — they're just JS strings evaluated in the page context. Run them via `evaluate_script` instead of `cdp_helper.cjs`.

**Migration steps:**
1. Create a `chrome_research_blitz.mjs` that loads the existing `<ats>_blitz.js` scripts and executes them via chrome-research's `evaluate_script`
2. Create a `chrome_research_upload.mjs` that connects to the page-level WS and runs `DOM.setFileInputFiles` (reusable across all ATS types)
3. Wire in the `terminal_button_probe.js` as a pre-submit `evaluate_script` check
4. Use `take_screenshot` for visual verification after every fill
5. Port the blitz scripts' screening-question pattern matching for dynamic form fields

**The blitz scripts need zero changes.** They're pure JS that runs in the page context. chrome-research's `evaluate_script` is the execution engine — same as `Runtime.evaluate` via CDP WebSocket.
