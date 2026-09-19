# Bundle 7: durable page recovery and retained output assets

Status: IN PROGRESS. Starting point: `7c3563d4`.
Only `feat/mcp-app-bridge` and the existing MCP-Review worktree are used.
Do not restart the live app, alter user artwork/authentication/model assets,
merge master, release, or start bundle 8. All live acceptance remains deferred.

## Implementation boundaries

Persist before/after records for actual MCP page content transactions, including
blocks/order, selected typography, selection appends, SFX review and generated
layers, and original/cleaned/mask image evidence. Record publication must share
the native library transaction with the page save: no save-success/history-loss
gap. Keep native page handoff, work/context access, immutable source evidence,
optional-field absence, later-edit conflicts, and exact retry receipts.
Do not serialize model observations as executable plans or rerun a model on redo.
Existing session tools remain compatible; durable records have independent IDs.

Use bounded, profile-bound encrypted metadata and owned immutable image copies.
Recovery republishes only retained copies through the existing native transaction;
it does not depend on temporary inference files or revive an old download URL.
Read/list/restore/discard are explicit, owner-scoped tools. Runtime statuses and
arbitrary whole-library changes are not historical page content. Cross-work
context migration remains bundle 9, not an implicit recovery operation.

Retain completed native PNG/ZIP bytes separately from short-lived capabilities.
List/inspect outputs and issue fresh links only after current owner, image scope,
redaction, page and source checks. No rerender/model/permission transfer is implied.
Stop/restart invalidates links while retained bytes remain within stated bounds.
Deletion/expiry only touches this store's own records and copies, never originals
or unrelated exports. Corruption, capacity, encryption and I/O errors fail closed.

## Verification

Add native transaction characterization, exact restart undo/redo, partial saves,
crash rollback/commit, retry, foreign-owner/profile, stale source/page, revoked
permissions, corruption and scoped deletion tests. Exercise actual OAuth/HTTP
and isolated Electron without live models. Preserve all 1,643 inherited coverage
records and register new production modules from measurement only. Run the full
26-gate repository check and read final exit codes before marking completion.

## Resume

Inspect existing native transaction staging, artifact capabilities and encrypted
MCP state; implement the transaction participant and retention contracts first.
No bundle-seven function is yet complete or registered.
