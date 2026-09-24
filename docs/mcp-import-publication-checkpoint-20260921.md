# Bundle 10 continuation: reviewed multi-URL library publication

Latest continuation: `mcp-import-source-history-checkpoint-20260921.md`. Persistent
source identity and reviewed duplicate rejection are verified at `0d77b62a`; resume
at library organization and general input exchange. Publication evidence below
is historical and preserved.

Status: IMPLEMENTED, REGISTERED, ALL 26 REPOSITORY GATES AND THE ADDED NATIVE
PUBLICATION REGRESSION PASSED. Bundle 10 as a whole is NOT complete.
Starting source: `761d0d53`. Verified final source/tests/configuration:
`933f5d5f4e2bf17192d84e363045e084f77a6ca8` on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Preserve bundles 1-9, reviewed native input, discovery and multi-URL preparation.

## Connected public behavior

`carrot_import_batch_chapters` is connected to the existing import session,
operation journal, OAuth scopes and strict input/output validation. The output
inventory is 171, increased from 170. The existing seven batch-preparation/control
tools and standalone `carrot_import_chapters` remain available.

The new command accepts only reviewed batch item/preview/draft/page IDs, the current
batch version, explicit chapter/page order and ONE new or existing destination.
It accepts no arbitrary filesystem paths, caller source bytes, supplied URLs,
callback functions or serialized native requests. Up to ten chapters and fifty
selected pages TOTAL are published through the original native importer in ONE
transaction. This is an atomic reviewed group, not automatic application of all
image candidates. The existing URL scanner still handles sequential collection,
per-URL failures, explicit retries and unavailable-preview rescans independently.

Each selected preview is reserved before asynchronous source-file verification begins. Current
ownership, captured source bytes, preview expiry, batch version and the existing
work's destination snapshot are checked before publication, including after receipt
and plan encryption. A new work is created once per command. Existing chapters,
original images and unselected batch items are preserved. Later chunks need fresh
plan/destination snapshots rather than silently adopting intervening library edits.

The existing import transaction now commits chapter files, the encrypted import
receipt and parent batch progress together. Failure before the commit point saves
none of that group. Cancellation after commit is NOT an undo. Pause does not split
the current atomic group. Scan, publication and plan disposal use the same existing
batch-service admission state and app operation service; there is no second importer,
GPU queue, renderer or storage authority.

## Durable identity and reconstruction

Receipts optionally include `batch.id` and a bounded mapping of each item/preview
to its created chapter IDs and page count. Native receipt reads and job-history
reconstruction validate the exact mapping against the admitted input. Legacy
single-preview receipts remain readable without inventing batch data.

The plan records each selected item's historical receipt in the SAME transaction.
Its imported state therefore survives disposal of the separate receipt, as long
as the plan itself remains retained. A retained receipt can replay the identical
request after MCP session reconstruction without source bytes or another import,
even if the independent job journal was lost. An imported parent item cannot be
republished using a new request merely because its separate receipt was discarded.
Discarding the plan/receipt never deletes ordinary imported chapters.

A deliberately corrupted parent checkpoint initially accepted a receipt for a
different batch. The failing regression is preserved in
`.tmp/mcp-import-publication-edges-initial.log`. The checkpoint schema now validates
batch identity, group membership, chapter order/uniqueness, total page counts,
preview evidence and identical receipts on every group member. Invalid checkpoint
metadata is rejected, not converted into permission to import again.

## Verified cases

Seven new test files contribute 18 passing cases. They execute real native
library files, the original importer, staging, transaction publication, retained
storage, operation journal, registered tool contracts and OAuth/HTTP. Unit tests
substitute only external browser/image-decoder/OS-encryption boundaries.

Cases cover reversed chapter/page order, selected subsets, one new work, existing
work append and stale destinations, omitted URLs, owner/scopes/strict parameters,
aggregate limits, individually used previews, exact expiry, malformed receipts,
late encryption failure, grant revocation, cancellation, active disposal rejection,
post-commit lost response, missing job history, reconstruction and receipt disposal.
A partial URL preparation failure is explicitly retried, then both reviewed results
are published without recollecting the previously successful URL. Original failure
attempts remain in the restored plan. No live provider or model is called.

## Final repository verification

