# Chess Use Case: Proven on Windows (2026-08-10)

## Goal

Replicate ego-lite's "Win a chess game" use case (use-case #5 from lite.ego.app/use-cases) on Windows, using the vision unlock architecture (ego-windows-host + chrome-research on port 5192).

## The problem

Lichess.org and chess.com are blocked by the corporate firewall (net::ERR_ABORTED). Both return HTTP 000 from curl and fail to load in Chrome.

## The solution

Hosted a local canvas-based chess board at `C:\Users\M316235\repo\research\ego-lite\chess-board.html`. It renders an 8x8 board on a `<canvas>` element with:
- Standard starting position
- Click-to-move interaction (click piece, click destination)
- Legal move validation (pawns, knights, bishops, rooks, queens, kings)
- Move history (algebraic-ish notation: e2-e4, e7-e5)
- `window.chessAPI` object exposed for CDP automation: `getBoard()`, `getTurn()`, `getHistory()`, `move(fromR, fromC, toR, toC)`, `reset()`

## The full loop (proven)

1. **ego-windows-host** opens the local board: `browser.openOrReuseTab('file:///.../chess-board.html', { wait: true })`
2. **ego snapshot** returns only 59 chars (title + status text) — canvas is invisible to AX tree
3. **chrome-research** `take_screenshot` shows the full board inline in the agent's visual context
4. **Agent (vision model)** reads the board position visually — can see all pieces, ranks, files, move history
5. **ego evaluate** makes the move: `page.evaluate(() => window.chessAPI.move(6, 4, 4, 4))` → e2-e4
6. **chrome-research** screenshots again → agent verifies the move was made (pawn on e4, status "black to move")

## Moves played in the test

1. e2-e4 (white)
2. e7-e5 (black)

Both verified visually via chrome-research screenshots and via `chessAPI.getHistory()`.

## Key insight

The ego-browser skill's prescription for canvas pages is "screenshot + mouse/keyboard" (SKILL.md line 179). On macOS, the screenshot renders inline. On Windows, we achieve the same via chrome-research's `take_screenshot` — it connects to the same Chrome on port 5192 and returns images inline in the agent's context.

The `chessAPI` object exposed on `window` is a bonus — it lets the agent make moves programmatically via `page.evaluate` without needing to click coordinates on the canvas. In a real Lichess game, the agent would need to click on the canvas at specific square coordinates (calculated from the board position it sees in the screenshot).
