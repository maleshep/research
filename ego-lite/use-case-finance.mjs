// ego-lite use case: Track your stocks in one pass
// Yahoo Finance quote page structure (verified 2026-08-10):
//   - Price + daily change: <section data-testid="quote-price"> text = "306.64 -6.42 (-2.05%) As of..."
//   - 1-month return: <section data-testid="chart-container"> range bar text contains "1M  -2.72%"
//   - Market cap: <li> containing <p class="label">Market Cap</p> with value sibling

const start = Date.now();
const log = (label, val) => console.log(`[${Date.now()-start}ms] ${label}:`, typeof val === 'string' ? val : JSON.stringify(val));

const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];

// Yahoo may show a consent wall — try to dismiss it via any button/iframe
async function handleConsent() {
  try {
    const clicked = await page.evaluate(() => {
      // Main doc first
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const accept = buttons.find(b => {
        const t = (b.textContent || '').trim();
        return /^(Accept all|I agree|Agree|Accept|Got it|OK)$/i.test(t) && t.length < 30;
      });
      if (accept) { accept.click(); return 'main:' + accept.textContent.trim(); }
      return null;
    });
    if (clicked) {
      log('consent handled', clicked);
      await page.waitForTimeout(1500);
    }
  } catch (e) { log('consent skip', String(e).slice(0, 120)); }
}

// Wait for the quote-price section to render with a numeric price
async function waitForQuoteHeader(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const sec = document.querySelector('section[data-testid="quote-price"]');
      if (!sec) return false;
      const t = sec.textContent || '';
      return /[0-9]+\.[0-9]+\s+[+-]?[0-9]/.test(t);
    });
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Per-stock extraction — single page load captures price, daily change, 1M return, market cap
async function extractStockData(ticker) {
  const url = `https://finance.yahoo.com/quote/${ticker}/`;
  log(`${ticker} navigating`, url);

  await browser.openOrReuseTab(url);
  // Use 'commit' waitUntil — returns as soon as navigation commits, then we poll for the
  // quote-price section to render with numeric content. Yahoo's heavy pages often don't
  // reach 'domcontentloaded' inside 30s under CDP, so 'commit' + a content check is more robust.
  let navOk = false;
  let navErr = null;
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    navOk = true;
  } catch (e) {
    navErr = String(e).slice(0, 120);
    log(`${ticker} goto commit error`, navErr);
    // The navigation likely succeeded in the browser but the CDP call timed out.
    // The page is still loading — wait for the content instead.
  }
  // Wait for the quote-price section to render with a numeric price
  const ready = await waitForQuoteHeader(20000);
  log(`${ticker} quote header ready`, { ready, navOk, navErr });
  if (!ready) {
    // Try consent then re-wait
    await handleConsent();
    await page.waitForTimeout(1500);
    const ready2 = await waitForQuoteHeader(10000);
    log(`${ticker} quote header ready (post-consent)`, ready2);
  }

  const data = await page.evaluate(() => {
    const out = { price: null, dailyChange: null, dailyChangePct: null, oneMonthReturnPct: null, marketCap: null };

    // 1) Price + daily change
    const priceSection = document.querySelector('section[data-testid="quote-price"]');
    const priceText = priceSection?.textContent || '';
    const priceMatch = priceText.match(/([0-9]+(?:\.[0-9]+)?)\s+([+-]?[0-9]+(?:\.[0-9]+)?)\s*\(([+-]?[0-9]+(?:\.[0-9]+)?)%\)/);
    if (priceMatch) {
      out.price = priceMatch[1];
      out.dailyChange = priceMatch[2];
      out.dailyChangePct = priceMatch[3];
    }

    // 2) 1-month return from chart-container range bar
    const chartContainer = document.querySelector('section[data-testid="chart-container"]');
    const chartText = chartContainer?.textContent || '';
    const oneMMatch = chartText.match(/1M\s+([+-]?[0-9]+(?:\.[0-9]+)?)%/);
    if (oneMMatch) out.oneMonthReturnPct = oneMMatch[1];

    // 3) Market cap — walk all <li> elements looking for "Market Cap" label
    const lis = Array.from(document.querySelectorAll('li'));
    for (const li of lis) {
      const label = li.querySelector('p.label, span.labelText, span:first-child');
      if (label && /market cap/i.test(label.textContent || '')) {
        // Value is in a sibling — could be a fin-streamer, span.value, or strong
        const valEl = li.querySelector('fin-streamer, .value, span.value, strong, [data-field]') ||
                      li.querySelectorAll('span, p')[1];
        if (valEl) {
          out.marketCap = valEl.textContent.trim();
          break;
        } else {
          // Parse from full li text
          const fullText = li.textContent.trim();
          const m = fullText.match(/market cap\s*\(?\w*\)?\s*[:\-]?\s*(.+)/i);
          if (m) { out.marketCap = m[1].trim(); break; }
        }
      }
    }

    out.url = location.href;
    out.title = document.title;
    return out;
  });

  log(`${ticker} extracted`, data);
  return data;
}

