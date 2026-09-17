# MCP chapter format search and batch editing

## Scope and current implementation

AI clients interpret ordinary user feedback by inspecting stored blocks and actual
rendering. Users are not asked for IDs or pixel coordinates. This extension adds
format conditions to the existing chapter text search, and six format-only batch
tools. It does not run OCR, models, erasure, font matching, downloads or research.

- `carrot_search_chapter_text`: optional `format` conditions, all combined with AND.
  `basis: effective` uses the existing conditional field editor defaults;
  `basis: stored` matches only present stored properties. Sizes are nominal, not
  measured final glyph sizes. Use browse without a query for style-only selection.
- `carrot_preview_format_batch`: one chapter, fixed explicit page/block edits,
  current page and context revisions, at most 50 pages and 1000 blocks total.
- `carrot_get_format_batch`: inspect actual normalized before/after format,
  exclusions, current conflicts and asynchronous page outcomes.
- `carrot_apply_format_batch`, `carrot_undo_format_batch`,
  `carrot_redo_format_batch`: start an action; poll inspection to terminal state.
- `carrot_cancel_format_batch`: cancel the current inspected action UUID only.

## Contract

Only formatting fields already supported by the app and display rectangles can
change. Source text, translation text including inline markup, source rectangles,
reading order, review labels, image layers and masks are preserved. Generated image
lettering is always excluded, with reasons, rather than edited through a fallback.

`preserveManualFontSize` defaults to true. A patch requesting fontSizePx or autoFitText
on a block with manual size intent is excluded in full; other blocks can proceed.
Set false only when the user's requested scope includes changing those manual
choices. Other explicit scalar formatting on manual-sized blocks remains supported.
Font availability and visual quality are not implied by successful storage.

Search returns saved/effective format views and snapshot-bound pagination. Changing
criteria or data requires a new search; a candidate is not permission for blanket
replacement. The AI writes per-block patches, checks the plan, applies within the
user's authorization, re-reads and explicitly renders changed pages, then refines or
undoes when needed. No repeated human approval is imposed by the tools themselves.

## Implementation and recovery

Text and format edits share the existing fixed-target sequential batch lifecycle,
receipts, cancellation and context read scope. The app field editor calculates
normalized formatting; the page edit service owns handoff and atomic persistence.
It publishes committed receipts before renderer notification. Undo/redo restores
exact optional typography state and display frames, not only visible defaults.
Internal snapshots cannot replace non-format content. Excluded generated image
payloads are not retained in history and no whole-block snapshots are returned.

Pages save sequentially, not as a chapter-wide transaction. The first conflict,
failure or cancellation stops later writes; committed pages remain recorded.
Undo affects eligible committed pages and rejects later user edits. Forward writes
require the original context; safe undo can proceed after a glossary change.
Historical request receipts never apply again. Plans are session-only: 30-minute
idle expiry, 32 plans, 4 MiB each, 32 MiB total, 32 action receipts per plan.

## Verification checkpoint

Implementation, all 26 repository gates, 7498 tests and real Electron format
search/apply/undo/redo rendering checks are complete. The normal review app has
been restarted and advertises the six new tools. Direct ChatGPT calls await its
callable catalogue refresh. See `mcp-format-batch-closeout-20260918.md` for measured
results, deployment, unchanged source-data checks and the explicit client boundary.
