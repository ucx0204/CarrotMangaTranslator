# Bundle 11: native editable working-file output

Status: IMPLEMENTED AND AUTOMATICALLY VERIFIED; BUNDLE 11 REMAINS IN PROGRESS.
Verified source: `a710c0b8f4b81b136354b5696bc2ea5ffccd262a`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
GitHub owns source/test/document writes; Remote Desktop Commander verifies them.
Preserve the running user app, original library, credentials, model assets and
Tailscale settings. Live acceptance remains deferred until all bundles are implemented.
This checkpoint records local isolated evidence, not a GitHub CI or release claim.

## Connected public flow

`carrot_preflight_work_file_export` accepts an existing work ID and an explicit,
unique selection of one to ten complete chapters. It reports saved titles, native
chapter/page order, page revisions, block and processed-image counts, style-guide
inclusion, source-image bytes, entry count and output limits. Its `snapshot` binds
the saved editable metadata and selection; `sourceSnapshot` binds original and
processed image evidence. Preflight does not reserve an execution slot or promise
that the compressed archive will fit before the bounded native write completes.

`carrot_export_work_file` requires that reviewed selection and both snapshots, a
UUID request ID, `acknowledgeOriginalImages: true` and
`acknowledgeV1Limitations: true`. It uses the existing owned page-export job
lifecycle. The application service calls ports; the native adapter captures the
saved work and delegates to the existing streaming share writer. There is no
second archive serializer, automatic model execution or directory-picker shortcut.

Poll `carrot_get_job` for job state. Retrieve a completed file explicitly through
`carrot_get_job_file`. Its allowlisted native-file projection uses filename
`carrot-work.mgtshare` and application MIME `application/vnd.carrot.mgtshare`.
That MIME is the app's internal MCP contract, not a claimed registered standard.
The projection includes byte size, SHA-256, expiry, access wording and reviewed
work-file metadata; internal paths and source evidence are not disclosed.
Job polling and persisted journal entries do not expose file URLs or attachments.

The same private retained-output catalog publishes the completed native bytes.
After client/session reconstruction, `carrot_get_output_file` issues a new
short-lived capability to those same bytes. It does not run the native writer
again. `carrot_discard_retained` revokes the owned retained record and later access.
Generation, link issuance and a server response do not prove client receipt.

## Native content and explicit limits

The output preserves the selected saved work/chapter titles and reading order,
supported editable blocks/formatting and references, original images, stored
processed images and the work style guide according to native `.mgtshare` v1.
An empty selected chapter is allowed when the total selection contains at least
one page. Work-wide style-guide content can contain information beyond a selected
chapter and is explicitly disclosed during preflight.

V1 omits local masks, chapter memory, jobs, undo history, profile settings,
internal translation checkpoints and font continuity. Fonts are not bundled.
Only saved data from the selected complete chapters is packaged. It is an editable
native exchange file with those limits; it is not a complete profile backup.

Limits are one to ten chapters, one to fifty total pages, 2,000 native entries,
128 MiB per output file and 256 MiB expanded archive content. The existing artifact
session also reserves at most 256 MiB across concurrent outputs. Native streaming
limits are checked while writing, so a changing source cannot produce a multi-GiB
archive before a final size check. The native writer's ordinary defaults remain
unchanged when the optional export limits are omitted. No silent truncation,
downscaling, format substitution or partial selected-chapter package is used.

Output-size/hash verification rejects growth during hashing and same-length file
replacement before publication. Owned partial files are removed while unrelated
session outputs remain. Source mutation, page/activity ownership, image permission,
redaction, cancellation and session closure are rechecked at their existing
boundaries. Retained publication, reissue and streaming independently verify the
saved work/chapter/order/style-guide binding and page/file evidence. A missing
saved style-guide file has a stable default-content binding rather than relying
on newly generated top-level timestamps.

## Exact current automated evidence

The complete canonical repository check ran on the verified source with eight
workers and unchanged test timeouts and thresholds. All 26 stages passed with
actual child/wrapper exit zero in 350.476 seconds. It executed 1,150 test files and
8,684 tests: 8,673 passed, zero failed and 11 inherited pending tests.

