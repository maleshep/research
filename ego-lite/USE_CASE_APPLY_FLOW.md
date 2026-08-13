# Apply+ Flow Test: Simon-Kucher CSOD Application (2026-08-13)

## Goal

Test whether ego-lite's apply+ flow (form filling on a real enterprise ATS) works better on our Windows setup (chrome-research as sole driver) vs the existing chrome-devtools MCP flow.

## Role

- **Company:** Simon-Kucher
- **Title:** Director Data Science (Gen)AI - Healthcare & Life Sciences (m/f/d)
- **Location:** Berlin | Munich
- **ATS:** CSOD (Cornerstone OnDemand)
- **URL:** https://simon-kucher.csod.com/ux/ats/careersite/6/home/requisition/4220

## What was done (chrome-research only — no ego)

1. **Navigated** to LinkedIn job posting (page 121)
2. **Snapshot** found "Apply on company website" link (uid=5_54) → clicked it
3. **CSOD portal** opened in new tab (page 122) — job description page
4. **Clicked "Apply Now"** (uid=6_74) → application form loaded
5. **wait_for** detected form fields appearing
6. **Filled text inputs** via `fill(uid, value)`:
   - First Name: Aman (uid=7_8)
   - Last Name: Khan (uid=7_11)
   - Email: aman.khan@hhl.de (uid=7_14)
   - Office: Munich (uid=7_32)
   - Start date: 11/01/2026 (uid=7_36)
   - Graduation date: 06/2020 (uid=7_71)
   - University: HHL Leipzig Graduate School of Management (uid=7_73)
7. **Radio buttons** — `click(uid)` failed (CSOD custom radios not interactive via accessibility click). Used `evaluate_script` to click via DOM:
   - Gender: Male
   - Work permit: Yes (EU resident)
   - How found: Social media
   - Recruiting event: No
   - Degree: Master's degree
   - Worked before: No
8. **Screenshot** verified all fields filled correctly
9. **Found Submit button** — did NOT click it (review gate: never auto-submit)

## Result: PASS

Form fully filled, ready for Aman's review. Submit button found but not clicked.

## Comparison: chrome-research vs chrome-devtools MCP vs ego-windows-host

| Aspect | chrome-devtools MCP (existing) | chrome-research (this test) | ego-windows-host |
|---|---|---|---|
| **Navigation** | `navigate_page(uid, url)` | `navigate_page(pageId, url)` or `new_page(url)` | `browser.openOrReuseTab(url)` — creates new tabs, can cause tab bloat |
| **Snapshot** | `take_snapshot` — same AX tree | `take_snapshot` — same AX tree, uid-based | `page.snapshot()` — returns text string, no uids |
| **Form fill** | `fill(uid, value)` — works for standard inputs | `fill(uid, value)` — works for standard inputs | `page.locator().fill()` — fails on React/CSOD forms; need `evaluate` workaround |
| **Radio clicks** | `click(uid)` — sometimes fails on custom radios | `click(uid)` — failed on CSOD radios; `evaluate_script` worked | `page.evaluate()` — works but no uid system |
| **Vision** | `take_screenshot` — inline in agent context | `take_screenshot` — inline in agent context | `page.screenshot()` — returns file path, NOT inline |
| **Tab management** | One slot, one tab at a time | Multiple tabs, `list_pages` to manage | Task spaces create new tabs, can bloat to 30+ |
| **Stability** | Stable, no crashes | Crashes under 15+ tabs (memory) | Crashes when ego launches its own Edge/Chrome |
| **Speed** | Fast — direct CDP | Fast — direct CDP | Slower — extra CDP hop through ego bridge |
| **Login state** | Uses Slot4 profile (LinkedIn logged in) | Uses Slot4 profile (LinkedIn logged in) | Uses ego profile (not logged in) unless EGO_HOST_DEBUG_PORT=5192 |

## Key finding

**chrome-research alone is the best driver for apply+ flow.** It combines:
- Inline vision (screenshots in agent context)
- AX tree snapshots with uid-based element targeting
- Direct CDP fill/click/evaluate
- Slot4 profile (LinkedIn + other logins persist)
- No extra abstraction layer (ego bridge adds overhead and tab bloat)

**ego-windows-host adds value for:**
- Parallel task spaces (when you need multiple agents on different sites simultaneously)
- The `taskSpaces` API for programmatic tab lifecycle management
- The cursor/status visual hooks (now patched in)

**But for sequential form-filling (the apply+ flow), chrome-research alone is faster, simpler, and more stable.**

## Gotchas hit

1. **CSOD radio buttons not clickable via accessibility `click(uid)`** — CSOD renders radios as custom ARIA widgets. Workaround: `evaluate_script` to find and `.click()` the underlying `input[type="radio"]` or `[role="radio"]` by label text.

2. **Radio label text matching is tricky** — "No" matches "Non-binary" (contains "No"). Must use exact text match (`text === 'No'`), not `.includes()`.

3. **Master's degree has a curly apostrophe** — `'` (U+2019) not `'` (U+0027). Must match the exact character or try both variants.

4. **LinkedIn "Easy Apply" button is NOT a button** — it's text inside a `<p>` inside a `<div>`. The AX tree shows it as "StaticText". Must use TreeWalker to find the text node and click its grandparent container.

5. **LinkedIn "Apply on company website" opens a new tab** — the CSOD portal opens in a new tab, not the same one. Must `list_pages` and `select_page` to follow it.

## Recommendation

For the testgrounds repo's apply+ flow: **use chrome-research as the sole browser driver.** It's faster, more stable, has vision inline, and uses the Slot4 profile with all logins. ego-windows-host should be reserved for parallel multi-agent scenarios where task spaces matter.
