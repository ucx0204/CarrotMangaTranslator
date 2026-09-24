# Bundle 10 continuation: reviewed chapter-link discovery

Latest continuation: `mcp-import-batch-checkpoint-20260921.md`. Multi-URL
preparation/progress/retry is now connected and verified; automatic bulk library
publication, permanent source deduplication and other bundle 10 work remain. The
historical discovery implementation and verification below are preserved.

Status: IMPLEMENTED, REGISTERED AND ALL 26 REPOSITORY GATES PASSED.
Starting source: `a736dec2` on `feat/mcp-app-bridge`. Bundle 10 is NOT complete.
Preserve the verified native-file/single-URL importer and bundles 1-9.

## Implemented public surface

Four tools are composed through the existing import session and job admission:
`carrot_discover_chapters`, `carrot_get_chapter_discovery`,
`carrot_list_chapter_discoveries`, and `carrot_scan_discovered_chapter`.
The strict output inventory is 163, up from 159. New network work requires explicit
allowNetwork and the existing read/edit/process scopes. Owned metadata reads require
read scope only. Existing approvals are not automatically expanded.

Discovery opens one explicitly requested public HTTP(S) page with the existing
isolated WebImportSessionManager. Its canonical page loading, DNS/redirect guards,
secure window, scrolling, timeout, cancellation and teardown are shared with image
scans. It inspects at most 20,000 top-document elements and 5,000 anchors, retaining
up to 200 candidates (default 100), optionally filtered by literal pathname prefix.
Same-origin links remain in document order; fragments are deduplicated but distinct
query strings are not merged. Normal page subresources may load, but discovery does
not follow candidate links or prepare image candidate files.

Candidates are not verified chapters or exhaustive access. Iframes, shadow trees,
next-page clicks and authenticated sessions are not traversed. Website labels remain
untrusted text, not tool instructions. Every result reports exhaustive=false and
separately reports truncation and skipped invalid/off-origin/duplicate/filtered links.

An immutable discovery record, fixed snapshot and stable link IDs use the existing
seven-day/256-entry/1-GiB encrypted catalog. Lookup is paginated at 25 candidates.
Reconstruction and same-owner/request replay reuse the retained record instead of
browsing again, including when the operation journal has been lost. Altered request
contents, owner mismatches, forged IDs and stale pagination snapshots are rejected.
The job journal stores only a bounded lookup reference, not the discovered list.
A reference is not proof that the underlying record still exists or is unexpired.

Selected-link scanning resolves the reviewed stored URL and calls the existing web
image preview service. It still requires explicit page selection and the existing
carrot_import_chapters call. It does not automatically import or run remaining links.
Image previews remain thirty-minute session-only inputs. Native importer, image
validation, frozen source evidence, atomic import receipts and originals are unchanged.
Generic carrot_discard_retained removes discovery metadata only; it neither deletes
imported chapters nor cancels a separately admitted scan job.

## Verified so far

The expanded focused suite passed 87 cases across 15 files. It includes actual DOM
script execution in jsdom, native browser-boundary cancellation/redirect/navigation
checks, real library staging/transactions, encrypted test-codec reconstruction,
repository replay independent of the job journal, selected-link/page import, record
integrity, exact expiry, catalog disposal and real OAuth/HTTP revocation at publication.
Existing import, research-reference and output-contract tests also passed.
Evidence: `.tmp/mcp-chapter-discovery-expanded.log`.

The initial browser-commonization run passed twelve inherited web/import cases.
A later 51-case run passed before final lint/type-cycle cleanup. The real OAuth/HTTP
fixture was extracted without removing assertions and reused by import and discovery.
The new job-reference policy groups actual result-to-command identity checks; it does
not create a second job store or weaken original research/import consistency checks.

Seven direct dependency counts are recorded with canonical-use reasons. Global
architecture limits are unchanged. Existing coverage floors/provenance must remain
identical to a736dec2; only measured new production modules may be registered.
Final whole-suite results and measured coverage preservation are recorded below.

## Native verification limitation

A request to connect an additional actual-Electron chapter-discovery scenario to
the smoke harness was rejected by the tool safety check before execution. That
connection was not applied or resubmitted through another tool. The unconnected
native draft was removed. scripts/mcp-electron-smoke.cjs is unchanged from a736dec2.
There is NO successful actual-Electron chapter-discovery execution claim here.
Existing native artwork/build gates, if passed, are separate from this pending
scenario. Browser/session and OS encryption boundaries in unit integrations are
substituted; real live websites and the user's client are not tested.

## Exact remaining bundle 10 work

Next finish the isolated actual-Electron discovery scenario and bounded sequential
multi-URL execution, per-URL progress/failure and explicit resume through the existing
importer. Then add durable source URL/content history and deduplication across fresh
previews, including new-chapters-only selection. This discovery slice itself does
not provide source history, bulk execution or unattended resume.

