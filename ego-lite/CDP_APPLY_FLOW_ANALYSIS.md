# CDP Apply+ Flow Analysis — testgrounds/job_hunt

> Source repo: `C:\Users\M316235\repo\testgrounds`
> Analyzed 2026-08-13 against the apply+ workflow (`.agent/workflows/apply.md`).
> Purpose: document exactly how the current CDP-based approach fills ATS
> application forms across every supported ATS, so the ego-lite work can
> compare like-for-like.

## 1. Architecture Overview

The apply+ flow is a **hybrid**: it prefers MCP chrome-devtools tools
(high-level snapshot/fill/click abstractions over CDP) but falls back to
**raw CDP over WebSocket** when MCP servers didn't start at session open.
The CDP fallback is formalized in `docs/protocols/chrome_cdp_protocol.md`
and implemented by two scripts:

| File | Role |
|------|------|
| `job_hunt/scripts/cdp_helper.cjs` | CLI swiss-army knife: list/open/navigate/eval/snapshot/upload/file-chooser. One-shot per invocation (no persistent connection between calls). |
| `job_hunt/scripts/blitz/lib/cdp_execute_plan.cjs` | Plan executor: reads `output/execution_plans/<slug>.json`, runs every step via raw `Runtime.evaluate`, and for `manifest[]`-emitting steps fills each field via native `Input.insertText`. |
| `job_hunt/scripts/blitz/blitz_runner.mjs` | Plan generator: detects ATS, loads answer bank, calls `<ats>_blitz.js#buildExecutionPlan`, writes JSON. |
| `job_hunt/scripts/blitz/<ats>_blitz.js` | Per-ATS blitz script (the actual fill-script generator). |
| `job_hunt/scripts/blitz/lib/upload_helper.mjs` | Per-ATS file-upload step generator (5 strategies + generic). |
| `job_hunt/scripts/blitz/terminal_button_probe.js` | Runtime classifier that prevents accidental submit clicks. |

The apply workflow itself lives in `.agent/workflows/apply.md` and is
**7 phases**: preflight -> packet-quality gate -> packet critic -> ATS
dispatch -> form fill -> ATS-specific behavior -> review gate -> audit.
The agent NEVER clicks Submit; that decision is reserved for the user
(Aman) saying exactly `submit [company]`.

## 2. CDP Connection Mechanics

### 2.1 Chrome instances (slots)

Two Chrome instances run side-by-side, each with its own debugging port
and user-data directory so session cookies are isolated:

| Slot | Profile dir | Port | MCP prefix |
|------|-------------|------|------------|
| chrome-dog | `%LOCALAPPDATA%\Google\Chrome\Slot2` | **9223** | `mcp__chrome-dog__*` |
| chrome-cat | `%LOCALAPPDATA%\Google\Chrome\Slot3` | **9224** | `mcp__chrome-cat__*` |

Launch commands (Windows):

```
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9223 \
  --user-data-dir="%LOCALAPPDATA%\Google\Chrome\Slot2" \
  --no-first-run
```

Liveness check:

```bash
curl -s http://127.0.0.1:9223/json/version > /dev/null && echo "DOG OK" || echo "DOG DOWN"
```

### 2.2 Browser-level HTTP endpoints

The CDP HTTP API on each port exposes:

- `GET /json` → list of pages, each with `id`, `title`, `url`, `type`,
  and the all-important `webSocketDebuggerUrl`.
- `GET /json/version` → liveness probe.
- `PUT /json/new?<encoded-url>` → open a new tab at the URL, returns
  the new tab's CDP target ID (a long hex like `E7B60D25FE78EAC509717E871B33EB4A`).

`cdp_helper.cjs` uses Node's built-in `http` module for these — no
external deps. The target ID is a long hex string, **different from**
the integer `pageId` that the MCP server assigns; the workflow
cautions: "Save it as `MY_TARGET_ID`".

### 2.3 Page-level WebSocket (the actual control channel)

For evaluation, navigation, and file upload, the helper opens a fresh
WebSocket to `page.webSocketDebuggerUrl` per operation. From
`cdp_helper.cjs#connectWS` (lines 43-71):

```js
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = {};
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending[msg.id]) {
    pending[msg.id].resolve(msg);
    delete pending[msg.id];
  }
});
// each send() gets a new id, with a 30s timeout
```

Critical: a **new WebSocket is opened for every CLI invocation** —
`cdp_helper.cjs` is one-shot. The executor (`cdp_execute_plan.cjs`)
opens **one** WebSocket for the whole plan and reuses it across all
steps. The plan executor's WebSocket lifecycle (lines 56-67):

```js
const ws = new WebSocket(page.webSocketDebuggerUrl);
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending[i] = { res, rej };
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending[i]) {
    pending[i].rej(new Error('timeout ' + method)); delete pending[i];
  } }, 20000);  // 20s per-step timeout
});
```

### 2.4 Why Node `ws` and not Python `websocket-client`

Documented in `chrome_cdp_protocol.md`:

> Python's `websocket-client` library sends an `Origin: http://127.0.0.1:9223`
> header. Chrome CDP rejects non-browser origins even with
> `--remote-allow-origins=*`. Node.js `ws` does not send this header
> and connects successfully.

`ws` is the only dependency: `npm install ws` once at repo root.

### 2.5 Tab orchestration

A `tab_orchestrator.mjs` (not read in detail here) manages slot
acquisition with a 2-hour watchdog. Workflow rule: call
`node tab_orchestrator.mjs touch <agent-name>` after every section
during long Workday/SF forms to reset the watchdog. The orchestrator
hands out `{instance, mcp_prefix, pageId, cdpTargetId, ready, title_script}`.

### 2.6 Session/target-ID volatility

When Chrome is restarted, **all CDP target IDs change**. The workflow
mandates re-fetching `http://127.0.0.1:9223/json` and re-registering
with the orchestrator after any Chrome restart.

## 3. Field Fill Strategy — the `setVal` Helper

Every blitz script uses the same React-safe value setter. The
canonical version lives in `docs/protocols/chrome_cdp_protocol.md`
and is reproduced verbatim inside each `<ats>_blitz.js` script:

```js
function setVal(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
}
```

### 3.1 Why this works on React-controlled inputs

React overrides the `value` property descriptor on `HTMLInputElement` /
`HTMLTextAreaElement` with its own setter that tracks internal fiber
state. Naive `el.value = x` calls the native setter, which updates
the DOM but **not** React's tracked value — the next React render
reverts it. The fix is to grab the original prototype's setter via
`Object.getOwnPropertyDescriptor(proto, 'value').set` and call it
on the instance. Then dispatch synthetic `input`/`change`/`blur`
events so React's event delegation picks up the change.

This pattern works on:
- **Greenhouse** (React + standard HTML inputs) — both Variant A
  (`#first_name`, `#last_name`, etc.) and Variant B (aria-label
  inputs on `job-boards.eu.greenhouse.io`).
- **Ashby** (single-page React form, standard HTML inputs).
- **LinkedIn Easy Apply** (React inside shadow DOM — see section 5).
- **Eightfold** (React + custom widgets — see section 8 for the
  combobox exceptions).
- **Google Careers** (Material UI React — same pattern works).

### 3.2 Where `setVal` does NOT work — the Workday VPS wall

This is the single most-documented failure mode in the apply+ flow.
**Workday's Validation Policy Server (VPS)** compares DOM state to
React component state on save; if they diverge, it rejects the save
with a `VPS|<uuid>` error code.

From `docs/protocols/workday_field_interaction.md` Rule 1:

> When you inject text via `document.execCommand('insertText')`,
> `setVal()`, or direct `.value` assignment on React-controlled
> fields, the DOM updates visually but the React state does NOT.
> The VPS detects this mismatch and rejects the save.

**Permitted fill methods on Workday** (from Rule 1 table):

