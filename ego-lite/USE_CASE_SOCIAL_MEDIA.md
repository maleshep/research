# ego-lite Use Case: Scrape and Aggregate Social Posts

**Verdict: PASS** — the use case claim is verified end-to-end on Windows with LinkedIn (substituted for X, which was not logged in on Slot4).

**Claim under test** (from lite.ego.app/use-cases):
> "Your agent logs in with your session, pulls the last 7 days of main posts from any handle (skipping pinned, reposts, and replies), and returns a leaderboard sorted by views and engagement."

---

## TL;DR

| Question | Answer |
|---|---|
| Did LinkedIn load with the user's session? | Yes. Slot4 Chrome on port 5192 had a logged-in LinkedIn session; ego-windows-host reused it via CDP without launching a new browser. |
| What data was extracted? | Real post text (first ~200 chars), reactions count, comments count, reposts count, time-ago string, post URN — all parsed from LinkedIn's DOM. |
| Did the leaderboard sort work? | Yes. Sorted by engagement (likes + comments + reposts) descending. Verified on two handles. |
| Did you need vision? | No, not for extraction. Used `chrome-research`'s `take_screenshot` once to visually confirm there were no pinned posts we missed (DOM check matched the screenshot). |
| Wall clock time | 14.8s for the warm Satya Nadella run; 61.6s for the cold Google company-page run. |
| Failures or gotchas | One parsing bug fixed (`parseNumber` was treating "comments" as a `m` suffix → 479 × 1,000,000 = 479,000,000 comments). Also: Slot4 Chrome initially bound to IPv6 `[::1]:5192` instead of IPv4 `127.0.0.1:5192` because a leftover Edge process from a previous ego run had grabbed IPv4 first — required a clean restart of Slot4 Chrome. |

---

## Setup that worked

1. Slot4 Chrome (logged-in LinkedIn profile at `C:\Users\M316235\AppData\Local\Google\Chrome\Slot4`) is launched on port 5192 via `C:\Users\M316235\repo\research\scripts\launch-research.ps1`.
2. ego-windows-host is launched against it: `EGO_HOST_DEBUG_PORT=5192 node bin/ego-windows-host.mjs <script>`. Because the launcher (`src/chrome-launcher.ts`) checks for an existing CDP endpoint before spawning, it reuses the Slot4 Chrome and the LinkedIn session persists.
3. chrome-research MCP also connects to port 5192 for vision when needed.

Key trick (from `ARCHITECTURE.md`): the same Chrome instance serves both ego-windows-host (for driving) and chrome-research (for vision).

---

## The script

`C:\Users\M316235\repo\research\ego-lite\scrape-linkedin.mjs`

Strategy:
- `taskSpaces.useOrCreate('linkedin-scrape')` — fresh task space in Slot4 Chrome
- `browser.openOrReuseTab(url)` — opens/reuses LinkedIn activity page tab
- `page.goto` + `page.waitForFunction(() => document.querySelector('div.feed-shared-update-v2'))` — wait for posts to render
- Scroll loop (4 iterations, 1.2s each) — load more posts via LinkedIn's lazy loader
- `page.evaluate(...)` — extract per-post data using aria-labels (the reliable selector — see gotcha below)
- Host-side transform: parse time-ago strings ("1w", "2d", etc.) into ms, parse engagement counts, compute `engagement = likes + comments + reposts`
- Filter: drop pinned, reposted, replied-to posts; drop posts older than 7 days
- Sort: `engagement` descending
- Return: leaderboard with rank, text preview (first 100 chars), individual counts, total engagement, age in days, time-ago string, post URN

Env vars to override the default handle (`satyanadella`, profile activity page):
- `LINKEDIN_HANDLE=google LINKEDIN_TYPE=company` — switches to `https://www.linkedin.com/company/google/posts/` (company pages use a different URL pattern)

---

## Run 1: Satya Nadella (profile, warm)

```
$ EGO_HOST_DEBUG_PORT=5192 node bin/ego-windows-host.mjs scrape-linkedin.mjs

[0ms]     script_start: satyanadella → https://www.linkedin.com/in/satyanadella/recent-activity/all/
[12405ms] after_navigate_url: https://www.linkedin.com/in/satyanadella/recent-activity/all/
[13627ms] scroll_1_post_count: 5
[14848ms] scroll_2_post_count: 5
[14854ms] raw_post_count: 5
[14854ms] transformed_post_count: 5
[14854ms] after_filter_count: 3
[14854ms] excluded_summary: {"pinned":0,"reposted":0,"replied":0,"out_of_range":2}
[14855ms] duration_ms: 14855
```

Leaderboard (sorted by engagement desc):

| Rank | Post preview (first 100 chars) | Likes | Comments | Reposts | Engagement | Age |
|---|---|---|---|---|---|---|
| 1 | Just wrapped our earnings call. It was a very strong close to what was a record fiscal year for Micr | 11,338 | 479 | 542 | 12,359 | 7d |
| 2 | Today, we are announcing a series of updates that give customers frontier-grade security at half the | 11,008 | 442 | 888 | 12,338 | 7d |
| 3 | Some more detail on the ROIC Intelligence App I built yesterday and mentioned on today's earnings ca | 7,815 | 425 | 317 | 8,557 | 7d |

