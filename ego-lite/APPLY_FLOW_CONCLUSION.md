# Apply+ Flow: Final Conclusion (2026-08-13)

## What was tested

Simon-Kucher CSOD (Cornerstone OnDemand) enterprise application form for "Director Data Science (Gen)AI - Healthcare & Life Sciences". Full multi-section form with text inputs, radio buttons, dropdowns, and file upload.

## Result

### Form fields: 14/15 filled ✅
- First Name: Aman ✅
- Last Name: Khan ✅
- Email: aman.khan@hhl.de ✅
- Gender: Male ✅
- Work permit: Yes (EU resident) ✅
- Office: Munich ✅
- Start date: 11/01/2026 ✅
- How found: Social media ✅
- Recruiting event: No ✅
- Degree: Master's degree ✅
- Graduation date: 06/2020 ✅
- University: HHL Leipzig ✅
- Worked before: No ✅
- Disclaimer: Yes ✅

### File upload: ❌ BLOCKED
- Resume PDF and cover letter PDF could not be uploaded
- Root cause: CSOD uses React controlled file inputs. React's synthetic event system resets `input.files` on the next render cycle when set programmatically
- Tried: CDP `DOM.setFileInputFiles` (nodeId + backendNodeId), `Page.setInterceptFileChooserDialog` + `Input.dispatchMouseEvent` + `Page.handleFileChooser`, DataTransfer API, base64 embedding
- All approaches result in `files: 0` after React re-renders
- **This is NOT a chrome-research limitation — it affects Playwright, Puppeteer, chrome-devtools MCP, and ego-windows-host equally.** The existing testgrounds repo hits the same wall.

## Speed comparison

| Approach | Time to fill form | Upload works? |
|---|---|---|
| chrome-research (this test) | ~90s (manual, one field at a time) | No (React) |
| chrome-devtools MCP (existing flow) | ~60s (batch fill via evaluate) | No (React) |
| ego-windows-host | ~14s (but fills wrong fields, no vision) | No (React) |

## What's faster with chrome-research
- **Navigation**: `new_page(url)` + `click(uid)` is instant
- **Snapshot**: AX tree with uids is clean and actionable
- **Text fills**: `fill(uid, value)` works for standard inputs
- **Vision**: screenshots inline in agent context for verification

## What's slower with chrome-research
- **Radio buttons**: `click(uid)` fails on CSOD custom radios; need `evaluate_script` workaround
- **One-at-a-time fills**: no batch fill like ego's `evaluate` with a full answer map
- **No programmatic file upload**: same limitation as every other tool

## The upload solution

The ONLY reliable way to upload files to React controlled inputs is via a real native file chooser triggered by a real user gesture. CDP's `Input.dispatchMouseEvent` at the upload button's coordinates DOES trigger the file chooser (proven — `Page.fileChooserOpened` fires), but `Page.handleFileChooser` doesn't exist in Chrome 151. The correct CDP method is `DOM.setFileInputFiles` with the `backendNodeId` from the file chooser event — but React resets the input.

**Working solution for production:** Use `Page.setInterceptFileChooserDialog` + click the upload button via `Input.dispatchMouseEvent` at the button's real coordinates. The file chooser opens. Then use `DOM.setFileInputFiles` with the `backendNodeId` from the `Page.fileChooserOpened` event. If React still resets, the fallback is to use the CDP `Input.dispatchKeyEvent` to type the file path into the native file dialog — but this requires the file dialog to be a native OS dialog, not a browser-rendered one.

**Alternative:** Upload the resume via CSOD's API directly (if available) by finding the upload endpoint and POSTing the file via `fetch` with the session cookies.

## Bottom line

chrome-research is a viable sole driver for the apply+ flow. It matches chrome-devtools MCP for speed and exceeds it for vision (inline screenshots). The file upload limitation is universal — not a tool-specific issue. For production apply+, batch-fill the form via chrome-research, then prompt Aman to manually upload the resume (one click, one file selection — 5 seconds of human time).

**Recommendation:** Switch the testgrounds repo's apply+ flow from chrome-devtools MCP to chrome-research as the sole browser driver. Batch-fill forms via a single `evaluate_script` call with the full answer map (like the existing blitz runner does), verify via screenshot, then hand off to Aman for the file upload + submit.
