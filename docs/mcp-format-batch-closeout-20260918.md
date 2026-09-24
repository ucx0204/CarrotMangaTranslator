# MCP format search and reversible batch editing closeout

## Scope

One chapter, explicit per-block formatting and display-rectangle edits across up to
50 pages and 1000 blocks. The AI interprets ordinary user feedback, finds candidates,
chooses patches, inspects normalized before/after data, applies within the requested
scope, and explicitly verifies rendering. Users need not supply IDs or coordinates.
No OCR, translation generation, font matching, research or new model queue is added.

`carrot_search_chapter_text` now accepts optional AND-combined `format` conditions.
Stored values and effective values from the existing conditional field registry are
separate. Nominal font size is not a measurement of the final rendered glyph size.
The six new tools are preview/get/apply/undo/redo/cancel with suffix `format_batch`.

The existing text batch lifecycle is shared, not copied. Formatting uses the app
field editor and the existing page handoff/atomic storage. Text including inline
markup, source rectangles, order, review fields, image layers and masks are preserved.
Generated lettering is excluded with reasons; excluded image payloads are not retained
in history. Manual font-size choices are protected by default. Font availability is
not guaranteed by successful storage. Undo/redo restores exact optional format state.

## Fresh Windows verification

- Full `npm run check`: all 26 gates passed, process exit 0.
- Vitest: 7498 passed, 0 failed, 11 existing skipped, 896 files passed, 1 skipped.
- Focused initial regression: 52 tests in 7 files passed. The subsequently added
  membership-boundary regression and the other 3 HTTP tests also passed.
- Renderer/Electron/script typechecks, formatting, lint, structural checks,
  existing coverage floors, Windows build, artwork parity and protocol checks passed.

The first resumed full run found one uncovered existing page-editor line: rejecting
changed chapter membership inside the page lease. A real-library regression now
changes membership and verifies rejection, no receipt, no notification and no write.
The existing 100% line floor was not lowered. All previous floor entries are exactly
unchanged; the renamed shared lifecycle retains its old four floors. Seven new
modules are registered using the separately recorded measured summary.

## Native verification

Fresh Electron smoke finished with exit 0 and `PASS MCP native smoke finished`.
The hostile matrix passed 358 checks across 52 production tools. The format scenario
uses real search, page leases, persistence and renderer: search two pages, preview
without saving, apply distinct formatting/display geometry, undo, redo and undo.
It checks actual changed bitmap output, exact original bitmap/block restoration,
stable redo output, original image bytes, unrelated blocks and historical receipts.
Format processing has no model boundary stub; legacy inference tests retain fixtures.
The first native attempt stopped before assertions because port 38475 was occupied.
Its log is preserved; rerunning on verified-free isolated port 38479 succeeded.
No unrelated process was killed to free that port.

## Limits

History is session-local with 30-minute idle expiry, 32 plans, 4 MiB per plan,
32 MiB total and 32 action receipts per plan. Pages commit sequentially and stop on
first failure/conflict/cancellation. Already saved pages are not silently rolled back.
Forward writes check saved context; safe undo may follow a context change. Later
page edits conflict rather than being merged. Successful storage is not visual QA.

## Deployed app and client boundary

The review app was closed normally and relaunched with `npm run dev`. No other
Carrot app was closed and no credentials, approval preferences or model settings
were edited. The saved automatic-start preference brought MCP back online. Two
initial capability calls failed during startup; later capabilities and server-info
calls succeeded. The persistent server/data-profile IDs match the prior runtime;
the runtime ID changed. The actual UI also showed the connected state.

The live capability response includes all six new format tools. Targeted connector
discovery still returns the old callable catalogue, so direct ChatGPT format-tool
calls were NOT performed. Refresh the connection's catalogue before that remaining
client-level test. No credentials were obtained to bypass this boundary.

The disposable work was backed up: 14 files, 55167 bytes, verified SHA-256. A fresh
comparison after restart was byte-identical. No normal-library content was edited.
All format mutations in this closeout used isolated real-library/native fixtures.
Evidence: `.tmp/mcp-format-batch-20260918/` contains `check-final.log`,
`check-final.exit`, `native-final.log`, `native-final.exit`, the preserved native
port-conflict log, and the verified disposable-work backup/manifest.
