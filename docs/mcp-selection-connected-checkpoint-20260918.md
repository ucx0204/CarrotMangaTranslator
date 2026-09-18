# Bundle 3 connected selection checkpoint - 2026-09-18

Baseline: `06b1a73c`. Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. User/model/client acceptance is deferred
until all roadmap bundles are implemented. This record supersedes the earlier
observation-only selection checkpoint for the application/reference slice.

## Connected implementation

The existing selected OCR/translation observations now have six application tools:

- `carrot_preview_selection_batch`
- `carrot_get_selection_batch`
- `carrot_apply_selection_batch`
- `carrot_undo_selection_batch`
- `carrot_redo_selection_batch`
- `carrot_cancel_selection_batch`

All six are wired into the actual app composition and strict output contracts.
The output schema inventory is 83. Editing and processing must both be enabled
locally; preview/mutations require read/edit/process, while owned inspection uses
read scope. Existing observation tools and generic edit tools remain compatible.

The bounded target is one chapter, 1-20 pages and 100 explicit changes total.
Analysis application accepts only owned completed observation item IDs with the
matching page, mode and revision. The server derives source/translation text from
that record; transport cannot supply raw blocks or arbitrary replacement text.
Empty OCR/translation observations do not clear saved text. Generated lettering
is excluded. Source-only changes keep typography/masks and warn that retained
source measurements may need review; no implicit analysis is triggered.

Reviewed region discoveries use native block creation and containing-pixel bounds.
Overlaps require explicit approval, source strings exceeding the native creation
limit are rejected rather than truncated, and insertion may be at the beginning,
after a named existing block, or at the end. Other blocks keep their relative
reading order. This is not blind page replacement or automatic addition of every
region. New-block defaults use the existing public settings snapshot and canonical
normalizer without settings migration, writes or secret hydration.

Reference commands are separate from analysis commands. They validate native
unique enabled character/glossary IDs belonging to the current work. Omitted fields
are preserved; null removes a field; [] stores an empty glossary list. Saved block
reads expose only the reference IDs. No glossary, character or memory is rewritten.

## Native commit and exact recovery

The existing page-batch service and native page transaction are reused. Forward
commits recheck all observation dependencies, not only selected write targets:
page revisions, membership, context and OCR source hashes. Non-waiting dependency
read leases are acquired after native target handoff. Evidence has a fixed deadline
and is checked again at authorization before persistence. External filesystem
races are not claimed impossible.

A first conflict, failure or cancellation stops future saves. Earlier committed
pages remain explicit partial results, even if a later UI notification fails.
Historical action IDs never reapply. Cancellation is not rollback.
Undo restores the exact changed block snapshots, optional reference-field absence,
and original reading-order absence or legacy partial order; it removes only the
owned appended blocks. Later user edits conflict. Undo does not need an expired
observation or deleted context entry; forward redo still validates those inputs.
The native save may invalidate derived workflow status; this is block/order recovery,
not an arbitrary whole-page metadata rollback. History is session-only with a
30-minute idle lifetime. Permanent recovery remains bundle 7.

## Automated verification at this checkpoint

Code/registration baseline for the final run: `10472c97`.
37 focused tests across seven files passed, including actual native persistence,
source/translation-only preservation, discovery order, exact absence restoration,
foreign ownership, changed unselected dependencies, empty observations, cancellation,
partial commits, expiry, deleted context and real scoped OAuth/HTTP behavior.
Renderer/Electron type checks, changed-file lint and architecture checks passed.

The complete first coverage run had 7,771 passing tests, one missing-inventory
registration test failure and 11 existing skips. Six actually measured new modules
were subsequently registered, retaining all 1,595 inherited rows, provenance and
ten deletions. The exact production coverage-floor checker then passed.
See `mcp-selection-edit-coverage-20260918.md` for ratios, hashes and the distinction
between the earlier partial MCP coverage run and the full measurement.

The final `npm run check` is pending confirmation in this intermediate record.
Do not claim all 26 gates or start bundle 4 until its actual exit/result is recorded.
Log: `.tmp/mcp-selection-edit-full-check.log`.

## Test boundaries and resume

External OCR/translation inference and native raster boundaries are substituted;
actual library, source hashes, coordinate conversion, block creation, page/context
ownership, atomic persistence, recovery and OAuth/HTTP are executed in isolated
fixtures. These are not live model quality or user/client acceptance tests.
No live app restart, user artwork/library/authentication change, model download,
ChatGPT/Tailscale call, master merge or release was performed.

After all automatic gates pass, mark bundle 3 implemented/live deferred and resume
bundle 4: multi-block erasure, free/protected masks and localized correction/restore.
Bundles 1 and 2 remain complete. Bundles 4-13 have not been implemented in this turn.
Detailed contract and architecture decisions: `mcp-selection-edit-boundaries-20260918.md`.
