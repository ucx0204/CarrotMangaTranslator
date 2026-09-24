# MCP block structure closeout - 2026-09-17

## Implemented and verified scope

Source implementation: `12808518`; measured architecture boundary commit: `db2abe80`.
Branch: `feat/mcp-app-bridge`, no additional MCP branch.

One ordinary block can be deleted, one split into two, or two adjacent blocks
merged into one. The calling AI infers IDs, original-pixel rectangles, wording
allocation, style source and order from the user's goal and page observations.
Exact arguments are an AI-to-app contract, not technical input demanded of users.
The server does not claim that exposing primitives implements autonomous judgment.

Registered tools:

- `carrot_preview_block_structure_edit`
- `carrot_get_block_structure_edit`
- `carrot_apply_block_structure_edit`
- `carrot_undo_block_structure_edit`
- `carrot_redo_block_structure_edit`

Preview/get return bounded public before/after data, order, ID mapping, warnings
and availability without attachments. Apply/undo/redo reuse existing page handoff,
authorization and the atomic blocks/order storage transaction. Exact retries
produce historical receipts with zero new changes, even after an opposite action.
The in-flight cross-plan request-ID race is covered by a regression test.
No OCR, translation, inpainting inference, internet research or paid request runs.

## Current verification

Windows `npm run check`: all 26 gates passed, process exit 0.
Full Vitest report: 7,436 passed, 0 failed, 11 existing skipped (7,447 total).
Focused structure/baseline/output checks: 50 tests in 6 files passed.
Coverage inventories and all existing floors passed unchanged.
Native Electron smoke: exit 0 and final `PASS MCP native smoke finished`.
Native hostile matrix: 270 checks across 39 production tools passed.

Native structural scenarios execute actual page ownership, library persistence
and the real renderer: delete, split and merge each apply, undo, redo and undo.
The test verifies changed output after editing, byte-identical original/cleaned
rasters, exact original rendered bitmap after undo, stable redo IDs/output,
reading order, metadata-only responses and historical-request non-reapplication.
No inference stub is needed for structural editing itself. Other legacy smoke
scenarios continue to use their existing model-boundary fixtures.

Four measured direct-consumer ceilings (46/28/40/41) were recorded for
pageRevision/ipcSchemaPrimitives/geometry/mcpEditPolicy, with per-file rationale
and `docs/architecture.md` documentation. No global limit, copied algorithm,
alias wrapper, authorization change or existing coverage-floor reduction.

## Deployed app and client catalogue

The review worktree app was closed normally (not killed) and restarted with
`npm run dev` after the successful build. The other running Carrot app was not
closed. The live MCP connection reports all five new names. Persistent server
and data-profile IDs match before/after; only the runtime ID changed.

The current ChatGPT conversation still exposes the older callable catalogue
without the five new definitions, including after targeted discovery. Therefore
native/HTTP execution is verified, but direct ChatGPT calls of those five tools
are NOT recorded as passed. Refresh/scan the connection's tool definitions and
use a new conversation before that final client-level trial. Do not work around
this by obtaining credentials, changing approval settings, or overwriting files.

Before restart, all 14 files of the disposable `MCP Edge Audit 20260916` work
were backed up and verified with SHA-256. After restart all 14 original files
remain byte-identical. No normal-library page or test-work content was edited
in this closeout; actual structural mutations ran only in isolated fixtures.
Authentication, model settings and Tailscale configuration were not changed.

## Explicit limitations

Ordinary blocks only: unsafe generated lettering, geometry-dependent typography
and SFX review references are rejected rather than silently discarded.
History is session-local, 30 minutes since preview/latest action, 64 entries,
32 MiB and 32 actions per entry. Restart/expiry removes recovery availability.
Later page or SFX-ledger edits conflict; no automatic merge of manual changes.
Undo restores blocks/order/output, but workflow completion may remain pending.
No cross-page editing, bulk search, permanent undo or whole-library automation.

## Evidence and next trial

Local logs and verified backup (not committed):
`.tmp/mcp-structure-closeout-20260917/`
`check-first.log`, `check-first.exit.txt`, `vitest.json`, `native-first.log`,
`native-first.exit.txt`, `live-before-manifest.json`, `live-before/`,
`app-restart.log`.

Next client trial: inspect a disposable source/rendered page, author a small
structure correction, preview/apply, re-read and render, undo/redo, test a stale
revision and an exact old action retry, then leave the page restored. The AI
supplies all coordinates and block IDs; the user only supplies the desired result.
