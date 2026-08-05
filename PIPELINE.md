# Pipeline — How the Research Hub Stays Fresh

This repo is generated. The `README.md`, `data/posts.json`, `data/posts-github.json`,
and `data/snapshot.txt` are all artifacts of running the scripts below.

## Order of operations

```
1. take_snapshot                  data/snapshot.txt
2. scripts/parse-snapshot.mjs     data/posts.json          (author names, timestamps, lnkd.in links)
3. scripts/scrape-github-comments.mjs   data/posts-github.json  (direct github.com URLs from comments)
4. python build_readme.py         README.md
```

`scripts/enrich-github.mjs` is an optional step between 2 and 3 that tries to
resolve lnkd.in redirects to GitHub. As of 2026-06 most lnkd.in links are dead
within ~24 hours of posting, so this step yields very little — it's kept around
for the rare still-live case. Run with `NODE_TLS_REJECT_UNAUTHORIZED=0` because
the corporate proxy uses a self-signed CA.

## Per-step details

### 1. Snapshot
Open Chrome Slot4 on port 5192 (see `SETUP-CHROME.md`), navigate to
`https://www.linkedin.com/my-items/saved-posts/?savedPostType=ALL`, then click
"Show more results" until the button is gone. With the chrome-research MCP:

```js
// Click Show more until it's gone, then take snapshot
for (let i = 0; i < 50; i++) {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Show more results'));
  if (!btn) break;
  btn.click();
  await new Promise(r => setTimeout(r, 2000));
}
```

Then call `mcp__chrome-research__take_snapshot` → `data/snapshot.txt`.

### 2. Parse snapshot → JSON
`scripts/parse-snapshot.mjs` reads `data/snapshot.txt` and walks the a11y tree.
It correctly identifies the *name* author link (not the avatar link, which
shows "Status is offline") and extracts timestamps like `19h`, `1d`, `2w`.

Output: `data/posts.json` — array of `{activityId, authorName, timestamp, text, postUrl, externalLinks, linkInComments}`.

### 3. Scrape GitHub repos from comments
For each post flagged `linkInComments=true` (~79 of ~387 at last run), open
the post in an isolated tab, scroll to load comments, extract direct
github.com URLs.

`scripts/scrape-github-comments.mjs` connects to Chrome via DevTools Protocol
and processes sequentially in one tab. Takes ~10 minutes for 79 posts.

Output: `data/posts-github.json` — adds `githubRepos: [{url, via}]` per post.

**Why comments and not lnkd.in?** LinkedIn wraps every shared link in
`lnkd.in/{8chars}` which expires in ~24 hours. The GitHub repos people share
live in the comments as direct `github.com/{owner}/{repo}` URLs which are
stable. Resolving lnkd.in at scrape time gives you a snapshot that rots by
tomorrow; clicking into the post and reading comments gives you the durable
record.

### 4. Render README
`python build_readme.py` reads `data/posts-github.json` if present (falls back
to `data/posts.json`), categorizes posts by keyword rules, and emits
`README.md` with a 🐙 badge for each GitHub repo found.

## Re-running end-to-end

```bash
# 1. Open Chrome Slot4 (manual)
pwsh scripts/launch-research.ps1

# 2. Load all posts in the browser, take snapshot (manual via MCP or chrome-research tools)
#    In chrome-research, take_snapshot → data/snapshot.txt
#    To load all posts: evaluate_script with a "Show more results" click loop.
#    IMPORTANT: cap the loop at ~15 iterations per call — DevTools protocol
#    times out around 120s. Verify with a follow-up call that checks
#    buttonStillThere and postCount.

# 3. From the repo root:
node scripts/parse-snapshot.mjs
node scripts/scrape-github-comments.mjs   # ~10 min for ~80 candidates
python build_readme.py
```

## Recovery after Windows reimage

If `chrome-research` can't connect or shows a LinkedIn login page despite
previously working, the Slot4 user-data-dir at
`C:\Users\M316235\AppData\Local\Google\Chrome\Slot4` may have been wiped.
Symptoms on 2026-08-05 (post-reimage): DevTools port responds, but LinkedIn
redirects to `/login`. Fix: re-run `scripts/launch-research.ps1` (creates a
fresh Slot4 profile), sign into LinkedIn manually, then proceed with the
pipeline. See SETUP-CHROME.md for the one-time setup checklist.

## Insights

After a sync, run the analysis in `INSIGHTS.md` (top authors, vibe-shift
keyword comparison between recent ≤1mo and older posts, recency distribution,
delta vs prior sync). Regenerate by re-running the keyword analysis against
the fresh `data/posts-github.json`.

## Files in this repo

| Path | Purpose | Generated? |
|---|---|---|
| `README.md` | The curated index | ✅ yes |
| `courses.md` | Saved LinkedIn Learning courses | manual |
| `PIPELINE.md` | This file | manual |
| `SETUP-CHROME.md` | Chrome Slot4 setup | manual |
| `build_readme.py` | Renderer | manual |
| `scripts/parse-snapshot.mjs` | Snapshot → JSON | manual |
| `scripts/scrape-github-comments.mjs` | Comment scraper | manual |
| `scripts/enrich-github.mjs` | Optional lnkd.in resolver | manual |
| `scripts/launch-research.ps1` | Chrome launcher | manual |
| `data/snapshot.txt` | Raw a11y tree | ✅ yes |
| `data/posts.json` | Parsed posts | ✅ yes |
| `data/posts-github.json` | Posts + GitHub repos | ✅ yes |
| `data/.gh-cache.json` | lnkd.in resolution cache | ✅ yes, throwaway |
