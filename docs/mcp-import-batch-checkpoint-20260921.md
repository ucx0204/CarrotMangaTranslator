# Bundle 10 continuation: retained multi-URL import preparation

Latest continuation: `mcp-import-publication-checkpoint-20260921.md`.
Reviewed multi-URL publication is now connected and verified at `933f5d5f`;
source deduplication, library organization and general file exchange still remain.
The earlier preparation checkpoint and historical verification below are preserved.

Status: IMPLEMENTED, REGISTERED AND ALL 26 REPOSITORY GATES PASSED.
Starting point `6559bfb1` on `feat/mcp-app-bridge`. Bundle 10 is NOT complete.
Preserve the existing native-file, single-URL import and chapter discovery tools.

## Connected surface

Seven tools are registered through the existing import session and operation service:
`carrot_prepare_import_batch`, `carrot_get_import_batch`,
`carrot_list_import_batches`, `carrot_run_import_batch`,
`carrot_pause_import_batch`, `carrot_cancel_import_batch`,
`carrot_discard_import_batch`. The strict output inventory is 170, previously 163.

Prepare fixes one to ten explicit URLs or owned discovery/link IDs, labels and
order. It stores metadata only: no browsing, image collection, model or library
import. URL identity uses the existing canonicalization; credentials are rejected,
fragments deduplicate and distinct query strings remain distinct. Discovered links
must belong to the caller and reviewed snapshot. Once prepared, the independent
plan no longer depends on discovery metadata remaining available. Actual URL/DNS,
private-address, redirect and browser protections are rechecked by the native scanner
when execution is explicitly requested; preparation itself makes no network request.

Run requires a current version, unique requestId and allowNetwork=true. It uses the
original McpOperationService/runMcpAppJob and import-preview service to scan fixed
URLs sequentially. It is a preparation batch, NOT automatic bulk library publication.
Each ready preview still requires ordinary page review and carrot_import_chapters.
OCR, translation, research, erasure and other model work are never invoked here.

Pending items execute in fixed order. Prior ready items are reused, failed/cancelled/
interrupted items need explicit retryItemIds. A fresh unavailable-preview scan needs
rescanExpiredItemIds and acknowledgeDiscardedReceiptRisk=true. Live previews cannot
be rescanned through that option. Historical owned atomic import receipts are checked
before any rescan. Completed imports are not re-downloaded by this plan.

Pause waits for the current URL and cleanup; cancel also cancels the actual native
job and does not admit another URL. Inactive pause/cancel are no-ops. Active plans
cannot be discarded, including through generic retained-record disposal. Removing a
settled plan preserves independently owned previews, receipts and ordinary library
chapters. Original input files and existing library data are not deleted.

## Persistence and honest availability

Plans use the existing OS-encrypted seven-day/256-record/1-GiB shared catalog.
Image previews remain thirty-minute session-only capabilities with their original
500-candidate/128-MiB-per-source/ten-preview/256-MiB shared limits. A prepared plan
survives restart; frozen image bytes do not. View explicitly reports ready versus
preview_unavailable, imported, failed and interrupted. Review-required is not a claim
that a chapter was saved. A historical import receipt is not current content equality.

At most thirty scan attempts and thirty run requests are recorded per plan. The
attempt budget must cover its initial source count. A rejected/failed attempt is not
silently removed from that budget. Prepare/read/restart and replay never browse.
The retained run ledger also handles a lost separate operation journal without
another network call. Only a bounded lookup reference enters the job journal; no
image payloads, discovered lists or filesystem paths are copied there.

Import receipt reconciliation is NOT permanent source URL/content deduplication.
If a receipt is discarded before the plan reconciles it, absence cannot prove that
an import never happened. Explicit rescan acknowledgement calls out this risk.
Already reconciled historical receipt data remains in the plan. New independently
prepared sources still need the remaining persistent provenance/deduplication work.

Scan intent is saved before network work. Native cleanup settles before result
checkpointing; final completion remains running until encrypted publication finishes.
If the result checkpoint fails, the retained intent stays interrupted and requires
explicit retry rather than an automatic network call. Recording admitted failure
progress after revocation does not authorize another scan or a library change.

## Verification completed before final recheck

The initial connected suite passed 21 cases across four files, including existing
single-input import and chapter discovery. The expanded run passed 23 cases across
six files: all fourteen new batch cases plus existing import HTTP and research-job
reference tests. TypeScript Electron checks passed. Tests use real native library,
source staging, transaction, retention, operation and OAuth/HTTP implementations;
only established browser/provider, image decoder and test-encryption boundaries are
substituted. There was no live website, real-user manuscript or client test.

Coverage includes fixed order, partial failure and chosen retries, duplicate/credential
URLs, foreign owners, changed request/version, exact expiry, discovery ownership,
discovery disposal, native selected-page import, receipt recovery, missing job history,
checkpoint loss, pause/cancel cleanup, attempt budgets and delayed final encryption.
The real OAuth grant is revoked during native metadata publication to verify that
record and catalog roll back together. Rejected requests preserve ordinary library data.