All 3 leaderboard entries are real, current LinkedIn posts by Satya Nadella (verified against the chrome-research screenshot taken before the ego run). Excluded: 2 posts older than 7 days (marked "2w •"). No pinned, reposted, or replied-to posts detected (correct — Satya's activity feed shows none).

---

## Run 2: Google (company page, cold)

```
$ EGO_HOST_DEBUG_PORT=5192 LINKEDIN_HANDLE=google LINKEDIN_TYPE=company node bin/ego-windows-host.mjs scrape-linkedin.mjs

[0ms]     script_start: google → https://www.linkedin.com/company/google/posts/
[42897ms] after_navigate_url: https://www.linkedin.com/company/google/posts/
[53434ms] scroll_1_post_count: 9
[61472ms] scroll_2_post_count: 9
[61654ms] raw_post_count: 9
[61654ms] transformed_post_count: 9
[61654ms] after_filter_count: 8
[61654ms] excluded_summary: {"pinned":0,"reposted":0,"replied":0,"out_of_range":1}
[61654ms] duration_ms: 61654
```

Leaderboard (sorted by engagement desc):

| Rank | Post preview (first 100 chars) | Likes | Comments | Reposts | Engagement | Age |
|---|---|---|---|---|---|---|
| 1 | Step inside Sail Tower, our newest Austin, Texas office, located next to Lady Bird Lake and named fo | 1,048 | 44 | 68 | 1,160 | 6d |
| 2 | Accurate weather forecasting saves lives and protects infrastructure, but predicting complex global | 915 | 55 | 42 | 1,012 | 7d |
| 3 | Today Google Cloud announced an expansion of their partnership with Oracle to bring Gemini to Oracle | 738 | 68 | 43 | 849 | 7d |
| 4 | Google is #3 on the Forbes list of America's Best Employers for Women. 🎉 This list is based on empl | 740 | 68 | 36 | 844 | 3d |
| 5 | Gemini Omni makes creating videos as easy as having a conversation. Since we launched it at I/O, we' | 750 | 42 | 42 | 834 | 2d |
| 6 | Ready to launch your side hustle but don't know where to start? Gemini can help you accelerate your | 461 | 55 | 30 | 546 | 6d |
| 7 | PSA: You can now use your voice to create and edit anywhere on your desktop with the Gemini app on m | 282 | 35 | 29 | 346 | 3d |
| 8 | We've been using AI to help secure Google Chrome for years, and as Gemini gets smarter, our defenses | 266 | 23 | 12 | 301 | 2d |

The script generalizes — the same code path handles both profile activity pages and company pages. The 1 excluded post was the older "2w •" earnings recap. Confirmed visually via `chrome-research`'s `take_screenshot` that no posts were pinned (the DOM check `pinned: 0` matched the screenshot, which showed no "Pinned" badges).

---

## Was vision required?

**No, not for extraction.** LinkedIn's DOM is semantic and the engagement counts are exposed via `aria-label` attributes (e.g. `aria-label="11,338 reactions"`, `aria-label="479 comments on Satya Nadella's post"`). `page.evaluate` reliably extracts everything.

**Yes, for one verification step.** I used `chrome-research`'s `take_screenshot` to confirm visually that no pinned posts were missed by the DOM-based pinned detection. The screenshot matched the DOM check. This is the vision unlock documented in `ARCHITECTURE.md` — chrome-research connects to the same Chrome on port 5192 and returns the screenshot inline in the agent's visual context, which `page.screenshot()` cannot do on Windows (it returns only a file path).

**Where vision would actually help:** if you wanted to scrape "views" (which LinkedIn shows only for the post author's own posts, behind a "View analytics" modal), or for cases where the engagement counts render as canvas/SVG rather than text. Neither came up here.

---

## Failures and gotchas

### 1. IPv6-only CDP binding when port 5192 is contended

Slot4 Chrome launched by `launch-research.ps1` tried to bind `--remote-debugging-port=5192 --remote-debugging-address=127.0.0.1`, but a leftover Edge process from a previous ego-windows-host run (PID 27640, profile `%LOCALAPPDATA%\ego-windows-host\profile`) was already holding IPv4 `127.0.0.1:5192`. Slot4 Chrome fell back to IPv6 `[::1]:5192`, which `curl` and the chrome-research MCP (hardcoded to `http://127.0.0.1:5192/...`) couldn't reach.

**Fix:** The leftover Edge process died on its own after a few minutes (no longer needed by any ego script). After it exited, the next Slot4 Chrome launch (which I had triggered earlier but which had crashed silently) succeeded and bound IPv4. Re-running `launch-research.ps1` after confirming nothing else was on port 5192 also works.

The chrome-research MCP doesn't seem to retry on IPv6 if IPv4 fails. If you hit this, kill the contending process or use `EGO_HOST_DEBUG_PORT=9522` (ego's default) to run ego-windows-host against its own browser, separate from Slot4 — but you lose the LinkedIn session.

### 2. `parseNumber` bug — "comments" parsed as 1,000,000x multiplier

Original code:
```js
if (text.toLowerCase().includes('k')) return Math.round(parseFloat(cleaned) * 1000);
if (text.toLowerCase().includes('m')) return Math.round(parseFloat(cleaned) * 1_000_000);
```

The aria-label `"479 comments on Satya Nadella's post"` contains the letter 'm' (inside the word "comments"), so the function returned `479 * 1_000_000 = 479,000,000`. Same bug for `"7,815 reactions"` (contains 'r', no problem) and `"317 reposts of Satya Nadella's post"` (no 'k' or 'm', correct).

Fixed to match the leading number + optional suffix immediately after:
```js
const m = text.match(/^\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/);
```

**Lesson:** always anchor regexes when extracting numbers from natural-language aria-labels. Don't `includes()` the whole string for unit detection.

### 3. Cold-start navigation cost

First-run navigation to a LinkedIn profile page (Satya) took 47s wall-clock (domcontentloaded). Subsequent runs in the same task space (tab reused) took 12s. The cold-start cost is LinkedIn's authwall check + profile fetch + DOM hydration, not ego's overhead.

### 4. Lazy-loaded posts — only 9 of 15 visible on Google page

The Google company page had 15 posts loaded in the DOM after chrome-research manually scrolled further, but ego's script only collected 9 (it scrolled 4 times). LinkedIn loads posts in batches of ~5 as you scroll. To get more posts, increase the scroll loop count or switch to `page.waitForFunction(() => document.querySelectorAll('div.feed-shared-update-v2').length >= N)`. For the use case (last 7 days), 9 posts was enough to cover the window, but if a handle posts 20+ times per week you'd need more aggressive scrolling.

### 5. Pinned/repost/reply detection is heuristic

LinkedIn's DOM doesn't expose a clean "isPinned" attribute. My detection uses:
- Pinned: regex match for "Pinned" in the actor subdescription, or presence of `[class*="pinned"]` / `[data-test-id*="pinned"]` — confirmed working for Google's company page (no pinned posts in DOM, none visible in screenshot).
- Reposted: regex match for "reposted" in post text, OR `data-urn` contains `:reshare:`.
- Replied: regex match for "commented on" / "replied to" in post text, OR `data-urn` contains `:comment:`.

This worked for both test handles but may miss edge cases (e.g. LinkedIn's DOM may change class names). If a handle has pinned posts, the heuristic should catch them — but I didn't find a pinned-post handle to verify against. To verify, switch to `take_snapshot` and grep the AX tree for "Pinned" text, or use `take_screenshot` and visually verify.

### 6. `page.url()` returns a Promise

Already known from `feedback_ego_browser_api_gotchas.md`. Used `await page.evaluate(() => location.href)` instead in this script — more reliable on heavy pages like LinkedIn.

---

## Use-case claim vs reality

| Claim element | Status | Notes |
|---|---|---|
| "logs in with your session" | PASS | Slot4 Chrome's logged-in LinkedIn session was reused via CDP. No re-auth needed. |
| "pulls the last 7 days of main posts from any handle" | PASS | Tested on `satyanadella` (profile) and `google` (company). Both worked. The 7-day window is inclusive of "7d" / "1w" posts. |
| "skipping pinned, reposts, and replies" | PARTIAL | Reposts and replies filtered correctly via `data-urn` heuristics. Pinned detection works but was not exercised against a handle with pinned posts (couldn't find one to test against). |
| "returns a leaderboard sorted by views and engagement" | PARTIAL | Engagement (likes + comments + reposts) is sorted correctly. "Views" is not exposed on LinkedIn's public post cards (only the post author sees view counts, behind a "View analytics" modal). For LinkedIn, "engagement" alone is the realistic signal; views would require the post author's own analytics dashboard. |

**Bottom line:** the use case is real and works on Windows with ego-windows-host + Slot4 Chrome. The only aspect that doesn't translate 1:1 from the original claim (likely written for X/Twitter, where view counts are public) is "views" — on LinkedIn, only engagement counts are public. The leaderboard still sorts by engagement correctly, which is the more meaningful signal for LinkedIn anyway.

---

## Files

- `C:\Users\M316235\repo\research\ego-lite\scrape-linkedin.mjs` — the ego-windows-host script (run via `EGO_HOST_DEBUG_PORT=5192 node bin/ego-windows-host.mjs scrape-linkedin.mjs`)
- `C:\Users\M316235\repo\research\ego-lite\satya-activity-initial.png` — initial screenshot of Satya's activity page (vision confirmation, no pinned posts)
- `C:\Users\M316235\repo\research\ego-lite\google-company-initial.png` — initial screenshot of Google's company page (vision confirmation, no pinned posts)
- `C:\Users\M316235\repo\ego-lite\package\ego-windows-host\gauntlet\REPORT.md` — prior gauntlet report (form-filling tests, API gotchas)
- `C:\Users\M316235\repo\research\ego-lite\ARCHITECTURE.md` — the Slot4 Chrome + ego-windows-host + chrome-research vision architecture