| Field Type | Correct Method |
|---|---|
| Date (full MM/DD/YYYY) | Click Calendar button -> click date in picker |
| Text input (Name, Street) | MCP `fill` / `type_text` on snapshot UID, OR `cdp_execute_plan`'s `Input.insertText` path |
| Textarea (Role Description) | MCP `fill` / `type_text` on snapshot UID |
| Combobox (Dropdowns) | Type -> wait -> click matching `[role=option]` |
| Checkbox / Radio | Click via MCP on snapshot UID |
| **Spinbutton** (Month/Day/Year) | `focus()` + `execCommand('selectAll')` + `execCommand('insertText', false, value)` — **the only exception** |

### 3.3 The spinbutton exception — execCommand

`workday_blitz.js#generateFixSpinbuttonsScript` (lines 429-453) uses
`document.execCommand` because spinbuttons are `contentEditable` and
Workday's React handlers pick up `execCommand` events on them:

```js
const sb = sbs[fix.index];
sb.focus();
sb.click();
document.execCommand('selectAll', false, null);
document.execCommand('insertText', false, String(fix.value));
const now = sb.getAttribute('aria-valuenow');
if (now === String(fix.value)) {
  result.fixed.push({ index: fix.index, value: fix.value });
}
```

This is called out in `blitz_runner.mjs#validateNoSetValOnNonSpinbutton`
(lines 195-207) — a static analyzer that warns at plan-generation time
if any step uses `setVal(` on a non-spinbutton field, because that's
the VPS error waiting to happen.

## 4. Batching Strategy — One `evaluate_script` per Section

The workflow's **BLITZ FIRST** rule (`.agent/workflows/apply.md`
Phase 4):

> Never improvise a `querySelectorAll` loop when a blitz script
> exists. Blitz: 1-3 evaluate_script calls per section.
> Improvising: 20-35 per-field calls.

The 2026-07-26 Nvidia incident is cited as the failure mode:
45 minutes spent, 25 ad-hoc `eval` calls. The `cdp_execute_plan.cjs`
executor was built specifically to give the MCP-down path a batch
executor so agents stop improvising per-field calls.

### 4.1 The `manifest[]` pattern — workday's hybrid approach

For ATS where `setVal` is unsafe (Workday), the blitz script returns
a **fill manifest** instead of injecting values directly. From
`workday_blitz.js#generateWorkExperienceScript`:

```js
result.manifest.push({
  entry: i,
  fieldLabel: fm.label,    // e.g. "Job Title"
  value: targetVal,
  method: 'mcp_fill'        // signals the executor to use MCP fill
});
```

The executor (`cdp_execute_plan.cjs#executeManifestStep`, lines 88-115)
then:

1. Probes the DOM for visible inputs whose `aria-label` matches each
   `fieldLabel`, returning their `id`s grouped by label.
2. For each manifest entry, takes the next input id for that label
   (by index — multiple "Job Title" inputs for multiple work-history
   entries).
3. Calls `fillById(fieldId, value)`:
   - Focuses the element + scrolls into view (via `Runtime.evaluate`).
   - Sends `Ctrl+A` via `Input.dispatchKeyEvent` (modifiers: 2,
     windowsVirtualKeyCode: 65).
   - Sends `Input.insertText` with the value — this is the
     **VPS-wall-defeating path** that the workflow calls out.
   - Reads back `.value` via `Runtime.evaluate` to confirm.

So Workday fills text fields via native `Input.insertText`, **not**
via JS `.value` setter. This is the same path MCP uses internally
when you call `fill(uid, value)`.

### 4.2 Where batching goes wrong — LinkedIn shadow DOM

LinkedIn Easy Apply renders inside a shadow root under
`div.theme--dark`. Standard `document.querySelector` cannot reach it.
`linkedin_blitz.js` (lines 26-31) pierces the shadow root manually:

```js
const shadowHost = document.querySelector('div.theme--dark');
if (!shadowHost || !shadowHost.shadowRoot) {
  result.errors.push({ reason: 'Shadow host (div.theme--dark) not found...' });
  return JSON.stringify(result, null, 2);
}
const root = shadowHost.shadowRoot;
```

All subsequent queries use `root.querySelectorAll(...)` instead of
`document.querySelectorAll`. The fill itself is one big IIFE that
returns a JSON string of `{ filled, uploads, unknownQuestions, errors, buttons }`.

### 4.3 File-upload relocation for LinkedIn

The LinkedIn file input lives inside the shadow DOM and MCP's
`upload_file` cannot reach it. `linkedin_blitz.js` (lines 177-194)
defines `generateMoveFileInputScript` that **physically moves** the
input to `document.body` before the upload:

```js
const fileInput = shadowHost.shadowRoot.querySelector('input[type="file"]');
fileInput.style.cssText = 'display:block;position:fixed;top:10px;left:10px;z-index:99999;opacity:1;';
document.body.appendChild(fileInput);
```

Then the workflow says: take a fresh snapshot to get the new UID, then
call `upload_file`. This is the `shadow_dom_relocate` upload method.

## 5. File Upload — Five Distinct Strategies

`upload_helper.mjs` is the central registry. Each ATS gets a different
upload strategy function; the strategy is selected by `STRATEGY_MAP`
at line 275. Here's the complete matrix:

### 5.1 Strategy matrix

| ATS | Method name | Mechanism |
|-----|-------------|-----------|
| LinkedIn Easy Apply | `shadow_dom_relocate` | Move shadow-DOM `input[type=file]` to `document.body`, then `upload_file` MCP |
| Greenhouse | `direct` | `upload_file` MCP on named selectors `input[type="file"][id*="resume"]` |
| Ashby | `direct` | `upload_file` MCP on positional selectors `input[type="file"]:first-of-type` |
| Workday | `direct` | `upload_file` MCP on `input[type="file"]` (single slot) |
| SuccessFactors | `probe_then_click` | Probe SAP attachment widgets -> click button by ID -> triggers native file picker -> `upload_file` MCP |
| Eightfold | `reveal_hidden` (DEPRECATED/BROKEN) | Reveal hidden file input via `style.display='block'` -> `upload_file` — DOES NOT WORK |
| Generic | `direct` | `input[type="file"]:first-of-type` + `:nth-of-type(2)` for cover |

### 5.2 The CDP `DOM.setFileInputFiles` path

When `upload_file` MCP fails with `path-not-in-workspace-roots`,
the workflow falls back to **raw CDP `DOM.setFileInputFiles`**.
From `cdp_helper.cjs#uploadFileToTarget` (lines 98-126):

```js
const doc = await send('DOM.getDocument');
const node = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId,
  selector
});
if (!node.result.nodeId) { ws.close(); reject(new Error('File input not found')); return; }
await send('DOM.setFileInputFiles', {
  nodeId: node.result.nodeId,
  files: [filePath]
});
```

Note: `DOM.setFileInputFiles` accepts **absolute file paths directly** —
no base64, no Blob construction. This bypasses the MCP workspace-root
restriction entirely.

### 5.3 The file-chooser interception method (Eightfold)

For Eightfold, `upload_file` fails because the input is hidden behind
a custom drop zone. `cdp_helper.cjs#uploadViaFileChooser` (lines
128-239) implements **file-chooser interception**:

1. `Page.setInterceptFileChooserDialog({ enabled: true })` — tells
   Chrome to surface file-picker events to CDP instead of opening
   a native dialog.
2. `Runtime.evaluate` to find the "Upload new" button's screen
   coordinates (`rect.x + rect.width/2`, `rect.y + rect.height/2`).
3. `Input.dispatchMouseEvent` for `mousePressed` and `mouseReleased`
   at those coordinates — **the click must be a real input event,
   not a JS `.click()`**, because only trusted clicks open the file
   picker.
4. Listen for the `Page.fileChooserOpened` event, extract
   `params.backendNodeId`.
5. `DOM.setFileInputFiles` with the `backendNodeId` and absolute
   file paths.
