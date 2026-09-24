# Bundle 10 continuation: library metadata synchronization

Latest continuation: `mcp-page-order-checkpoint-20260921.md`. Page ordering and
exact memory recovery are now connected and verified at `143a4be9`; the remaining
work is moves/deletions/recovery and general incoming files. Historical synchronization
implementation and verification below are preserved.

Status: IMPLEMENTED; ALL 26 REPOSITORY GATES, DEDICATED ELECTRON AND UI CHECKS PASSED.
Bundle 10 is NOT complete. Continue only on `feat/mcp-app-bridge` in the existing
MCP-Review worktree. Starting reported checkpoint: `5ebf0a59`.

## Connected behavior

The existing six library-change tools now announce a successful nonhistorical
apply/Undo/Redo through a typed desktop event. Its only fields are work ID and an
optional affected chapter ID. No titles, dialogue, image bytes, local paths or
credentials enter the event. No new public MCP tool was added: output inventory
remains 178. All existing ownership, permission, review and transaction guards stay.

Notification is AFTER native publication. Read-only preview/inspection/list,
no-op, historical replay and rolled-back publication do not announce a new change.
If the renderer notification throws after commit, the ordinary data and durable
receipt remain saved, the response includes `notification_failed_after_commit`,
and the existing redacting logger records the cause. No retry silently applies
an already completed change again.

Desktop composition passes the event through the existing main window, typed IPC
contract, preload subscription and renderer gateway into `useMcpEditorSync`.
The library list is reread on metadata notification, including when another work
is currently open. The open chapter is reread only when it is affected. Existing
page-edit notifications and editor-state probes remain separate and compatible.

List reads are serialized and coalesced; an already superseded response is not
published. Chapter refresh uses the existing coordinator, with an explicit option
to discard superseded responses. Navigation and unmount do not apply obsolete
results, and a failed read does not prevent a later notification from retrying.
This does not introduce polling, a second library, an importer or model execution.

## Reproduced and fixed Undo display error

Native Undo intentionally restores original metadata timestamps. The old live
chapter merge preferred the local chapter when its timestamp was newer, so the
restored name could remain invisible in the editor. The regression fails against
the old merger: expected the restored title, received the pre-Undo title.
Evidence: `.tmp/mcp-library-sync-undo-repro.log`.

Only an explicit committed metadata refresh may prefer the freshly read chapter
metadata despite an older restored timestamp. The existing dirty-page merge still
preserves unsaved dialogue, block data and page selection behavior. Ordinary page
refresh retains its original timestamp rule and one-argument callback behavior.
The regression and default-behavior tests now both pass. No forced page save or
silent discard of pending input was added.

## Verification completed before the full check

Focused tests: 34 cases across seven files passed. They exercise actual preload
validation, renderer hook, dirty-page merger, native library transactions,
notification failure, rollback, reconstruction, request replay, navigation and
coalescing. Fixture event IDs were corrected to actual UUIDs; the production UUID
contract was not weakened to accept the original invalid test IDs.

Renderer, Electron and JavaScript types, scoped lint and architecture checks pass.
The Windows build passed. One measured logger consumer was documented (42 -> 43)
for post-commit notification failures. Type-only event dependencies are explicitly
type-only imports, not runtime dependency exceptions. Global ceilings are unchanged.

At source `ebc9a72259e41bc5bde127f0449889340f537c2e`, the actual Electron harness
completed the NEW library-organization scenario and all existing native regressions.
It exercises work rename, unique chapter naming and two-chapter ordering, real OS
encryption, reconstructed lookup/Undo/Redo, historical replay, record disposal,
exact metadata restoration and original/imported image preservation. Required
completion markers were all present; the actual child exited zero and isolated
port 56407 closed. Evidence: `.tmp/mcp-library-sync-native.log` and
`.tmp/mcp-library-sync-native-result.json`.

The scenario is connected through the existing grouped-import fixture and uses only
its two newly created chapters. File selection and browser collection remain
synthetic external boundaries; native library storage and OS encryption are real.
This is not a live user-app restart, live website, live model or public MCP-client
acceptance test. A later optional request to strengthen its assertions did not
execute; it is not counted as additional verification.

Actual production `LibraryTree`, synchronization hook, merger and CSS were rendered
in isolated Chromium with the repository QA bridge. The wide (1280 x 800) name-change
and narrow (480 x 760) Undo captures showed the updated names in both the tree and
the open-chapter label. Runtime assertions checked synchronization and viewport
bounds; screenshots were opened and inspected for clipping/overlap. The temporary
entry and captures were removed after inspection. Reproduction fixture and capture
hashes/dimensions remain under `.tmp/mcp-library-sync-ui-*`. This tests the real
components with synthetic event/read boundaries, not the entire running user app.

## Final whole-repository verification

Verified source/tests/configuration: `273c5ece4eccbd0e8243d833c4e88a56767d8f0f`. All 26 gates
passed with actual process exit zero: **8,310 tests passed, zero failures and
11 inherited skips**. The MCP subset passed **1,467 cases across 254 files**.
The three new Vitest files contribute eleven passing cases; the dedicated Electron
scenario is counted separately, not as additional Vitest cases.

Renderer/Electron/JavaScript types, formatting, lint, error handling, test boundaries,
architecture/maintainability, duplicate/dead-code checks, exact coverage inventory
and floors, Windows build, artwork parity, image protocol, renderer and preload
gates passed in one complete run using the supported process-local eight-worker
setting. Default workers, timeouts, inherited skips and global limits were not changed.

Gate interval: `2026-09-21T00:01:22.034Z` through `2026-09-21T00:06:22.435Z`.
Evidence: `.tmp/mcp-library-sync-full-check.log`, final-evidence.json,
final-vitest.json, final-coverage.json, final-timings.json and
full-verified-source.json under the same mcp-library-sync prefix.
All twenty-five changed production/test/configuration file hashes matched after
verification. Native/UI source and their harness are unchanged from `ebc9a722`;
the intervening verification commit only registers the historical floor and
updates its exact-inventory test count. Final documentation does not change code.

## Coverage preservation

All 1,745 inherited coverage records, provenance and deletion entries are preserved.
The newly touched existing `liveChapterRefreshCoordinator.ts` uses its ORIGINAL
historical baseline: lines/statements 25/27 (92.59%), functions 4/4 (100%), branches
13/15 (86.66%). Its historical source is
`.tmp/production-cleanup-coverage-baseline-node22.json`, verified SHA-256
`a0e1199f46a80734d228ff1772b99d1fde2f700321346da77abf9c29795e4c0a`.
No production module was added. Exact inventory becomes 756 historical and 990
introduced records, 1,746 total; no floor was lowered or source excluded.
The final whole check enforced every old and newly registered record successfully.

## Exact remaining work

Continue bundle 10 with page ordering and its
saved-memory effects, separately reviewed moves/deletions/recovery, and general
incoming file bytes/working-file input. Page ordering was inspected but NOT
implemented in this continuation. The existing native reorder reconciles page
memory indexes/names; its deletion/deduplication effects and file presence need
exact recovery treatment before exposing it. Do not duplicate the importer, rename
policy, renderer, image engine, transaction or authentication authority.

The ordinary library and existing names/order do not expire with seven-day recovery
records. Existing per-command and retained-catalog limits are unchanged. Do not
advance to bundle 11 while the remaining bundle 10 items are incomplete.

The user's running app, real artwork/library, credentials, model assets, Tailscale
and OS security settings were not changed or restarted. All mutations were confined
to isolated fixtures. No master merge, release or new branch. Live acceptance stays
deferred until all implementation bundles are ready.