Library naming/order/move/delete/recovery commands, incoming general attachment
bytes and native working-file exchange still remain. Do not start bundle 11, redo
bundles 1-9, duplicate the importer/store/GPU queue, or imply all bundle 10 is complete.

The running user app, artwork/library, credentials, model assets, Tailscale and OS
security settings are not changed. No master merge, release or new branch is made.
Live manuscripts, model quality and client acceptance remain deferred until all
bundles are implemented. The final verification evidence is recorded below; live acceptance remains deferred.

## Storage consolidation and retry correction

The duplicate-code gate identified matching zero-page metadata publication in the
new discovery repository and existing research-batch repository. Both now use
McpRetentionStorage.stageMetadataRecord for the existing prune/create/encrypt/index
transaction. Domain validation, current ownership and research beforePublish work
verification remain in their original callers. The shared storage/research/discovery
regression run passed 39 cases across nine files. No duplicate baseline was relaxed.

Moving covered storage lines initially lowered the existing research repository's
line/statement coverage ratios. Its inherited floors were NOT changed. The added
real-library metadata-publication test now covers repeated admission without another
verification, mismatched request contents, invalid settings transitions, mismatched
index timestamps and foreign-owner disposal. The final full coverage gate passes.

A page-only retry of failed importPrepare/importCreate/importDiscover jobs previously
fell through to a page schema and threw raw ZodError. All three failures were
reproduced in .tmp/mcp-chapter-discovery-retry-repro.log. retryTarget now explicitly
accepts only its six supported page operation kinds and returns typed invalid_edit
for other jobs before parsing or executing. Callers must inspect the original import
receipt or discovery and issue the appropriate explicit operation. No browsing or
import is repeated by this rejection. The final job/retry regression passed 65 cases
across eight files (.tmp/mcp-chapter-discovery-retry-final.log).

## Final repository verification

Verified source/test/configuration: `0af2ce582f803c7f6e103d47e297156d1b12ee10`.
All 26 repository gates passed with actual process exit zero: **8,232 tests passed,
zero failures and 11 inherited skips**. The MCP subset passed **1,390 cases across
226 files**. The seven newly added test files contributed **44 passing cases**.

Renderer/Electron/JavaScript type projects, lint, formatting, error policy, test
boundaries, architecture/maintainability, duplicate/dead-code checks, exact coverage
inventory/floors, Windows build, native artwork parity, image protocol and renderer/
preload bundle checks passed in the same complete run. The existing process-local
MGT_VITEST_MAX_WORKERS=8 option was used; checked-in defaults and the 15-second test
timeout were unchanged. No existing tests were skipped or removed to obtain success.

All **1,720 inherited coverage records, provenance and deletion records remain
identical to a736dec2**. Only six new production modules were registered from measured
V8 totals/covered counts, bringing the inventory to **1,726**. The measurement source
is f78e12b9 and those six modules are unchanged at the verified final source. The
serialized DOM collector really executes in jsdom but its string-evaluated function
body is not attributed to the original source file by V8; its recorded coverage is
65.11% lines/statements, 33.33% functions and 50% branches, NOT 100%. No source-file
exclusion or artificial execution call was added to hide that measurement.

Earlier failed gates (obsolete lint-exception bookkeeping, duplicate publication,
unused export, new-module coverage registration, and a one-line file-length overrun)
remain in separate whole-check-1 through whole-check-5 logs. Their failures are not
relabelled as success. The complete whole-check-6 run is the final evidence.
The obsolete web-import function-length suppression was removed from both source
and its exact policy baseline rather than reintroduced.

Full-gate interval: `2026-09-20T14:08:49.669Z` through `2026-09-20T14:13:42.152Z`.
Evidence: .tmp/mcp-chapter-discovery-whole-check-6.log,
.tmp/mcp-chapter-discovery-final-evidence.json, final-vitest.json,
final-coverage.json, final-timings.json, verified-source.json and
coverage-registration.json with the same mcp-chapter-discovery prefix. Thirty
changed source/test/configuration hashes were captured before the run and rechecked
when it completed. Documentation-only finalization must compare identical to the
verified source before the final commit is certified.

## Existing actual-Electron regression result

After the successful full check, the UNCHANGED existing mcp-electron-smoke.cjs was
run against the same verified source with a separate temporary profile and port 38695. Actual child exit code was zero, both mandatory markers were present
(PASS native selected import -> real image validation; PASS MCP native smoke
finished), and the listener was confirmed closed. This preserves the earlier
native import, OS-encrypted receipt/replay/disposal, research, image and output
regression checks after shared storage and tool registration changed.

The existing harness was not modified to bypass the blocked discovery-scenario
connection. This passing legacy suite is NOT a positive actual-Electron chapter
link discovery/browser acceptance result. That dedicated scenario and live websites/
client behavior remain unverified. No user application or public tunnel was restarted.
Evidence: .tmp/mcp-chapter-discovery-legacy-native.log and
.tmp/mcp-chapter-discovery-legacy-native-result.json. All thirty source/test/config
hashes still matched after native completion; final commits only update documentation.