6. `Page.setInterceptFileChooserDialog({ enabled: false })` to clean
   up, then `setTimeout(2000)` to let the upload settle.

### 5.4 SuccessFactors probe-then-click

`successfactors_blitz.js` (lines 122-138) probes SAP attachment
widgets because they're custom UI components, not standard file
inputs:

```js
const widgets = document.querySelectorAll(
  '.attachmentComponentInput, .attachWrapper, [class*="attachment"]'
);
// each widget has a button like #attachIcon_xxxx that triggers native picker
```

The agent reads the result, calls `sfClickAttachButton(buttonId)`,
which triggers the native OS file picker. Then `upload_file` MCP is
used on the triggered input. Method name: `probe_then_click`.

### 5.5 Eightfold — the documented broken path

`upload_helper.mjs` (lines 208-211) explicitly marks Eightfold as
broken for the standard CDP path:

> DEPRECATED: This approach (reveal hidden input + upload_file)
> does NOT work on Eightfold. `DOM.setFileInputFiles` reports
> success but `input.files.length` stays 0 (Windows path corruption).
> MCP `upload_file` is blocked by workspace root restrictions.
> USE INSTEAD: API-based upload via resume_upload endpoint. See
> playbooks/eightfold.md for the correct method: base64 chunked
> storage -> `atob()` -> Blob -> File -> `fetch POST` with CSRF
> token.

So Eightfold uploads use a **different path entirely**: an HTTP
API call that ships the file as base64 chunks, reconstructs a
`Blob`/`File` client-side, and POSTs with a CSRF token. This is the
single known ATS where CDP upload paths are abandoned.

## 6. Per-ATS Comparison Matrix

### 6.1 Connection + fill summary

| ATS | Domain | Tier | Form shape | Fill strategy | Connect method |
|-----|--------|------|-----------|--------------|----------------|
| Greenhouse | `boards.greenhouse.io` | 1 | Single-page Quick Apply | One `evaluate_script` batch with `setVal` for all text fields + pattern-matched screening questions | MCP preferred, CDP fallback |
| Greenhouse EU | `job-boards.eu.greenhouse.io` | 1 | Single-page, aria-label inputs | Same as above + `fillByAriaLabel` helper for non-ID inputs | MCP preferred, CDP fallback |
| Ashby | `jobs.ashbyhq.com` | 1 | Single-page | One `evaluate_script` covering all standard HTML fields | MCP preferred, CDP fallback |
| LinkedIn Easy Apply | `linkedin.com/jobs/view/` | 1 | Multi-page modal in shadow DOM | One `evaluate_script` per page that pierces `div.theme--dark` shadowRoot | MCP preferred, CDP fallback |
| Workday | `*.myworkdayjobs.com` | 1 | Multi-section wizard (5 steps) | Hybrid: `setVal` for selects + radios + spinbuttons (execCommand); `manifest[]` for text fields filled via MCP/`Input.insertText` | MCP preferred, CDP fallback |
| SAP SuccessFactors | `*.successfactors.com` | 2 | UI5 shadow DOM | `setVal` for text; probe-then-click for comboboxes; native picker for uploads | MCP preferred, CDP fallback |
| Eightfold | `*.eightfold.ai` | 2 | Single-page React with custom widgets | `setVal` for text; click-select for comboboxes; **API upload** (not CDP) | MCP preferred, CDP fallback |
| Brassring (UKG) | `xjobs.brassring.com` | 2-3 | Multi-step wizard | `setVal` + combobox typeahead + MCP clicks for radios | MCP preferred, CDP fallback |
| Google Careers | `careers.google.com` | 4 (Manual) | Multi-step React + Material UI | `setVal` works on MUI; resume upload via relocate; OAuth wall | MCP preferred, CDP fallback |
| Lever | `jobs.lever.co` | NONE | — | No blitz — record learnings, manual fill | — |
| Avature | `avature.net` | NONE | — | No blitz; **no internal review page** — see Avature trap below | — |

### 6.2 How each ATS clicks radio buttons

All blitz scripts click radios the same way: find the matching radio
by label text, call `radio.click()`. From `greenhouse_blitz.js`
(lines 161-173):

```js
} else if (type === 'radio' || type === 'checkbox') {
  const group = container.querySelectorAll('input[type="' + type + '"]');
  for (const radio of group) {
    const rl = (radio.closest('label') || radio.parentElement)?.textContent?.trim() || radio.value;
    if (radio.value === match.answer || rl.toLowerCase().includes(match.answer.toLowerCase())) {
      radio.click();
      result.filled.push({ label: rawLabel, value: match.answer });
      break;
    }
  }
}
```

Workday's `generateScreeningQuestionsScript` (lines 338-344) uses
the same pattern. The click via `evaluate_script` works on radios
because radio `onChange` handlers commit React state immediately
on click — unlike text inputs where the VPS wall applies.

### 6.3 How each ATS handles comboboxes — the Workday decision tree

`docs/protocols/workday_field_interaction.md` Rule 7 codifies the
combobox decision tree (consolidates all earlier guidance):

1. Click the combobox field (MCP `click` on snapshot UID).
2. Type the search term (MCP `type_text`, or `Ctrl+A` then type
   to replace).
3. **WAIT 1-2 seconds** for the `[role=option]` dropdown to appear
   with filtered results.
4. **CLICK the matching `[role=option]`** — primary method. The
   click triggers React's selection handler and commits the value.
   (Learned 2026-07-08 Avanade — prior "press Enter to commit"
   guidance was WRONG: Enter triggers search, it does NOT commit.)
5. FALLBACK — if no option matches (e.g. HHL Leipzig school name
   not in database): press Enter to create a custom free-text entry.
6. Multi-select (e.g. "How Did You Hear About Us"): repeat steps
   1-4 per value; each click commits independently. `fill_form`
   does NOT register.

`workday_blitz.js#generateComboboxScript` (lines 475-537) implements
this as an async IIFE that polls for the filtered dropdown up to 6
times (500ms each = 3s max), then clicks the matching option:

```js
for (let attempt = 0; attempt < 6; attempt++) {
  await waitFor(500);
  const options = document.querySelectorAll('[role="option"]');
  for (const opt of options) {
    const t = opt.textContent?.trim() || '';
    if (t.toLowerCase().includes(params.newValue.toLowerCase())
        && !t.toLowerCase().includes('delete')) {
      opt.click();
      result.fixed.push({ action: 'selected_option', value: params.newValue });
      clicked = true;
      break;
    }
  }
  if (clicked) break;
}
```

### 6.4 Workday combobox chip clearing

Before setting a new value, the existing chip must be cleared
(Workday won't let you select a new option while an old one is
selected). From `workday_blitz.js` lines 482-490:

```js
const selectedOptions = document.querySelectorAll('[role="listbox"] > [role="option"]');
for (const opt of selectedOptions) {
  const t = opt.textContent?.trim() || '';
  if (t.includes(params.clearValue) && t.includes('delete')) {
    opt.click();
    result.fixed.push({ action: 'cleared', value: params.clearValue });
    break;
  }
}
```

## 7. Terminal Button Probe — the Anti-Accidental-Submit Guard

The probe exists because of a real incident:
**2026-07-05 Bayer** — a filler agent clicked a terminal SAP
SuccessFactors "Apply" button because nothing in the blitz layer
classified it as terminal at runtime. The probe was wired in
2026-07-06 as a hard runtime guard.

### 7.1 How the probe classifies

`terminal_button_probe.js` (lines 83-195) generates a JS string that,
when evaluated, scans every button on the page and returns:

```json
{
  "terminal": true,
  "reason": "Unambiguous submit button detected (submit application / submit now / send my application). HARD STOP — do not click.",
  "buttons_found": [{ "text": "...", "role": "button", "is_terminal_suspect": false }],
  "form_shape": {
    "single_page": true,
    "has_step_indicator": false,
    "has_review_page_downstream": false
  }
}
```

