# Bundle 10 continuation: persistent selected-input identity

Latest continuation: `mcp-library-organization-checkpoint-20260921.md`. Work/chapter
names and complete chapter order are connected with atomic metadata recovery; all
26 gates pass at `d694f439`. Dedicated organization-native/renderer verification and
remaining page-order/move/delete/general-input work stay explicit. Historical source
identity implementation and verification below are preserved.

Status: IMPLEMENTED, REGISTERED, ALL 26 REPOSITORY GATES AND DEDICATED ELECTRON
SOURCE-HISTORY VERIFICATION PASSED. Bundle 10 as a whole is NOT complete.
Verified source/tests/configuration: `0d77b62a1b9d5db44a20a07f4d2e8b346d062314`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
The previous reported publication checkpoint was `4d528c18`. The interrupted
source-history implementation and its committed fixes were preserved, not recreated.

## Connected public behavior

`carrot_get_import_duplicates` is a registered read-only, owned-preview inspection
of explicitly selected draft/page IDs against one reviewed destination. It does
not browse, run OCR/models, decode existing artwork, publish chapters or create a
second history store. It hashes selected input from the existing captured preview
and reads native chapter metadata. The strict output inventory is now 172, up
from 171. Inspection requires read scope and the original preview owner; publication
still requires the existing edit/process permissions and explicit native preparation.

Results distinguish `known-content`, `known-url` and `unseen`. Matching chapter IDs
and in-preview draft IDs are returned; hashes, local paths and original image bytes
are not. Up to 25 matching chapters are shown per selected draft, with the complete
matching count reported separately. Titles and filenames are not duplicate proof.

The existing standalone and grouped import commands accept optional
`duplicatePolicy: reject-known`. They recheck recorded source identities and
collisions within the selected group before and at native publication. A collision
rejects the WHOLE selected transaction. Nothing is silently omitted, overwritten
or imported as a partial success. Review first, explicitly omit known drafts/items,
and publish only the selected unseen chapters. This is the new-chapters-only path,
not an unattended rule that drops updates or unreviewed images.

`duplicatePolicy: allow` and legacy omitted policy preserve intentional repeat
imports. The optional field has no default insertion, so old request fingerprints
and completed receipt replay remain compatible. Existing URL preparation, explicit
rescan/retry, grouped publication and original image validation remain in use.

## Native historical identity

The ordinary chapter metadata stores validated optional `importSource`: version,
ordered selected-input SHA-256, original selected page count, and a canonical URL
SHA-256 for web inputs. Native captured input derives these fields, never the MCP
caller. The identity joins the original chapter creation transaction; rollback
cannot publish source history without its chapter. Plain URLs and filesystem paths
are not stored in this provenance field. The separate batch may still retain its
reviewed URLs in the existing encrypted plan, as before.

This chapter metadata does NOT expire with the seven-day receipt or plan. Native
work/chapter renaming, page reordering and processing-state saves preserve it.
Removing a page does not rewrite the historical input count; removing its entire
chapter removes that chapter's provenance as well. There is no hidden permanent
archive of deleted chapters. History is not an assertion that current pages are
present, unchanged, correctly translated or a complete copy of the source website.

Names, filesystem paths and ZIP compression do not define content identity. ZIP
comparison uses the selected member bytes via the original bounded archive reader.
Selected subset and order DO matter. Re-encoded images with equal-looking pixels
are not necessarily equal bytes; no perceptual matching is claimed. A known URL
with different bytes may mean an update, reordered pages or another subset, and
is reported separately instead of silently skipped or overwritten. Distinct URL
query strings remain distinct; fragments do not establish another chapter.

Inspection is bounded to one destination work, at most 2,000 chapters. Missing,
malformed or over-limit history is rejected instead of reported as unseen. Older
or externally imported chapters without identity are explicitly counted as
untracked. No old artwork backfill or global cross-library matching is performed.
A new destination has no existing history, but collisions among its selected drafts
are still checked. One duplicate query reviews one preview; grouped publication
also checks selected previews against one another.

## Reservation and compatibility corrections

Frozen input is reserved during identity inspection and publication, but these
are distinct states. Inspection reports `checking`, publication `importing`, and
finished input `imported`; all propagate through ordinary preview and retained
batch output contracts. Concurrent consumption/disposal is rejected while checking.
Inspection success or failure releases only its own reservation. Merely checking
never increments a batch version or claims that a chapter was imported.

The original chapter file schema, hydration and lightweight summary reader accept
validated optional history without exposing it in public library summaries. No
separate importer, GPU queue, renderer, authentication flow or storage authority
was introduced. The existing native result harness now validates the canonical
registered output contract: a successful get_job response containing failed-job
metadata is not confused with a failed tool call. That correction does not change
production errors or make a rejected import successful.

## Final repository verification