The first complete repository run at `7fc012f03f1d3d24140416fc51f757fb2228ee41`
passed 8,245 cases with one failure and eleven inherited skips. The only failure was
the exact inventory test for six as-yet-unregistered production modules. That failed
run remains separate evidence, not final completion. The six V8-measured records
were then added without changing any of the 1,726 inherited records, provenance or
deletion entries. The existing exact coverage gate passed with 1,732 records.

Measurement: `.tmp/mcp-import-batch-initial-coverage.json`, SHA-256
`a6a17d7089dedaa27e2343b956a4b01c79f04910749704071bd844707cadea99`.
Source, totals/covered counts and ratios are in
`.tmp/mcp-import-batch-coverage-registration.json`. All six new module function
coverages were 100%; line, statement and branch coverage retain their actual measured
ratios rather than claiming all are 100%. No exclusion or lowered inherited floor.

Six measured direct dependency counts are documented in the architecture budget.
They reuse the existing lock, fingerprint, typed error, tool boundary and output/job
contracts; global budgets remain unchanged. The duplicate gate passed with zero new
clones. Obsolete local/remote formatting conflicts were resolved within the existing
branch with saved commits; no force push or new branch was used.

## Native and live-test distinctions

The earlier actual-Electron chapter-discovery harness change remains unapplied and
unverified. It is not retried through another execution path. The existing native
smoke script is unchanged from the starting checkpoint. A later run of that legacy
script can establish regression coverage only, not new positive live-browser or
multi-URL batch acceptance. Final results must distinguish those scopes.

The running user app, artwork/library, credentials, model assets, Tailscale and OS
security settings are not changed or restarted. No master merge or release. Live
acceptance remains deferred until all bundles are implemented.

## Exact remaining bundle 10 work

Next: reviewed multi-URL library publication and destination progression, persistent
source URL/content history and fresh-preview deduplication/new-chapters-only import.
Then native library naming/order/move/delete/recovery and incoming general attachment
bytes/working-file exchange. Existing selected-page import remains available for each
prepared preview. Do not start bundle 11 or rebuild completed import/retention machinery.

## Final verification

Verified source/test/configuration: `065306c92b9201ca10fdaf98d6f09f3e7856193e`.
All 26 repository gates passed with actual process exit zero: **8,248 tests passed, zero failures and 11 inherited skips**. The MCP subset passed **1,406 cases across 231 files**. The 5 new batch files passed 16 cases.

Renderer/Electron/JavaScript type projects, lint, formatting, architecture,
maintainability, duplicate/dead-code checks, exact coverage inventory/floors,
Windows build, native artwork parity, image protocol and renderer/preload checks
passed in one full sequence. The supported process-local eight-worker setting was
used; checked-in worker defaults, test timeouts and inherited skips were unchanged.
All 1,726 inherited coverage records and provenance remain identical to 6559bfb1;
six measured additions bring the exact inventory to 1,732.

The second full run still failed the same inventory test because its fixed added-file
count remained 972 after six registrations. Only that count became 978; exact list,
provenance, deletion and coverage comparisons stayed enabled. The standalone inventory
test then passed all 27 cases. The third full run passed 8,246 cases at 218b90b8,
but an additional two-case real-library regression then exposed an availability
classification defect. That passing earlier run is not substituted for the fourth
full run of the correction, which supplies the final evidence below.

The old boolean availability adapter collapsed native importing/imported states
into missing/expired. Two tests reproduced imported status becoming unavailable
and an unnecessary rescan after separate receipt disposal. The adapter now preserves
ready/importing/imported/unavailable explicitly. Native known imported state remains
visible even when its receipt was discarded, and live/used previews cannot pass the
unavailable rescan guard. This in-session knowledge is not permanent source history.
Reproduction: .tmp/mcp-import-batch-preview-state-repro.log (two failures); corrected
batch regressions: .tmp/mcp-import-batch-preview-state-fixed.log (sixteen passed).

Gate interval: `2026-09-20T19:05:31.420Z` through `2026-09-20T19:10:53.485Z`.
The unchanged existing Electron smoke was rerun after those gates against the same
verified source. Its actual child exit code was zero; required selected-import and
completion markers were present, and isolated port 38696 was closed.
This is existing native import/OS-encryption/receipt/replay/rendering regression
coverage, NOT positive real-browser chapter-discovery or multi-URL acceptance.
New batch integration tests substitute the established browser boundary. No live
website, user manuscript, public tunnel or chat client test was performed.

All 25 changed source/test/configuration hashes captured before the final run still
matched after native completion. Subsequent publication changes are documentation
only and must compare identical to the verified source for src/tests/scripts.

Evidence: `.tmp/mcp-import-batch-full-check-4.log`,
`.tmp/mcp-import-batch-final-evidence.json`, final-vitest.json, final-coverage.json,
final-timings.json and verified-source.json with the same prefix. Legacy native
logs/results use mcp-import-batch-legacy-native; initial/second failure artifacts
and measured coverage registration remain separately preserved.

Bundle 10 remains in progress. Resume at reviewed bulk library publication and
persistent source identity/deduplication, not another preview engine or bundle 11.