function parseMarketCap(s) {
  if (!s) return null;
  const m = String(s).match(/([0-9]+(?:\.[0-9]+)?)\s*([TBMK]?)/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'T') v *= 1e12;
  else if (unit === 'B') v *= 1e9;
  else if (unit === 'M') v *= 1e6;
  else if (unit === 'K') v *= 1e3;
  return v;
}

function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/-?[0-9]+(?:\.[0-9]+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/^-/.test(String(s).trim())) v = -Math.abs(v);
  return v;
}

// === MAIN ===
const results = [];
for (const t of TICKERS) {
  try {
    const r = await extractStockData(t);
    results.push({ ticker: t, ...r });
  } catch (e) {
    log(`${t} error`, String(e).slice(0, 300));
    results.push({ ticker: t, error: String(e).slice(0, 300) });
  }
}

// === CALCULATIONS ===
const enriched = results.map(r => ({
  ticker: r.ticker,
  price: r.price,
  dailyChangePct: parseNum(r.dailyChangePct),
  marketCapStr: r.marketCap,
  marketCapUsd: parseMarketCap(r.marketCap),
  oneMonthReturnPct: parseNum(r.oneMonthReturnPct),
  url: r.url,
  error: r.error,
}));

const valid = enriched.filter(r => r.dailyChangePct != null && r.marketCapUsd != null);
const allLoaded = valid.length === TICKERS.length;

let biggestGainer = null, biggestLoser = null;
if (valid.length > 0) {
  biggestGainer = valid.reduce((a, b) => (a.dailyChangePct > b.dailyChangePct ? a : b));
  biggestLoser = valid.reduce((a, b) => (a.dailyChangePct < b.dailyChangePct ? a : b));
}

let mcapWeightedDailyChange = null;
if (valid.length > 0) {
  const num = valid.reduce((sum, r) => sum + (r.marketCapUsd * r.dailyChangePct), 0);
  const den = valid.reduce((sum, r) => sum + r.marketCapUsd, 0);
  if (den > 0) mcapWeightedDailyChange = num / den;
}

const duration = Date.now() - start;
console.log(`\n=== USE CASE: STOCKS IN ONE PASS — RESULT ===`);
console.log(`pass: ${allLoaded ? 'true' : 'partial'}`);
console.log(`stocks_loaded: ${valid.length}/${TICKERS.length}`);
console.log(`duration_ms: ${duration}`);
console.log(`\n--- EXTRACTED DATA ---`);
for (const r of enriched) {
  console.log(`${r.ticker}: price=${r.price}, dailyChangePct=${r.dailyChangePct}, marketCap=${r.marketCapStr} (${r.marketCapUsd}), 1moReturnPct=${r.oneMonthReturnPct}`);
}
console.log(`\n--- CALCULATIONS ---`);
console.log(`biggest_gainer: ${biggestGainer ? biggestGainer.ticker + ' (' + biggestGainer.dailyChangePct + '%)' : 'n/a'}`);
console.log(`biggest_loser: ${biggestLoser ? biggestLoser.ticker + ' (' + biggestLoser.dailyChangePct + '%)' : 'n/a'}`);
console.log(`market_cap_weighted_daily_change_pct: ${mcapWeightedDailyChange !== null ? mcapWeightedDailyChange.toFixed(4) : 'n/a'}`);