Decision rules:

- **Unambiguous submit** patterns: `^submit application$`,
  `^submit now$`, `^send my application$` — always terminal,
  regardless of form shape.
- **Suspect** patterns: `^apply$`, `^submit$`, `^finish$`, `^send$`
  — terminal only if the form is single-page AND no downstream
  review step is expected.
- **Navigation** patterns (always safe): `^apply on company website$`
  (LinkedIn redirect), `^save$`, `^save and continue$`, `^continue$`,
  `^next$`, `^back$`.

Form-shape signal: `[data-testid*="step"], [role="progressbar"],
.step-indicator` — if any of these exist, the form is multi-step
(`single_page = false`).

### 7.2 The `expectReviewStep` flag

Each blitz knows its ATS's review-step behavior. The probe takes an
`opts.expectReviewStep` boolean:

- **Workday, Greenhouse (multi-step with review)**: pass
  `expectReviewStep: true` — a suspect "Apply" button on a
  single-page form is treated as navigation to the review step,
  NOT terminal.
- **Ashby, Eightfold (single-page, no review)**: pass
  `expectReviewStep: false` (default) — any "Submit Application"
  on the single-page form IS terminal.
- **LinkedIn Easy Apply**: `expectReviewStep: true` — multi-page
  modal with a review page before final submit.

### 7.3 Hard stop rule

If the probe returns `terminal: true`, the filler MUST treat it as a
**hard stop** and escalate to the review gate. It must NEVER click
a terminal-suspect button, even if the blitz execution plan includes
a submit step. The review gate protocol still applies — this probe
is an additional runtime guard, not a replacement.

The probe step appears in EVERY blitz plan, immediately before any
button-click step.

## 8. Workday-Specific Deep Dive

Workday gets its own section because it has the most documented
failure modes and the most sophisticated blitz.

### 8.1 Multi-section wizard structure

From `company_ats_experience.json` for Novartis (the canonical
reference application), the Workday wizard has 5 form steps:

1. `my_information` — text_input, combobox, checkbox, radio, spinbutton
2. `my_experience` — text_input, spinbutton (+ textarea for descriptions,
   upload_widget for resume)
3. `application_questions` — combobox, checkbox (+ multi-select for skills)
4. `voluntary_disclosures` — dropdown, checkbox
5. `review` — summary

### 8.2 The full blitz execution plan

`workday_blitz.js#buildExecutionPlan` (lines 624-822) generates
this step sequence:

1. `fill_my_information` — emits `manifest[]` for text fields (filled
   via MCP/CDP) + `filled[]` for native selects (Phone Type, Country,
   Source, How did you hear).
2. `nav_to_experience` — clicks Next/Save/Weiter button.
3. `fill_work_experience_text` — emits `manifest[]` for Job Title,
   Company, Location, Role Description per entry.
4. `fix_work_experience_dates` — calls `generateFixSpinbuttonsScript`
   with computed spinbutton indices. Spinbutton layout:
   - WE1: FromMonth(0), FromYear(1)
   - WE2: FromMonth(2), FromYear(3), ToMonth(4), ToYear(5)
   - WE3: FromMonth(6), FromYear(7), ToMonth(8), ToYear(9)
   - WE4: FromMonth(10), FromYear(11), ToMonth(12), ToYear(13)
5. `fix_education_years` — same execCommand pattern for education
   spinbuttons (indexed after WE spinbuttons).
