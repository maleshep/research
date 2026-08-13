# Flight Search Use Case: Proven on Windows (2026-08-10)

## Goal

Replicate ego-lite's "Search and quote flight bookings" use case on Windows, with vision-in-the-loop.

## Route

Munich (MUC) → New York (NYC), round trip, Aug 24 - Aug 31, 2026.

## What was done

1. **ego-windows-host** opened Google Flights on Slot4 Chrome (port 5192)
2. **ego evaluate** filled the "Where from?" input with "Munich" → typed character-by-character → clicked autocomplete suggestion "Munich, Germany (MUC)"
3. **ego evaluate** filled "Where to?" with "New York" → clicked "New York, USA (NYC)"
4. **ego evaluate** opened the departure date picker → clicked Aug 24, 2026 → clicked Aug 31, 2026 → clicked "Done"
5. **ego evaluate** clicked "Search" button
6. **ego evaluate** and **page.snapshot()** both returned 0 flight results — Google Flights renders results in a way invisible to DOM and AX tree
7. **chrome-research take_screenshot** showed the full results page inline in the agent's visual context

## Results (read via vision)

### Cheapest nonstop: €683
- **Lufthansa LH 400** / United UA 8846 (codeshare)
- Departs Munich 10:25 AM → arrives New York 1:35 PM
- Duration: 9h 10m
- Nonstop

### Cheapest overall (1 stop): €539
- **Air France** (via Paris CDG)
- Departs Munich 6:00 AM
- Duration: 13h 15m
- 1 stop

### Other options seen
- Lufthansa LH 404: 12:15 PM → 3:30 PM, Nonstop, 9h 15m, €703
- KLM/Lufthansa (via Amsterdam): 1 stop, €548
- Multiple 1-stop options through European hubs (€539-€600 range)

## Key insight

**Google Flights is a vision-required page.** Neither `page.evaluate()` nor `page.snapshot()` could extract flight prices, airlines, or times. The results are rendered in a complex structure (likely shadow DOM or canvas) that's invisible to both DOM queries and the accessibility tree. The ONLY way to read the results was via `chrome-research.take_screenshot()` — which returns the image inline in the agent's visual context.

This validates the ego-browser skill's prescription (SKILL.md line 179): "Visual: screenshot + mouse/keyboard. Use for canvas, virtualized editors, spreadsheets, maps, and AX-poor surfaces."

## Wall clock

~45 seconds total (form fill + autocomplete + date selection + search + screenshot read)

## Failures / gotchas

1. **URL-based navigation loses search state**: Navigating directly to a Google Flights URL with search params (`tfs=...`) loads the form, not results. Must interactively fill the form and click Search.
2. **DOM extraction returns 0 results**: Google Flights doesn't expose flight cards via standard DOM selectors. No `li[role=listitem]`, no price text in divs. Shadow DOM or custom rendering.
3. **AX snapshot returns 0 flight data**: The 242-line snapshot contains only nav, language settings, and form elements — no flight cards, prices, or airline names.
4. **Autocomplete requires character-by-character typing**: `page.keyboard.type('Munich', { delay: 100 })` triggers the autocomplete dropdown; `page.evaluate(() => inp.value = 'Munich')` does not.
5. **Date picker**: Google Flights uses a custom calendar widget — `[aria-label*="24 August 2026"]` finds the day buttons, but need to open the picker first by clicking the departure date field.