All 26 gates passed with actual process exit code zero at `933f5d5f4e2bf17192d84e363045e084f77a6ca8`:
**8,266 tests passed, zero failures and 11 inherited skips**.
The MCP subset passed **1,424 cases across 238 files**.
Renderer/Electron/JavaScript type projects, lint, formatting, error handling,
architecture/maintainability, duplicate/dead-code checks, mock boundaries, exact
coverage inventory/floors, Windows build, native artwork parity, image protocol,
renderer and preload checks all passed. The supported process-local worker option
was eight; checked-in defaults, test timeouts and skips were not changed.

All **1,732 inherited coverage records, provenance and deletion entries are
unchanged**. Only two new modules were registered using measured V8 totals/covered
counts, bringing the inventory to **1,734**. Initial measurement source: `0bf11a64`.
`mcpImportSelection.ts` measured 95% lines/statements, 100% functions, 90% branches;
`mcpImportPublication.ts` measured 100% for all four metrics. These initial floors
were enforced successfully against the final suite. Artifact SHA-256:
`b6f1ccee5d6e9946d3ce12b281a69bc980c22838eab29a21c7f93eb3b83d63e7`.
Only two measured direct dependency counts were registered; global limits stayed.

The initial full run passed 8,260 cases and failed only the then-missing two-module
coverage inventory. A subsequent full run passed 8,265 cases; the final run includes
the additional partial-scan-to-publication regression. Initial failed logs and
measurements remain separate; they are not relabelled as the final passing run.
An isolated coverage-check tool request was rejected before execution and is not
verification evidence. The complete repository runs independently executed and
passed their unchanged coverage stage. Native test type-cycle and fixture typing
errors were corrected without suppressions.

Final gate interval: `2026-09-20T20:47:01.806Z` through `2026-09-20T20:51:27.189Z`.
Evidence in the review worktree: `.tmp/mcp-import-publication-full-check-3.log`,
`.tmp/mcp-import-publication-final-evidence.json`, final-vitest.json,
final-coverage.json, final-timings.json, verified-source.json and
coverage-registration.json with the same prefix. Current source/test/script hashes
were fixed and rechecked; subsequent documentation commits must match this verified
source for those paths.

## Actual Electron verification and limits

The added `scripts/mcp-native-import-publication.cjs` is called after the existing
native import regression. It passed in actual Electron at `82328477`, with actual
child exit code zero, all three mandatory markers and the isolated listener on
port 38697 confirmed closed. Both source and native scripts are byte-identical at
the final verified commit; the later change only adds/formats a regression test.

The scenario prepares two synthetic collected-image results, preserves reviewed
order, validates real PNGs, imports both chapters, stores an OS-encrypted receipt
and plan, reconstructs MCP sessions, replays without import, discards the separate
receipt and confirms the restored parent still reports imported. Original and
imported image bytes remain equal. The outer existing native regression also passes.
Evidence: `.tmp/mcp-import-publication-native.log` and
`.tmp/mcp-import-publication-native-result.json`.

Only browser collection is synthetic in this new native scenario. Image validation,
ordinary library publication and OS encryption are real. It is NOT a positive
real-browser chapter-discovery/site acceptance test, a live-user manuscript test,
or proof that every archive/native parser works. Reconstruction is of MCP sessions
inside the isolated Electron process, not a user-app restart or power-loss test.
The running user app, real library/artwork, authentication, model assets, Tailscale
and operating-system security settings were not modified or restarted.

## Limits and exact next work

Each publication selects at most ten chapters/fifty pages across at most ten current
URL previews. Selecting a subset still consumes that selected preview once; omitted
URL items remain available. Previews keep the existing thirty-minute session-only
lifetime and shared 256-MiB source budget. Plans and receipts use the existing
seven-day/256-record/1-GiB retained policy and same data profile/approved owner.
Imported ordinary works/chapters do NOT expire with metadata. Historical receipts
indicate prior import, not current content equality or permission to undo.

Next implement durable source URL/content identity and fresh-preview duplicate
inspection/new-chapters-only selection through existing native publication.
This slice does NOT prevent a fresh plan/preview from importing the same source
again. Then continue native library naming/order/move/delete/recovery, general
incoming attachment bytes and working-file exchange. Dedicated positive browser
and final live-client tests remain separate and deferred as previously agreed.
Do not redo completed preparation/publication, start bundle 11, create another
branch, merge master or publish a release.