6. `education_gpa_manifest` — emits `manifest[]` for GPA text fields.
7. `education_degree_dropdown` — async script that clicks each
   `button[aria-haspopup="listbox"]`, finds the education-NN prefix
   by walking ancestors, and clicks the matching `[role=option]`
   by per-entry regex:
   - Oxford Executive Diploma: `post-?diploma` (fallback "University
     Diploma", then "Masters" only as last resort) — learned
     2026-07-26 Nvidia.
   - HHL MBA: `^masters$`.
   - NIT B.Tech: `^bachelors$`.
8. `education_combobox_<N>` — one step per education entry with a
   `fieldOfStudy`, runs the async combobox clear-type-poll-click flow.
9. `fill_languages` — handles BOTH Pfizer/newer button+listbox
   dropdowns AND legacy spoken/written `<select>`s. Resolves
   canonical proficiency (Advanced / Professional Working / Fluent)
   to tenant labels via `PROFICIENCY_ALIASES`:
   - English: `Advanced` (never Native — Aman is not native EN)
   - German: `Professional Working` (B2 — never Native or C2 Fluent)
   - Hindi: `Fluent` (Native Speaker OK)
10. `fill_websites` — emits `manifest[]` for LinkedIn URL.
11. `generateUploadSteps('workday', ...)` — single `input[type="file"]`.
12. `fill_screening` — pattern-matched answers for screening questions.
13. `nav_to_review` — clicks Next/Save.
14. `terminal_button_probe` — with `expectReviewStep: true`.

### 8.3 Workday known failures (the big four)

#### 8.3.1 VPS rejection on JS-injected text

Already covered in section 3.2. Recovery: re-fill affected fields via
native MCP `fill`/`type_text`. Rule 1b says **never reload the page**
(reloads log out the session) — instead navigate Back, re-advance,
re-enter every field natively.

#### 8.3.2 Back navigation crash

> If you see "Something went wrong" at ANY point: STOP IMMEDIATELY.
> Do not attempt reload, recovery, or any further Chrome interaction.
> Report to coordinator right now: `"ESCALATION: Workday crash on
> [section name]. Current URL: [url]."`

Back navigation triggers the crash. Self-recovery makes it worse.
The coordinator decides: reload + re-login, or abandon.

#### 8.3.3 Language dropdowns reset on Back navigation

> Navigating Back resets ALL Language fields to "Select One". After
> any Back navigation, re-fill all Language rows before saving.

The `generateLanguagesScript` includes a `persistenceNote` warning
that the agent must navigate AWAY from Languages and back to verify
persistence — silent reset is a known issue.

#### 8.3.4 Illegal characters in free text

Workday silently rejects `< > [ ] " { } \\` in text inputs and
textareas, but only reports the error at Save time. The workflow's
"What You NEVER Do" section says:

> Never enter `< > [ ] " { } \\` in Workday free-text fields.

The `ats_dispatcher.mjs` is supposed to sanitize, but agents are
told to always check before pasting role descriptions.

### 8.4 Pfizer language widget pattern (learned 2026-07-27)

Pfizer's Workday tenant uses a different language widget:
`button[id="<pfx>--language"]` + a hashed Overall-proficiency button
like `<pfx>--3f2e9c55...`. The blitz handles both Pfizer-style buttons
and legacy `<select>`s by checking for each in turn. Also: Pfizer
proficiency labels differ — "Advanced (Proficient)", "Moderate
(Intermediate)", "Fluent (Native Speaker)" — so the alias map resolves
canonical levels to tenant labels.

### 8.5 The trusted-event wall for "Add" buttons

> Adding cards requires a TRUSTED click (JS click does NOT register
> new cards — learned Pfizer 2026-07-27).

`generateLanguagesScript` tries JS `.click()` first; if the new
language-card prefix doesn't appear within 1.2s, it emits a
`manifest[]` entry: `{ action: 'click_add_language', method: 'mcp_click' }`
— signaling the agent must click via MCP/CDP natively.

## 9. ATS-Specific Quirks Catalog

### 9.1 Greenhouse — Variant A vs Variant B

`greenhouse_blitz.js` handles two variants based on hostname:

- **Variant A** (`boards.greenhouse.io`, `job-boards.greenhouse.io`):
  uses element IDs `#first_name`, `#last_name`, `#email`, `#phone`,
  `#job_application_linkedin_profile_url`, and
  `input[name="job_application[location]"]`. Covers Anthropic,
  Celonis, Databricks.

- **Variant B** (`job-boards.eu.greenhouse.io`): no element IDs,
  uses `aria-label` inputs. Country/Visa/Salary comboboxes are
  **NOT injectable** — handled individually after the batch fill.
  Covers Talon.One.

Detection: `window.location.hostname.includes('eu.greenhouse.io')`.

### 9.2 LinkedIn Easy Apply — shadow DOM

Three-step flow per page:

1. `generateFillScript` — pierces `div.theme--dark` shadowRoot,
   builds label-to-element map from `aria-label`/`placeholder`/`name`
   + associated `<label>` elements, fills by key matching
   `['first name', 'vorname', 'first_name']` etc.
2. `generateMoveFileInputScript` — moves shadow-DOM file input
   to `document.body`.
3. `generateContinueScript` — clicks `aria-label="Continue to next step"`
   or text "Next"/"Weiter" inside the shadow root.

The fill script also pattern-matches custom questions inside
`.fb-dash-form-element, .artdeco-text-input,
.jobs-easy-apply-form-element, [class*="form-element"]`.

### 9.3 SAP SuccessFactors — UI5 shadow DOM

`successfactors_blitz.js` exposes four generator functions:

1. `generateSuccessFactorsFieldDiscoveryScript` — returns full
   input inventory with label, type, name, id, value, required.
2. `generateSuccessFactorsPersonalInfoScript` — fills firstName,
   lastName, contactEmail, Phone Country Code (aria-label),
   cellPhone, address, city, state, zip, Country (aria-label).
3. `generateSuccessFactorsComboboxScript` — fills comboboxes by
   `aria-label` with a `setVal` + `InputEvent` + `KeyboardEvent`
   Enter keydown/keyup sequence.
4. `generateSuccessFactorsAttachmentProbeScript` — finds SAP
   attachment widgets and their button IDs.

Plus `generateFormFingerprintScript` that returns
`"sf-<sections>s-<fields>f-<picklists>p"` — agents compare this
against `company_ats_experience.json sf_fingerprint` to detect
form-variant changes between applications at the same company.

SF's known issue from `successfactors_field_interaction.md`:
UI5 picklists may not persist JS-set `.value` even with the
input/change/blur event sequence — UI5's shadow DOM component
state is independent of the DOM. Two-strike rule: if a picklist
shows "No Data" after 2 fill attempts, it's an ATS misconfiguration
(empty server-side data source) — mark broken and move on.

### 9.4 Eightfold — React with custom widgets

`eightfold_blitz.js` flags five known quirks in its `warnings[]`:

1. **MCP `fill()` concatenates salary fields** — must use `setVal`
   via `evaluate_script`, not direct MCP fill.
2. **Data processing radio resets on every page reload** —
   volatile field that needs post-reload verification.
3. **Cover letter chip disappears on every page reload** —
   same volatile category.
4. **Resume dropdown auto-selects last uploaded file** — may be
   the wrong file if multiple have been uploaded.
5. **`evaluate_script` clicks do NOT trigger file choosers** —
   must use `Input.dispatchMouseEvent` (real trusted click).

Comboboxes: click to open dropdown, then click matching
`[role=option]`. If option not visible, type to filter and
retry. Some comboboxes (Add Education) only accept typeahead
suggestions, not free text.

### 9.5 Ashby — simplest ATS

`ashby_blitz.js` is the smallest of the blitz scripts (~138 lines).
Single-page form, standard HTML inputs, no shadow DOM, no custom
widgets. The fill is one `evaluate_script` call covering all
standard fields via `tryFill(['input[name="name"]',
'input[placeholder*="name" i]', '#name'], ...)`. The workflow
calls Ashby "100% coverage" — the only ATS that achieves this.

### 9.6 Brassring (UKG Infinite Talent)

`brassring_blitz.js` (Mizuho Bank Singapore) has notable quirks:

- **Account creation wall**: Brassring requires email + password
  + Security Question 1 (dropdown). The security-question dropdown
  does NOT register selection via JS `.click()` — MUST use a real
  MCP `click()` on the `[role="option"]` element from a snapshot.
- **Resume-upload-first = autofill leverage**: upload resume FIRST;
  Brassring's parser auto-populates first/last name, email,
  education history (3 entries), work experience (most recent
  only), and skills (up to 45). Then fill the gaps.
- **Country/Region combobox** defaults to "Singapore" — must
  change to candidate's actual country.

### 9.7 Google Careers — Manual-tier (4)

`google_careers_blitz.js` is documented as NOT a fast-fill ATS:

> Manual-tier (4) — Google OAuth + file upload + variable screening
> means agents must interact directly. The blitz script covers
> what it can but Google Careers is NOT a fast-fill ATS.

- OAuth wall: requires Google account sign-in before the form loads.
  Must use personal Gmail, NOT Merck Google Workspace.
- Material UI React: `setVal` pattern works for text fields.
- 4-step flow: Contact info -> Resume & cover letter upload ->
  Screening questions -> Review & submit.

### 9.8 Avature — the trap

> Avature has **no internal review page**. The final "Save" on the
> last questionnaire step submits the application immediately and
> permanently. You MUST complete the review gate (steps 3a-3d)
> BEFORE clicking the final Save on any Avature form.

Avature has no blitz script. BCG Platinion (2026-06-04) was the
canonical failure. The workflow rule: stop at the second-to-last
step, write the review HTML, open it in the browser, and wait for
`submit [company]` before proceeding to the final Save.

## 10. Timing Data — Wall-Clock per Section

`interaction_logger.mjs` exists to capture per-section timing, but
the `output/interaction_logs/` directory is currently empty (no
historical JSONL files were found at analysis time). What's known
about timing comes from incident notes embedded in the code:

### 10.1 Incident-derived timing

| ATS | Date | Issue | Wall-clock |
|-----|------|-------|-----------|
| Nvidia (Workday) | 2026-07-26 | 25 ad-hoc `eval` calls (no batch executor) | **45 minutes** — single form |
| Bayer (SuccessFactors) | 2026-07-05 | Filler clicked terminal "Apply" button — incident led to terminal-button-probe creation | (no duration recorded) |
| Avanade (Workday) | 2026-07-08 | Multi-field VPS error after bulk fill — required Back + re-advance + native re-fill | "extended" — no number |
| DBS | 2026-07-18 | Packet critic bypassed — had to be surfaced mid-form | (no duration recorded) |
| Pfizer (Workday) | 2026-07-27 | JS click on Add Language button did not register (trusted-event wall) | (no duration recorded) |
| Verily (Workday) | 2026-06-20 | Password field: `execCommand('insertText')` fills DOM but React state doesn't register | (no duration recorded) |
| Lundbeck (SuccessFactors) | 2026-05-27 | Standard `input[type=file]` does NOT work for SAP attachment widgets | (no duration recorded) |

### 10.2 Implicit timing from structure

Per the workflow's BLITZ FIRST rule:

- **Batched blitz fill**: 1-3 `evaluate_script` calls per section,
  each call returning a JSON manifest of filled/errored/unknown fields.
- **Improvised per-field fill** (the failure mode): 20-35 `eval` calls
  per section — explicit reference to the 25-call Nvidia incident.

Each `evaluate_script` call has:
- WebSocket setup overhead (reconnect per `cdp_helper.cjs` invocation;
  reused in `cdp_execute_plan.cjs`).
- 20-second per-step timeout in the executor (line 65).
- 30-second per-call timeout in `cdp_helper.cjs` (line 57).
- 500ms sleep between steps in the executor (line 136).

### 10.3 Per-ATS step count (from the blitz plans)

Approximate step counts in a typical `buildExecutionPlan` output:

- **Ashby**: 3 steps (fill_form + upload + terminal_button_probe +
  submit) — fastest path.
- **Greenhouse**: 4 steps (fill + upload + probe + submit).
- **LinkedIn Easy Apply**: 4+ steps per page * N pages (typically
  3-4 pages → 12-16 steps total, plus per-page uploads).
- **Workday**: ~14 steps for a full 4-entry work-experience +
  3-entry education form (the longest blitz).
- **SuccessFactors**: ~6 steps (discover + fingerprint + personal_info
  + comboboxes + upload + probe).

### 10.4 Estimated wall-clock per ATS

Based on step counts + 500ms sleep + ~200ms per CDP round-trip +
typical DOM evaluation time:

| ATS | Estimated full-fill wall-clock |
|-----|-------------------------------|
| Ashby | 5-15 seconds (3 steps, single page) |
| Greenhouse | 10-30 seconds (4 steps, single page) |
| LinkedIn Easy Apply | 60-180 seconds (12-16 steps across 3-4 modal pages) |
| Workday | 3-10 minutes (14 steps + combobox polling 6×500ms each) |
| SuccessFactors | 30-90 seconds (6 steps + probe-then-click for uploads) |
| Eightfold | 60-120 seconds (single-page but combobox clicks are sequential) |
| Google Careers | Manual-tier — variable, mostly human-paced |
| Lever / Avature | Manual — no blitz |

These are estimates; the workflow cites Nvidia as a real-world 45-min
Workday fill when the batch executor wasn't used. With
`cdp_execute_plan.cjs`, that should drop to the 3-10 minute range.

## 11. Failure Modes — Comprehensive Catalog

### 11.1 Connection failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `WebSocketBadStatusException: Handshake status 403 Forbidden` | Using Python `websocket-client` which sends `Origin` header Chrome rejects | Use Node.js `ws` library instead |
| "Page not found — target IDs changed after Chrome restart" | Chrome restart invalidates all CDP target IDs | Re-fetch `http://127.0.0.1:9223/json`, re-register with orchestrator |
| MCP tools not visible at session start | MCP server failed to connect because Chrome wasn't running yet | Follow `chrome_cdp_protocol.md` CDP fallback |
| Slot released mid-form | Watchdog 2-hour timeout | Call `tab_orchestrator.mjs touch <agent>` after every section |

### 11.2 Fill failures

| Symptom | ATS | Cause | Fix |
|---------|-----|-------|-----|
| `VPS\|<uuid>` error on Save | Workday | `setVal` / `execCommand('insertText')` / direct `.value` assignment on React-controlled text fields | Use MCP `fill(uid, value)` or `Input.insertText` via `cdp_execute_plan.cjs` |
| Field visually set but resets on Save | Workday | Same as above — DOM state diverged from React state | Same as above |
| Combobox value not committing | Workday | Pressed Enter instead of clicking `[role=option]` | Type to filter, wait 1-2s, **click the option** — Enter triggers search, not commit |
| Combobox chip not clearing | Workday | Tried to manipulate aria attributes instead of clicking the option | Click the `[role="option"]` inside `[role="listbox"][aria-label*="items selected"]` |
| Spinbutton date not set | Workday | Tried `setVal` on `[role="spinbutton"]` | Use `focus()` + `execCommand('selectAll')` + `execCommand('insertText', false, value)` |
| Language dropdown resets to "Select One" | Workday | Back navigation | Re-fill all Language rows before saving |
| "Something went wrong" crash | Workday | Back navigation on certain steps | STOP — escalate to coordinator. Never reload (logs out session). |
| Add Language button click does nothing | Workday (Pfizer) | JS `.click()` not trusted | Emit `manifest[]` entry — agent clicks via MCP native click |
| Field reverts after `setVal` | Workday | Field is React-controlled and VPS rejects | Same fix as `VPS|<uuid>` — use native MCP fill |
| Oxford set to "Masters" instead of "Post-diploma studies" | Workday (Nvidia) | Old protocol claimed no Executive Diploma option | Use `degree_option: 'post-?diploma'` regex per entry — see `workday_blitz.js#generateDegreeDropdownScript` |
| Picklist shows "No Data" | SuccessFactors | UI5 shadow DOM state independent of DOM; possibly empty server-side data source | Two-strike rule — after 2 failed attempts, mark broken, move on |
| Apply button disabled on Review | SuccessFactors | Internal validation sees required picklist as unset even when DOM shows value | Do NOT force-click. Report to user, ask whether to proceed with blanks |
| Combobox option not found | Workday | School name (HHL Leipzig) not in Workday database | Fallback: type full name, press Enter to create custom free-text entry |
| Salary field concatenates instead of replacing | Eightfold | MCP `fill()` appends to existing value | Use `setVal` via `evaluate_script`, never MCP `fill` for salary |
| File picker doesn't open | Eightfold | `evaluate_script` clicks aren't trusted | Use `Input.dispatchMouseEvent` (real mousePressed + mouseReleased) |

### 11.3 Upload failures

| Symptom | ATS | Cause | Fix |
|---------|-----|-------|-----|
| `path not within configured workspace roots` | All | MCP `upload_file` restricts paths to workspace roots | Fall back to CDP `DOM.setFileInputFiles` with absolute paths |
| `DOM.setFileInputFiles` reports success but `input.files.length === 0` | Eightfold | Windows path corruption in the CDP payload | Use the API-based upload path: base64 chunks → `atob()` → Blob → File → `fetch POST` with CSRF token |
| Standard `input[type="file"]` selector finds nothing | SuccessFactors | SAP attachment widgets are custom UI components, not standard file inputs | Use probe-then-click: `probe_attachments` → get button IDs → click by ID → `upload_file` on triggered input |
| File input not reachable | LinkedIn Easy Apply | Input lives inside shadow DOM | Move input to `document.body` via `generateMoveFileInputScript`, take fresh snapshot, then `upload_file` |
| File input not visible (hidden by CSS) | Eightfold / generic | `display:none` or `opacity:0` on input | Reveal via `style.display='block'; style.opacity='1'` before upload (NOTE: deprecated for Eightfold per upload_helper.mjs) |

### 11.4 Workflow / process failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Filler clicked Submit accidentally | No runtime classifier on button labels | Terminal button probe — runs before every click step, returns `terminal: true` for hard stop |
| Filler clicked "Apply" on external ATS (Bayer 2026-07-05) | "Apply" is overloaded — LinkedIn Apply is navigation, ATS Apply is terminal | Disambiguation rule in apply.md Phase 3 Step 4: "Apply" on LinkedIn = navigation redirect (click it); "Apply" on external ATS = treat as terminal unless probe says safe |
| Packet critic bypassed (DBS 2026-07-18) | Agent+ panel-pass gate skipped for score-9 role | Phase 2.5 is mandatory for score-9/aspirational; if noticed mid-form, STOP and run critic |
| BCG Platinion Avature accidental submit | No internal review page on Avature — final Save submits | Stop at second-to-last step, write review HTML, open in browser, wait for `submit [company]` |
| Audit blocker | Prior application's learning log unmerged | Process `pending_learning_log.json` before starting new application — `record_company_experience.mjs --from-learning-log` |
| Duplicate application | Same company+title already in pipeline at `applied`/`interviewing` stage | `ats_dispatcher.mjs#checkDuplicateApplication` surfaces warning |
| Wrong ATS detected | Dispatcher's URL heuristic returns wrong ATS (BCG Platinion: greenhouse URL but redirected to Avature) | Re-detect from actual redirect URL after clicking Apply — never trust dispatcher's pre-click ATS |

### 11.5 Session / auth failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Workday session expires mid-form | Sessions are short-lived | "Use My Last Application" — Workday auto-saves completed sections; re-verify each before continuing |
| Page reload logs out Workday session | Reload triggers fresh authentication check | NEVER reload — navigate Back instead (and if Back crashes, escalate) |
| OAuth wall on external ATS | LinkedIn sign-in required | Report, mark manual |
| Google Careers requires Google account | OAuth wall | Pre-login to personal Gmail (not Merck Workspace) in Chrome profile |

## 12. The Full Pipeline — From URL to Submit-Ready

Here's the end-to-end apply+ flow with each CDP touchpoint called out:

### 12.1 Phase 1: Preflight

1. Check Chrome liveness: `curl http://127.0.0.1:9223/json/version`.
2. If MCP tools visible, use them; otherwise CDP fallback
   (`docs/protocols/chrome_cdp_protocol.md`).
3. Acquire tab slot: `node tab_orchestrator.mjs spawn <agent> dog`.
4. Navigate to LinkedIn job URL via `navigate_page` (MCP) or
   `PUT /json/new?<url>` (CDP fallback — `cdp_helper.cjs open`).

### 12.2 Phase 2: Packet Quality Gate

No CDP involvement — pure artifact checks (resume, cover letter,
packet.md, cover letter lint).

### 12.3 Phase 2.5: Packet Critic

No CDP involvement — `packet_critic.mjs --slug <slug>` is a Node.js
script that does persona-based scoring on the packet.md.

### 12.4 Phase 3: ATS Dispatch

1. `compile_agent_context.mjs --role <slug>` — read-only capsule.
2. `ats_dispatcher.mjs --role <slug>` — outputs `{ats, answers, uploads, pause_fields, company_experience}` JSON.
3. Navigate to LinkedIn job URL via MCP `navigate_page` or CDP
   `Page.navigate`.
4. **Inline JD capture** — `evaluate_script` on the job page that
   returns `{ jobId, title, fullText }` from `<main>`. Write to
   `job_hunt/jobs/captured/<jobId>-<company-slug>.txt`.
5. Click "Easy Apply" / "Apply" / "Bewerben" button.
6. Re-detect ATS from actual redirect URL (Step 4 of Phase 3):
   `*.successfactors.com` → SuccessFactors,
   `*.myworkdayjobs.com` → Workday, etc.
7. `blitz_runner.mjs --role <slug>` — generates
   `output/execution_plans/<slug>.json`.
8. Read `job_hunt/scripts/blitz/<ats>_blitz.js` for reference
   (the agent IS the runner; the script is not invoked directly).

### 12.5 Phase 4: Form Fill

1. Start interaction logger: `interaction_logger.mjs start <slug> <ats> <company>`.
2. Take ONE snapshot → identify all fields.
3. Map fields to `answers` from dispatcher output.
4. Check `company_experience.quirks` for known section quirks.
5. **Mode A (Blitz inject)**: ONE `evaluate_script` per section
   using the React-safe `setVal` pattern. Inspect returned JSON
   (`{ filled, errors, manifest, unknownQuestions }`). Fix only
   errored fields.
6. **Mode B (Batch fill)**: `fill_form` with multiple fields from
   one snapshot — for ATS without a blitz script.
7. **Mode C (Per-field)**: comboboxes, file inputs, date pickers.
   Follow type-then-validate-then-select for comboboxes.
8. After each section: `tab_orchestrator.mjs touch <agent>` +
   `interaction_logger.mjs section-complete <slug> <section> <filled> <errored> <unknown> <duration_ms>`.
9. After each upload: `interaction_logger.mjs upload <slug> <file_type> <method> <success|fail> [error_msg]`
   where method is one of `shadow_dom_relocate`, `direct`,
   `reveal_hidden`, `probe_then_click`, `generic`.

**CDP-native executor (MCP-down fallback)**: when MCP tools are not
visible, use `cdp_execute_plan.cjs`:

```bash
node job_hunt/scripts/blitz/blitz_runner.mjs --role <slug>
node job_hunt/scripts/blitz/lib/cdp_execute_plan.cjs <slug> <cdpTargetId> --dry-run
node job_hunt/scripts/blitz/lib/cdp_execute_plan.cjs <slug> <cdpTargetId>
node job_hunt/scripts/blitz/lib/cdp_execute_plan.cjs <slug> <cdpTargetId> --step <id>
```

### 12.6 Phase 5: ATS-Specific Behavior

- **SuccessFactors**: read `successfactors_field_interaction.md`
  Rules 1-4 (picklist preflight scan, two-strike rule, disabled Apply
  on review, SAP attachment widgets).
- **Workday**: read `workday_field_interaction.md` Rules 1-7
  (VPS wall, illegal chars, application gate HTML, calendar picker,
  session management, self-identify step, combobox decision tree).
- Back navigation crash on Workday: STOP IMMEDIATELY. Escalate.
- Multi-field VPS recovery: navigate Back, re-advance, re-enter
  every field natively.

### 12.7 Phase 6: Review Gate (Non-negotiable)

1. Reach the review page (or last safe screen for Avature).
2. Verify persisted values — no "No Response" for fields with real
   values. Workday extended check: salary, GPAs, languages, German
   fluent checkbox.
3. Write review HTML to `output/review_<slug>.html` using the
   template at `output/application_review_gate_template.html`.
4. Register review state: `tab_orchestrator.mjs set-review ...`.
5. Open in browser: `start "" "file:///C:/..."` for HTML, resume
   PDF, cover letter PDF.
6. ONLY NOW report to user: `"Review gate open. Awaiting 'submit [company]'."`
7. NEVER click Submit. Force-click via `removeAttribute('disabled') + click()`
   on Submit is FORBIDDEN.

### 12.8 Phase 7: Audit (Mandatory — every application)

1. `audit_post_apply.mjs --role <slug>` → writes
   `job_hunt/coordinator/pending_learning_log.json`.
2. Edit the log: add every quirk discovered
   (`field_type`, `selector`, `action`, `action_steps`,
   `affected_sections`, `first_discovered`, `notes`).
3. Set status: `awaiting_merge` or `confirmed_no_new`.
4. `record_company_experience.mjs --from-learning-log` — merges
   into `company_ats_experience.json`.
5. Verify `ats_dispatcher.mjs` no longer shows
   `pending_audit_warning` for this company.

## 13. Key Code Snippets (Load-Bearing)

### 13.1 CDP WebSocket with pending-call map

From `cdp_helper.cjs` lines 47-71 — the canonical pattern used
throughout the codebase:

```js
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = {};
ws.on('open', () => resolve({
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++msgId;
      pending[id] = { resolve: res, reject: rej };
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { delete pending[id]; rej(new Error('Timeout')); }, 30000);
    });
  },
  close() { ws.close(); }
}));
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending[msg.id]) {
    pending[msg.id].resolve(msg);
    delete pending[msg.id];
  }
});
```

### 13.2 File-chooser interception (the most complex CDP routine)

From `cdp_helper.cjs#uploadViaFileChooser` lines 156-228 — the
full sequence for clicking a button that opens a native file picker
and intercepting it via CDP:

```js
// 1. Enable interception
await send('Page.enable');
await send('Page.setInterceptFileChooserDialog', { enabled: true });

// 2. Find button coords via Runtime.evaluate
const btnResult = await send('Runtime.evaluate', {
  expression: `(function() {
    // ... find "Upload new" button, return {x, y, found: true}
  })()`,
  returnByValue: true,
});

// 3. Listen for fileChooserOpened event
let fileChooserResolve;
const fileChooserPromise = new Promise(r => { fileChooserResolve = r; });
ws._eventHandlers = { 'Page.fileChooserOpened': fileChooserResolve };

// 4. Real mouse click — NOT JS click
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1,
});
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1,
});

// 5. Wait for the file chooser event
const fcEvent = await Promise.race([
  fileChooserPromise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('File chooser event not received within 5s')), 5000)),
]);
const backendNodeId = fcEvent.params.backendNodeId;

// 6. Set files via backendNodeId (not nodeId — different lookup)
const setResult = await send('DOM.setFileInputFiles', {
  files: absPaths,
  backendNodeId,
});

// 7. Clean up
await send('Page.setInterceptFileChooserDialog', { enabled: false });
```

### 13.3 Native fill via `Input.insertText` (VPS-wall defeat)

From `cdp_execute_plan.cjs#fillById` lines 71-83 — the path that
defeats Workday's VPS wall without MCP:

```js
async function fillById(fieldId, value) {
  const focusExpr = `(function(){
    const el = document.getElementById('${fieldId}');
    if (!el) return JSON.stringify({ok:false});
    el.focus();
    el.scrollIntoView({block:'center'});
    return JSON.stringify({ok:true, tag:el.tagName, val:el.value});
  })()`;
  const fr = await send('Runtime.evaluate', { expression: focusExpr, returnByValue: true });
  const focusResult = JSON.parse(fr.result.value);
  if (!focusResult.ok) return { fieldId, ok: false, reason: 'not found' };
  // Ctrl+A to select all
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA'
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA'
  });
  await sleep(60);
  // Native text insert — this is what React's onChange handler picks up
  await send('Input.insertText', { text: String(value) });
  await sleep(80);
  const vr = await send('Runtime.evaluate', {
    expression: `(document.getElementById('${fieldId}')||{}).value`,
    returnByValue: true,
  });
  return { fieldId, ok: true, val: vr.result.value };
}
```

### 13.4 Spinbutton fix via execCommand

From `workday_blitz.js#generateFixSpinbuttonsScript` lines 429-453:

```js
const sb = sbs[fix.index];
if (!sb) { result.errors.push({ index: fix.index, reason: 'spinbutton not found' }); continue; }
sb.focus();
sb.click();
document.execCommand('selectAll', false, null);
document.execCommand('insertText', false, String(fix.value));
const now = sb.getAttribute('aria-valuenow');
if (now === String(fix.value)) {
  result.fixed.push({ index: fix.index, value: fix.value });
} else {
  result.errors.push({ index: fix.index, reason: 'value mismatch after set', expected: fix.value, actual: now });
}
```

### 13.5 Shadow-DOM file input relocation

From `linkedin_blitz.js#generateMoveFileInputScript` lines 177-194:

```js
const shadowHost = document.querySelector('div.theme--dark');
if (!shadowHost?.shadowRoot) return JSON.stringify({ error: 'No shadow root found' });
const fileInput = shadowHost.shadowRoot.querySelector('input[type="file"]');
if (!fileInput) return JSON.stringify({ error: 'No file input in shadow DOM' });

fileInput.style.cssText = 'display:block;position:fixed;top:10px;left:10px;z-index:99999;opacity:1;';
document.body.appendChild(fileInput);

return JSON.stringify({
  action: 'moved_to_body',
  note: 'File input moved to document.body. Take a fresh snapshot to get the new UID, then use upload_file.',
  inputId: fileInput.id || '',
  inputName: fileInput.name || '',
});
```

## 14. Comparison Summary Table

### 14.1 The at-a-glance matrix

| Question | Greenhouse | Ashby | LinkedIn | Workday | SuccessFactors | Eightfold |
|---|---|---|---|---|---|---|
| Connect method | MCP / CDP WS | MCP / CDP WS | MCP / CDP WS | MCP / CDP WS | MCP / CDP WS | MCP / CDP WS |
| Fill text inputs | `setVal` + events | `setVal` + events | `setVal` + events (shadow DOM) | `Input.insertText` (native) | `setVal` + InputEvent | `setVal` + events |
| Click radios | `radio.click()` | `radio.click()` | `radio.click()` (shadow DOM) | `radio.click()` | `radio.click()` | `radio.click()` |
| Upload files | `upload_file` MCP direct | `upload_file` MCP direct | Move to body + `upload_file` | `upload_file` MCP direct | Probe-then-click + `upload_file` | **API POST** (CDP broken) |
| React controlled? | Yes — setVal works | Yes — setVal works | Yes — setVal works (shadow) | Yes — VPS wall defeats setVal | UI5 shadow DOM (different) | Yes — setVal works |
| Batch fill? | One call per page | One call total | One call per modal page | Hybrid: manifest + native fill | 4-5 calls per page | One bulk call |
| Multi-page? | No (single) | No (single) | Yes (3-4 modal pages) | Yes (5 sections) | Varies | No (single) |
| Review step? | No (Quick Apply) | No | Yes (review modal) | Yes (step 5/5) | Varies | No |
| Wall-clock est. | 10-30s | 5-15s | 60-180s | 3-10 min | 30-90s | 60-120s |
| Tier | 1 | 1 | 1 | 1 | 2 | 2 |
| Coverage | ~90% | 100% | ~70% | ~80% | Partial | Limited |

### 14.2 What ego-lite can learn from this

If ego-lite is building a parallel apply flow, the testgrounds codebase
has already solved (and documented) the following hard problems:

1. **React controlled inputs** — `setVal` with prototype-descriptor
   setter + synthetic events is the universal fix (section 3.1).
2. **Workday VPS wall** — defeat with `Input.insertText` via CDP
   (section 13.3), or MCP `fill(uid, value)` which uses the same
   path internally.
3. **Spinbutton exception** — `execCommand('selectAll')` +
   `execCommand('insertText')` is the only path that works (section 13.4).
4. **Shadow DOM file inputs** (LinkedIn) — physically move to body
   before upload (section 13.5).
5. **File-chooser interception** (Eightfold) — `Page.setInterceptFileChooserDialog`
   + `Input.dispatchMouseEvent` for real trusted clicks (section 13.2).
6. **SAP custom attachment widgets** (SuccessFactors) — probe for
   button IDs first, click to trigger native picker, then upload.
7. **Terminal button classification** — runtime guard against
   accidental submit clicks (section 7).
8. **Per-ATS combobox patterns** — type-filter-wait-click-option
   is the universal pattern; Enter does NOT commit (section 6.3).
9. **Batching** — one `evaluate_script` per section, returning a
   manifest, beats per-field calls by 10-20x (Nvidia incident
   45 min → expected 3-10 min).
10. **Per-application audit loop** — every application produces a
    learning log that's merged into `company_ats_experience.json`
    for the next agent.

### 14.3 What ego-lite probably should NOT replicate

- The MCP-preferred / CDP-fallback split — ego-lite could go
  CDP-only and avoid the dual-codepath complexity.
- The 7-phase workflow with packet critic and review gate — these
  are Aman's personal-safety guards, not CDP technical requirements.
- The `tab_orchestrator` watchdog with 2-hour timeout — useful for
  human-paced work, possibly overkill for an automated ego-lite flow.
- The `interaction_logger.mjs` JSONL telemetry — useful for training
  data, not strictly needed for a working apply flow.

## 15. Files Referenced (Absolute Paths)

### 15.1 Source files in testgrounds

- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\cdp_helper.cjs` — CLI CDP helper
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\lib\cdp_execute_plan.cjs` — CDP plan executor
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\blitz_runner.mjs` — plan generator
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\ats_dispatcher.mjs` — ATS detector + answer-bank flattener
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\greenhouse_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\ashby_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\linkedin_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\workday_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\successfactors_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\eightfold_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\google_careers_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\brassring_blitz.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\terminal_button_probe.js`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\lib\upload_helper.mjs`
- `C:\Users\M316235\repo\testgrounds\job_hunt\scripts\blitz\lib\interaction_logger.mjs`
- `C:\Users\M316235\repo\testgrounds\docs\protocols\chrome_cdp_protocol.md`
- `C:\Users\M316235\repo\testgrounds\docs\protocols\workday_field_interaction.md`
- `C:\Users\M316235\repo\testgrounds\docs\protocols\successfactors_field_interaction.md`
- `C:\Users\M316235\repo\testgrounds\.agent\workflows\apply.md`
- `C:\Users\M316235\repo\testgrounds\job_hunt\profile\company_ats_experience.json`

### 15.2 Output file (this analysis)

- `C:\Users\M316235\repo\research\ego-lite\CDP_APPLY_FLOW_ANALYSIS.md`