All 26 gates passed with actual process exit zero at the verified source:
**8,283 tests passed, zero failures and 11 inherited skips**.
The MCP subset passed **1,441 cases across 247 files**.
The nine new source-history test files contribute **17 passing cases**.

Renderer/Electron/JavaScript type projects, lint, formatting, error handling,
architecture/maintainability, duplicate/dead-code checks, test boundaries, exact
coverage inventory/floors, Windows build, native artwork parity, image protocol,
renderer and preload checks passed in one complete sequence. The supported
process-local eight-worker option was used; checked-in defaults, timeouts and
inherited skips were not changed. No failing full run is replaced with focused-only
success. The last added native-edit/history/batch focused run passed six cases in
three files, plus scoped lint and Electron types.

Tests cover expiry/reconstruction and discarded receipts; renamed and ZIP inputs;
URL/content/subset/order distinctions; unseen-only selected batch publication;
foreign ownership and OAuth/HTTP; captured source corruption; late permission,
destination and history changes; bounded/missing history; checking reservations;
and real native naming, ordering, page removal and processing-state transactions.
Rejected requests preserve original source files and unrelated library content.
Unit integrations substitute only established external browser/image-decoder and
OS-encryption boundaries; native files, transactions and registered tools execute.

All **1,734 inherited coverage records, provenance and deletion entries remain
unchanged**. Four measured new modules and the newly touched existing
`libraryChapterSummaries.ts` bring the exact inventory to **1,739**. The latter
uses its historical recorded baseline, not a lowered current measurement.
New-module measurement source: `3d54ef44`; artifact SHA-256:
`2910953253af56a75582ba5baeb36c5441d006ab7a3f8ac99968922b95891973`.
Initial duplicate-inspection floors are 91.66% lines, 92.3% statements, 100%
functions and 86.36% branches; the other three new modules measured 100% in all
four metrics. All are enforced by the final full check; no coverage exclusion.

Earlier fixture type, unsupported Promise helper, missing inventory and native
result-classification failures remain in their original separate logs. They were
corrected using existing schemas, deferred fixtures and result validation, not
weakened compiler targets, suppressed checks or production fallbacks. The latest
resumption added native mutation-preservation tests and reran the entire repository.

Final full-gate interval: `2026-09-20T22:34:35.655Z` through
`2026-09-20T22:39:22.056Z`. Evidence in the review worktree:
`.tmp/mcp-import-source-resume-full-check.log`,
`.tmp/mcp-import-source-resume-final-evidence.json`, final-vitest.json,
final-coverage.json, final-timings.json and verified-source.json with that prefix.
The original measurement and previous runs keep their mcp-import-source prefix.
All 37 changed source/test/configuration hashes matched before and after completion.
Final documentation commits must compare identical for src/tests/scripts.

## Actual Electron verification

The existing native harness, including the dedicated persistent-source-history
scenario, passed again at EXACTLY the same verified source. Actual child exit was
zero; all four required markers were present (selected import, grouped publication,
persistent source history, final smoke completion). The isolated listener on port
38699 was confirmed closed.

The source-history scenario imports a real PNG, disposes its separate encrypted
receipt, reconstructs MCP sessions, prepares a fresh input, identifies the known
source and rejects publication with `invalid_edit`. Current library contents and
original/imported bytes remain unchanged. Image validation, native provenance,
ordinary publication and OS-encrypted receipt handling execute real app code.
Native file selection is automated, and grouped browser collection remains
synthetic. This is not positive live-website/browser discovery acceptance, an
actual user-app restart or a power-loss test. Archive tests establish bounded ZIP
member comparison, not successful conversion of every PDF/RAR/native format.
Evidence: `.tmp/mcp-import-source-resume-native.log` and
`.tmp/mcp-import-source-resume-native-result.json`.

## Exact next work and user-data boundaries

Source history and reviewed duplicate rejection are finished. Resume bundle 10 at
library naming/order commands and their current-state/publication/recovery checks.
The existing `libraryMutationFacade` and `libraryMutations` own native naming/order;
the new preservation tests characterize their treatment of historical provenance.
Then add separately reviewed move/delete/recovery and general incoming attachment
bytes/working-file exchange. Do not implement a second library or expose arbitrary
paths, native serialized requests or unrestricted deletion through MCP.

Existing import limits remain: at most ten selected chapters/fifty pages per
publication; input previews remain thirty-minute session-only capabilities with
shared source budgets. Plans/receipts use the seven-day/256-entry/1-GiB catalog;
ordinary imported chapters and their provenance do not expire with that catalog.

The running user app, real artwork/library, credentials, model assets, Tailscale
and operating-system security settings were NOT modified or restarted. Only
isolated test fixtures exercised mutations/removal. No new branch, master merge
or release. Live original/model/site/client acceptance remains deferred until all
bundles are implemented. Do not redo completed import preparation/publication or
advance to bundle 11 while these bundle 10 items remain.