Global V8 coverage was statements 84.92% (85,405/100,570), branches 77.92%
(54,557/70,010), functions 87% (22,590/25,965) and lines 86.12%
(79,965/92,850). The inherited production-cleanup coverage gate passed.
All 1,796 existing floor records, provenance and deletion policy remain unchanged;
five actual measured records bring the total to 1,801 and introduced count to 1,044.
Nine exact per-file dependency allowances were registered; global defaults and
unrelated allowances remain unchanged.

The build was a cache miss and passed in 14.665 seconds. Electron and renderer
inputs were rebuilt. Canonical native-asset outputs were reused only where their
input/output content checks passed; ONNX runtime output was built where required.
Artwork parity, image-protocol, renderer-bundle and preload-bundle checks passed.
All 4,426 tracked source/test/script/configuration fingerprints were unchanged.

## Exact current native evidence

The actual Electron wrapper first verified the successful full-check result,
passed build stage and identical complete source fingerprint. It launched the
canonical smoke with its own userData/sessionData/logs directory and local listener.
Native execution ran from 2026-09-23 13:49:26 to 13:51:31 UTC.

All seventeen required markers passed, including the new sequence:

`registered work-file export -> editable incoming-file roundtrip -> actual HTTP
native bytes -> reconstructed retained reissue -> discard revocation and original
preservation`

The scenario invokes the registered preflight/export tools, polls the real job,
obtains the explicit job-file link and downloads the native archive. It compares
native v1 editable metadata and original/processed bytes, reuses the existing MCP
incoming-file flow for roundtrip import, reconstructs the client/session, and
reissues the same retained bytes without another render or serialization. Explicit
discard revokes download access. Original chapter and saved guide bytes remain.

All sixteen historical markers also passed, including raster and PSD/ZIP retained
reissue, working-file input/append, encrypted recovery and exact 2,000-entry work
recovery. Electron child and wrapper exited zero, no timeout occurred, listener
61906 was closed, and all owned native fixture directories and the isolated profile
were removed. All 4,426 source fingerprints still matched the successful check.

## Evidence locations and preserved failure

Current owned evidence prefix:
`.tmp/mcp-workfile-closeout-20260923-r2`.

- `-result.json`, `-source.json` and `-timings.json`: exact source, process exit,
  all 26 gate statuses and fresh-build metadata.
- `-vitest.json`, `-coverage.json` and `-check.log`: current full-suite counts,
  V8 measurements and canonical gate output.
- `-native-result.json`, `-native-source.json` and `-native.log`: all seventeen
  marker results, exact build/source relation, waited child exit and cleanup.
- `-summary.json`: readable full-check digest and SHA-256 inventory of evidence.

Current coverage-summary SHA-256:
`f08da6713ab1bfe55d47a365cb302f606eb569bc5864b5940973a3d7538f0d10`.

The earlier attempt at `2bafc03988cca33b32a12c921253a414f9ae5b24` failed
`typecheck-js` on the newly lazy translation imports missing explicit `.js`
specifiers under NodeNext. It exited before coverage tests or build; native was
not launched. That failed evidence remains under the prefix without `-r2`.
Any prior Vitest/coverage copies alongside it are not measurements at that failed
source. Four explicit lazy-import specifiers were corrected, and the entire
current check/native sequence was then run at `a710c0b8`.

The earlier complete V8 inventory failure at `e9dc2016` and the focused 41-test
publication/retention gap verification remain historical measurement evidence.
They are not substituted for the successful current full check and native run.

Historical GitHub run [35863622706](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/35863622706)
at `e9dc2016` completed with failure. Its focused 1,836 tests across 336 files,
build, actual Electron smoke and production screenshots passed. The static/full
path stopped at the same nine architecture allowances before coverage, in 30.11
seconds. Those exact allowances were subsequently registered. This partial CI
evidence is preserved as a failed run, not presented as an all-gates success.
The `a710c0b8` CI run was automatically cancelled by the subsequent source push;
the completed local check/native sequence above is the authority for this source.

## Resume point

Working-file output, PSD and prior raster/ZIP output are complete automatic
development slices of bundle 11. Continue source-format selection, reviewed
text/context exchange and delivery diagnostics/approved output synchronization.
Keep bundle 11 in progress until those remaining slices are implemented and
verified; bundles 12 and 13 follow in order. Do not request live acceptance between
these units. Real client attachment receipt, model quality and maximum-size live
transfers remain in the final integrated acceptance queue.
