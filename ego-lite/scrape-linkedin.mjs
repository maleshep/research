// ego-windows-host script: LinkedIn "Scrape and aggregate social posts" use case
// Goal: navigate to a LinkedIn profile, extract the last 7 days of posts
// (skipping pinned/reposts/replies), return a leaderboard sorted by engagement.

const START = Date.now();
const log = (label, val) => console.log(`[${Date.now() - START}ms] ${label}:`, typeof val === 'string' ? val : JSON.stringify(val));

const TARGET_HANDLE = process.env.LINKEDIN_HANDLE || 'satyanadella';
const TARGET_TYPE = process.env.LINKEDIN_TYPE || 'in'; // 'in' for profile, 'company' for company page
const TARGET_URL = TARGET_TYPE === 'company'
  ? `https://www.linkedin.com/company/${TARGET_HANDLE}/posts/`
  : `https://www.linkedin.com/in/${TARGET_HANDLE}/recent-activity/all/`;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Parse LinkedIn's relative time strings ("1w", "2d", "5h", "30m") into ms ago
function parseRelativeTimeAgo(text) {
  const m = text.match(/(\d+)\s*(mo|w|d|h|m|s)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { mo: 30 * 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000, s: 1000 };
  return n * (mult[unit] || 0);
}

// Extract a number from text like "7,814" or "425 comments on Satya Nadella's post" -> 7814 / 425
function parseNumber(text) {
  if (!text) return 0;
  // Match the leading number (with optional commas) and a possible k/m suffix immediately after.
  const m = text.match(/^\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(num * 1000);
  if (suffix === 'm') return Math.round(num * 1_000_000);
  return Math.round(num);
}

try {
  log('script_start', `${TARGET_HANDLE} → ${TARGET_URL}`);

  // Reuse the existing Slot4 Chrome task space (it's already serving CDP on port 5192)
  await taskSpaces.useOrCreate('linkedin-scrape');

  // Open the LinkedIn activity tab
  await browser.openOrReuseTab(TARGET_URL, { wait: true });
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    return !!document.querySelector('div.feed-shared-update-v2');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500); // let engagement counters populate

  const currentUrl = await page.evaluate(() => location.href);
  log('after_navigate_url', currentUrl);

  // Verify logged in (authwall redirect means not logged in)
  if (currentUrl.includes('/authwall') || currentUrl.includes('/uas/login')) {
    throw new Error(`LinkedIn session not authenticated — page redirected to ${currentUrl}`);
  }

  // Scroll to load more posts (3 times, ~1s each)
  let lastPostCount = 0;
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const count = await page.evaluate(() => document.querySelectorAll('div.feed-shared-update-v2').length);
    log(`scroll_${i + 1}_post_count`, count);
    if (count === lastPostCount) break;
    lastPostCount = count;
  }

  // Extract post data via evaluate (per API gotcha: prefer evaluate for content extraction)
  const rawPosts = await page.evaluate(() => {
    const items = document.querySelectorAll('div.feed-shared-update-v2');
    return Array.from(items).map(item => {
      const urn = item.getAttribute('data-urn') || '';
      const subdescEl = item.querySelector('.update-components-actor__sub-description, .feed-shared-actor__sub-description');
      const timeAgoRaw = subdescEl?.textContent?.trim() || '';
      const textEl = item.querySelector('.update-components-text, .update-components-update-v2__commentary .break-words, .feed-shared-update-v2__description-wrapper');
      const text = textEl?.textContent?.trim() || '';

      // Engagement: use aria-labels for reliability
      const reactionsBtn = item.querySelector('button[aria-label*="reactions"]');
      const commentsBtn = item.querySelector('button[aria-label*="comments on"]');
      const repostsBtn = item.querySelector('button[aria-label*="reposts of"]');

      const reactionsText = reactionsBtn?.getAttribute('aria-label') || reactionsBtn?.textContent?.trim() || '';
      const commentsText = commentsBtn?.getAttribute('aria-label') || commentsBtn?.textContent?.trim() || '';
      const repostsText = repostsBtn?.getAttribute('aria-label') || repostsBtn?.textContent?.trim() || '';

      // Pinned: LinkedIn shows a small contextual badge with "Pinned" or "•" markers
      // Look for any element containing "Pinned" text within the post header
      const pinned = /pinned/i.test(item.querySelector('.update-components-actor__sub-description')?.textContent || '') ||
                     !!item.querySelector('[class*="pinned"], [data-test-id*="pinned"]');

      // Repost indicator: actor name in the post differs from the profile owner, or a "reposted" contextual marker
      // On the activity page, the post header will show "Satya Nadella reposted this" or similar.
      const actorName = item.querySelector('.update-components-actor__name, .feed-shared-actor__name')?.textContent?.trim() || '';
      const reposted = /reposted/i.test(item.textContent || '');

      // Reply indicator: activity feed items that are replies have a smaller "commented on" framing
      const replied = /commented on|replied to/i.test(item.textContent || '');

      // Post type heuristic from urn
      const postType = urn.includes(':activity:') ? 'post' :
                       urn.includes(':reshare:') ? 'reshare' :
                       urn.includes(':comment:') ? 'comment' : 'unknown';

      return {
        urn,
        text: text.slice(0, 200),
        timeAgoRaw,
        reactionsText,
        commentsText,
        repostsText,
        pinned,
        reposted,
        replied,
        postType,
        actorName,
      };
    });
  });

  log('raw_post_count', rawPosts.length);
  log('raw_post_sample', rawPosts.slice(0, 2));

  // Transform + filter on the host side (less noise in evaluate)
  const posts = rawPosts.map(p => {
    const timeAgoMs = parseRelativeTimeAgo(p.timeAgoRaw) || 0;
    const ageDays = timeAgoMs / (24 * 60 * 60 * 1000);
    const likes = parseNumber(p.reactionsText);
    const comments = parseNumber(p.commentsText);
    const reposts = parseNumber(p.repostsText);
    return {
      urn: p.urn,
      text: p.text,
      timeAgoRaw: p.timeAgoRaw,
      ageDays: Math.round(ageDays * 10) / 10,
      likes,
      comments,
      reposts,
      engagement: likes + comments + reposts,
      pinned: p.pinned,
      reposted: p.reposted || p.postType === 'reshare',
      replied: p.replied || p.postType === 'comment',
      postType: p.postType,
      actorName: p.actorName,
    };
  });

  log('transformed_post_count', posts.length);

  // Apply the use-case filters: skip pinned, reposts, replies; keep last 7 days
  const filtered = posts.filter(p => !p.pinned && !p.reposted && !p.replied && p.ageDays <= 7);
  log('after_filter_count', filtered.length);
  log('excluded_summary', {
    pinned: posts.filter(p => p.pinned).length,
    reposted: posts.filter(p => p.reposted).length,
    replied: posts.filter(p => p.replied).length,
    out_of_range: posts.filter(p => p.ageDays > 7).length,
  });

  // Sort by engagement (likes + comments + reposts) descending
  filtered.sort((a, b) => b.engagement - a.engagement);

  // Build the leaderboard
  const leaderboard = filtered.map((p, idx) => ({
    rank: idx + 1,
    textPreview: p.text.slice(0, 100),
    likes: p.likes,
    comments: p.comments,
    reposts: p.reposts,
    engagement: p.engagement,
    ageDays: p.ageDays,
    timeAgo: p.timeAgoRaw,
    urn: p.urn,
  }));

  const duration = Date.now() - START;
  console.log('\n=== USE CASE RESULT: LinkedIn social post leaderboard ===');
  console.log(`handle: ${TARGET_HANDLE}`);
  console.log(`url: ${TARGET_URL}`);
  console.log(`raw_posts_extracted: ${rawPosts.length}`);
  console.log(`excluded_pinned: ${posts.filter(p => p.pinned).length}`);
  console.log(`excluded_reposted: ${posts.filter(p => p.reposted).length}`);
  console.log(`excluded_replied: ${posts.filter(p => p.replied).length}`);
  console.log(`excluded_older_than_7d: ${posts.filter(p => p.ageDays > 7).length}`);
  console.log(`leaderboard_size: ${leaderboard.length}`);
  console.log(`duration_ms: ${duration}`);
  console.log(`\n--- LEADERBOARD (sorted by engagement desc) ---`);
  console.log(JSON.stringify(leaderboard, null, 2));
  console.log(`\n--- END ---`);
} catch (e) {
  const duration = Date.now() - START;
  console.log(`\n=== USE CASE RESULT ===`);
  console.log(`pass: false`);
  console.log(`duration_ms: ${duration}`);
  console.log(`error: ${e && e.message ? e.message : String(e)}`);
  console.log(`stack: ${e && e.stack ? e.stack : 'n/a'}`);
}
