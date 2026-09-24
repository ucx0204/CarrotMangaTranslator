# Connected typography checkpoint - 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
This supersedes the missing-production-binding section of
`mcp-typography-selective-checkpoint-20260918.md`. The previous records remain
historical evidence, not the current registration or static-check status.

## Bundle 1 implementation

Previously rejected source-evidence, shared context-lease and test-lint changes
were implemented through the GitHub connector. The source validator reads only
paths from saved library pages, streams bounded original-file hashes, checks
original dimensions, and checks font catalog/profile/runtime identity before AND
after reading originals. It preserves errors and rechecks authorization/expiry.
No downloads, model inference, image transfer or source modifications occur here.

The production adapter accepts only an owned, completed and unexpired
`carrot_run_typography_analysis` job for the requested chapter. It never accepts
caller-supplied evidence, arbitrary paths or whole-block replacements. Legacy
single-page `carrot_run_page_source_size` observations are not silently promoted
into this richer context-bound contract; use typography analysis in size mode.

The six registered application tools are:

- `carrot_preview_typography_batch`
- `carrot_get_typography_batch`
- `carrot_apply_typography_batch`
- `carrot_undo_typography_batch`
- `carrot_redo_typography_batch`
- `carrot_cancel_typography_batch`

Preview/select/apply/undo/redo/cancel reuse the existing batch lifecycle, canonical
font and source-size appliers, native page handoff and atomic save. Application is
registered only when editing AND processing are enabled. Inspect requires read
scope; the other tools require read/edit/process. Every operation remains owned.
The output registry has 66 strict contracts including these six tools.

Apply/redo hold the existing nonwaiting context/dependency leases after native
page handoff. They recheck full analysis scope and original/font evidence before
saving. Revisions advance only from this plan's acknowledged commits. Cancellation
stops future saves; partial saves remain explicit and can be undone independently.
Undo requires the current target revision and membership but does not require
expired observation data, removed fonts or missing originals to be re-created.
It restores exact optional-field absence and never overwrites later user edits.

App-owned dependency edits are excluded while a forward save is in progress.
Out-of-process filesystem replacement is detected by byte checks, not prevented
by an operating-system-wide file lock. Catalog snapshots identify registry
metadata and canonical candidate/runtime descriptors, not font binary hashes or
a per-string glyph-coverage proof. No stronger guarantee is claimed.

## Scope and next work

Bundle 1 is implemented, registered and automatically verified. Live acceptance
remains deferred. Bundle 2 is the next implementation:
independent bubble layout, advanced typography and reusable rules/presets.
Bundles 2-13 are not completed by this change.

Actual C23 inference/quality, live ChatGPT/Tailscale calls and final client file
acceptance remain deferred until the requested implementation sequence is built.
No running user app was restarted; user artwork, library, credentials, approved
model assets, master and releases were not changed. Undo/history remains bounded
and session-only; durable recovery is still bundle 7, not completed here.

## Final automated acceptance

Verified source checkpoint: `96cc3625edc724b8c98e72c3e99b073e6b5fc182`.
`node scripts/check.cjs` exited 0: all 26 stages passed. This includes all three
TypeScript checks, formatting, lint, dependency/maintainability/duplicate checks,
error handling, mock boundaries, exact coverage inventory/floors, Windows build,
existing page-artwork pixel parity, image protocol and renderer/preload boundaries.
The old test non-null assertion and architecture-consumer findings are resolved.

Full Vitest/V8: 7,668 passed, zero failed, 11 pre-existing skips.
Within it, all 854 MCP tests across 114 files passed. New application/HTTP/evidence
tests use temporary libraries, real file hashes, app font/size appliers, actual
page handoffs/context/dependency leases, atomic saves and OAuth/JSON-RPC/output
validation. Only the C23 engine and native raster-loader boundary are replaced.
They do not constitute live model-quality or actual ChatGPT/Tailscale acceptance.

The production floor inventory is 753 baseline plus 819 introduced entries.
All 1,569 inherited rows, provenance and deletion records were compared with
`2f23a31f` and preserved. Three measured new adapter rows were added, not guessed.
Global architecture limits stay 12 runtime imports and 25 consumers; only four
measured existing boundary entries were adjusted with additive reasons.
Protected pipeline/runtime assets and dependency manifests are unchanged.

New-module scoped measurement: 854 tests / 114 files passed; lines 93/96,
statements 97/101, functions 23/24, branches 25/28. This is not global coverage.
Source evidence: lines 43/44, statements 43/45, functions 5/5, branches 15/17.
Production adapter: lines 32/33, statements 36/37, functions 10/10, branches 8/9.
Session/tools: lines 18/19, statements 18/19, functions 8/9, branches 2/2.

Inherited floor-manifest SHA-256:
`f46bd4ee57460f317d66a5d8bcffa75373708b9531f7cc17976ac5816df35da9`
Scoped measurement SHA-256:
`a4be93ff00fa2cc6806aa5712990c69a7697b726a9fb8c937547c33dfb42a7b4`

Evidence in the review worktree:
`.tmp/mcp-typography-github-full-check.log`
`.tmp/check-results/vitest.json`
`.tmp/check-timings.json`
`.tmp/mcp-typography-github-scoped-coverage.log`
`.tmp/mcp-typography-github-coverage/coverage-summary.json`
`.tmp/mcp-typography-github-coverage-evidence.json`

## Feature-to-implementation map

| Feature                        | Existing or connected boundary                                          | Automatic evidence                                                 |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C23/source-size observations   | Typography analysis service and canonical app analyzer                  | Analysis, source-size, model-cleanup suites                        |
| Owned observation lookup       | mcpTypographyBatchAdapter / existing operation journal                  | App and HTTP owner-isolation tests                                 |
| File/catalog/profile freshness | mcpTypographySourceEvidence                                             | Modified bytes/dimensions, expiry and revocation tests             |
| Selected font/size projection  | Canonical app appliers via mcpTypographyApplyProjection                 | Font-only/size-only, manual-lock and protected-field tests         |
| Apply/undo/redo/cancel         | Existing page-batch service and native page transaction                 | Partial-save, cancellation, exact restoration and later-edit tests |
| Public tools and schemas       | mcpTypographyBatchSession, page-operation composition, mcpOutputSchemas | Six-tool registration and real OAuth HTTP tests                    |

Next: bundle 2 independent bubble layout, advanced typography and reusable
rules/presets. Do not repeat completed bundle 1 or request intermediate live tests.
