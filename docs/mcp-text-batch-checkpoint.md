# Chapter text search and translation batch checkpoint

## Scope

AI clients infer correction targets from ordinary user feedback by searching or
browsing stored dialogue, reading full blocks/context, and explicitly inspecting
rendered results. End users are not expected to supply IDs, coordinates or arrays.
This bundle is translation-text-only within one chapter. No OCR, translation
model, image generation, inpainting, Tavily or automatic formatting runs.

## Tools

- `carrot_search_chapter_text`: literal case-sensitive search or explicit browse;
  bounded UTF-16 snippets, neighbors, filters and revision-bound pagination.
- `carrot_preview_translation_batch`: per-block corrections on up to 50 pages,
  1000 blocks total; generated lettering is excluded with reasons.
- `carrot_get_translation_batch`: paginated before/after evidence, page outcomes,
  current conflicts and action progress. A start receipt is not completion.
- `carrot_apply_translation_batch`, `carrot_undo_translation_batch`,
  `carrot_redo_translation_batch`: sequential native page edits with fixed targets.
- `carrot_cancel_translation_batch`: cancel the inspected action request ID only.

## Current checkpoint

Implementation and app registration are complete. Fresh Windows repository checks
passed all 26 stages with 7,469 tests passed and 11 existing skips. The isolated
Electron smoke reached its final success marker and exited 0. The updated live
MCP connection exercised all seven tools, three-page apply/undo/redo, historical
retries, partial failure, explicit rendering and final data/output restoration.
See `docs/mcp-text-batch-closeout-20260918.md` for exact evidence and limitations.
The previous pending-check status is superseded; no implementation was rewritten.

## Safety and limits

Each changed page acquires the existing app handoff/ownership before obtaining
an inner work-context read lease. Page and context checks remain valid through
the ordinary translation-only storage transaction. The inner lease does not
replace the page activity owner and never waits behind another context writer.
The batch stops at its first failed/conflicting/cancelled page; earlier committed
pages remain recorded. Re-plan unprocessed pages after reading current content.
Undo/redo refuse later page edits rather than merging or forcing revisions.
Undo may restore a page even after glossary changes; forward actions require the
original context revision. No whole-chapter lock is held during review.

Inspect before/after values and render each changed page explicitly. Storage
success is not visual verification. Generated lettering is excluded, never
silently replaced; original source, geometry, typography and images are retained.
Plans and text history are memory-only: 30-minute idle expiry, 32 plans total,
4 MiB per plan and 32 MiB total. There are at most 32 action receipts per plan.
Completed action IDs return historical receipts and never perform another write.
This is not a local-model batching facility or durable resume/undo system.

## Architecture

The existing renderer search uses unbounded case-folded highlighting. Protocol
search instead reports bounded case-sensitive UTF-16 offsets in stored strings.
It does not import renderer code or execute regular expressions supplied by AI.
Six measured dependency exceptions retain direct consumers of the existing page
revision, fingerprint, typed errors, library facade and redacting logger. The app
composition root wires tools/adapters directly; no forwarding modules hide edges.
