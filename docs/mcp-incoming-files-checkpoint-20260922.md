# Bundle 10 continuation: incoming files

> Superseded for verification and next work by
> `mcp-incoming-files-integration-checkpoint-20260922.md`.
> The following records the earlier incomplete integration and its behavior.

Status: CONNECTED; FULL TEST SUITE, BUILD AND NATIVE PASSED; WHOLE CHECK STILL FAILS ARCHITECTURE.
Verified source/tests/configuration: `b583c8046e2753857dd77fd95df42b5d702affce`.
Starting checkpoint: `0e0f0c64`. Bundle 10 is NOT complete.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Four architecture integration exceptions and native working-file import remain.
No live user-library/client tests, user app restart, model/auth/Tailscale changes,
master merge, additional branch or release. Do not start bundle 11.

## Connected public behavior

Six tools are registered in the actual import session and strict output inventory
(205 to 211): `carrot_begin_file_upload`, `carrot_write_file_upload`,
`carrot_finish_file_upload`, `carrot_get_file_upload`, `carrot_discard_file_upload`,
`carrot_prepare_uploaded_import`. General files are not page-edit capabilities.
Reads require read scope; transfer/preparation requires read+edit+process and the
existing editing/processing preferences. No image-transfer grant is implied.

The client sends actual bytes, declared size/SHA-256 and a bounded display filename.
Only generated native paths are used. Names are untrusted data. No arbitrary local
path, URL fetch, opaque attachment handle or automatic chat-file access is accepted.
The host must actually deliver bytes. Receiving a filename is not file transfer.
This is a bounded MCP byte-transfer path, not automatic ChatGPT attachment ingestion.

Transfer is ordered canonical base64, at most 32 KiB per chunk, 4,096 chunks/file,
128 MiB/file, 16 files and 256 MiB reserved bytes per general-input session, 256
request receipts and a fixed thirty-minute session lifetime. The largest file needs
full-size chunks; many small chunks do not evade the chunk count. Large inputs need
many transport calls. Exact repeated chunks/requests reuse acknowledged state;
altered repeats, gaps and overflow reject. Declared size reserves capacity before
arrival. The general-input quota is separate from the existing image-editing pool.

Finish stream-checks file length and SHA-256 without buffering a whole archive.
`ready` / `bytes-verified` is explicitly NOT format/importability/malware validation.
Upload metadata reads do not revalidate or renew expiry. Temporary incoming files
are ordinary owned staging, not durable encrypted recovery archives.

`prepare_uploaded_import` takes an owned ready upload ID, kind and explicit
native-preparation permission. The existing image/archive/PDF preview and frozen
capture pipeline is reused, with uploaded bytes checked before and after preparation.
PNG/JPEG/WebP and ZIP/CBZ/PDF/RAR/CBR filenames are accepted; malformed inputs may
still fail. PDF/RAR retain the existing native-runtime preparation consent. No local
picker, model execution or library publication is implicit.

A frozen preview owns independent copies. Expiring/discarding the upload after
successful preparation does not destroy that preview. Existing preview inspection,
selection/order, duplicate review and `carrot_import_chapters` publish through the
same native importer, source-history identity, transaction and encrypted receipt.
Preview/receipt source remains `local` (no web provenance); a warning distinguishes
uploaded bytes from native selection. No new import receipt format or job engine.

Preview lifetime is still thirty minutes/session only. Normal imported chapters and
their separate same-profile/approved-owner retained receipts survive upload disposal
and session reconstruction. Existing receipt retention and publication selection
limits are unchanged. Historical publication replay does not create another chapter.

## Existing image-upload compatibility

Page-bound PNG/mask uploads reuse the extracted byte lifecycle but retain all
page/context, structure/CRC, raster and binary-mask validation, original input/output
schemas and their 32-MiB-file/128-MiB-session/32-file limits. General inputs cannot be
applied as image edits. Native file length/path/identity checks remain shared.

A regression introduced during extraction temporarily cached the decoder's complete
PNG object instead of only its two validation fields. The actual-cache test failed
before correction. Decoded pixels are now released after validation; only transparency
and selected-mask-pixel metadata remain cached, matching the previous behavior.
No decoder or upload authority is mocked. The test observes retained memory state,
not nondeterministic garbage-collection timing. Evidence:
`.tmp/mcp-incoming-raster-{baseline,fixed}.log`.

## Reproduced cleanup bug

Closing a browser provider could fail before the separate incoming upload store
was closed, leaving an owned temporary file. The actual-file regression fails at
`75c69ad3` before the fix and passes after ordered all-stage cleanup was connected.
Original cleanup errors are aggregated, not converted to success; independent
upload cleanup is attempted even if an earlier provider fails. Native source files
and imported library data are not deletion targets. Evidence:
`.tmp/mcp-incoming-cleanup-{baseline,fixed,final}.log`.

## Final verification, including the unresolved gate

At the verified source, the FULL Vitest/V8 suite passed **8,524 tests**, with **zero
failures and 11 inherited skips** (8,535 total). MCP: **1,670 cases / 303 files**.
This continuation adds **27 cases / six files**. These counts overlap.

The new tests cover ordered/exact chunk retries, wrong hashes, gaps/overflow,
noncanonical base64, ownership, fixed expiry, quota reservation, active consumer
leases, real-file tampering, malformed/unsupported filenames, ready-vs-importable,
PNG and ZIP/CBZ selection, wrong kind/foreign preparation, source-history duplicate
rejection, preview independence, server stop, atomic receipt failure and usable retry.
Actual OAuth/HTTP upload-to-import and reconstructed receipts also pass.

Renderer/Electron/JavaScript type projects, lint, format, error handling, test
boundaries, maintainability, duplicate/re-export/generated/CSS/script checks and
unused-code checks passed. The clone baseline remains 32 known/zero new. The complete
26-gate command is STILL FAILED: 18 other started checks passed, architecture failed,
and its downstream gates were not executed by that failed orchestration. The full
suite, exact coverage, Windows build, artwork parity, image-protocol smoke and
renderer/preload checks were run SEPARATELY and each returned zero at the same source.
Those successes do not change the whole-check failure into a pass.

Outstanding direct-dependency counts are:

- `mcpJobJournal.ts`: runtime imports 16, current ceiling 15.
- `mcpBatchTool.ts`: direct consumers 35, current ceiling 34.
- `mcpOutputSchemas.ts`: runtime imports 37, current ceiling 36.
- `mcpLibraryImportSession.ts`: runtime imports 15, current ceiling 12.

A tool request to record these exact dependency exceptions and prepare verification
wrappers was blocked before execution. It was not applied through another tool.
The architecture manifest and global limits remain unchanged. Resolve the legitimate
composition integration explicitly; do not hide dependencies in forwarding wrappers.

All **1,781 inherited coverage records**, provenance and deletion entries are
unchanged. Four actual Windows/V8 measured modules were added, totaling **1,785**.
The old image adapter still measures 100% in all four metrics. The extracted lifecycle
uses measured initial coverage, not a lowered inherited floor. Measurement source:
`20b25ba3`; its run failed ONLY the then-unregistered inventory (8,521 passed, one
failed, 11 inherited skips). The initial wrong native-summary assertion was corrected
to inspect the real chapter collection; no production behavior changed for that.
The supported process-local eight-worker option was used; default concurrency,
timeouts, existing skips and global thresholds were not relaxed.

## Actual-Electron result

The NEW incoming-file scenario is actually invoked by the existing native import
smoke and reuses its job waiter. It sends real PNG chunks, checks byte verification,
prepares without invoking the picker, discards the upload, imports through native
image validation/storage/OS encryption, reconstructs MCP clients, replays the same
publication, reads its retained receipt and discards only that receipt. Original
image bytes, empty blocks and persistent import-source history are checked.

All **12 required completion markers** were present. The actual waited Electron
child **7688 exited 0**, and its isolated listener **55062 was closed**. The same run
also passed prior import/deduplication, organization, page-order/page-deletion,
chapter deletion/movement and exact-2,000-entry work-recovery scenarios.

An earlier direct PowerShell launch yielded no captured markers despite a zero
shell status. It is NOT counted as a native pass. Its unverified evidence is retained
under `mcp-incoming-pre-raster-*`. The final run explicitly waited for the actual
child and separately collected stdout/stderr before checking every required marker.

Native image validation, library publication and OS encryption are real. The NEW
native input is PNG; ZIP selection is exercised by actual-filesystem automated tests.
JPEG/WebP/PDF/RAR full conversion success was NOT independently demonstrated here;
PDF/RAR permission denial was tested. No full 128-MiB upload benchmark is claimed.
Existing browser, picker and renderer-state replies are fixture boundaries. This is
not live model/site quality, user-app restart or `망번테스트`/chat attachment acceptance.
No production renderer layout changed and no new screenshot is claimed.

## Evidence and exact resume point

Evidence uses `.tmp/mcp-incoming-`: final-source/check-result/evidence.json,
final-check/suite/build/floors.log, final-vitest/coverage/timings.json,
native-stdout/stderr.log, final-native-result.json, final-parity-result.json and
coverage-registration.json. Initial measurement, both failing regressions and the
unverified native attempt are kept separately. All **23 source/test/configuration
hashes** matched after final suite/build/native/parity verification. Final docs-only
commits must leave `src`, `tests` and `scripts` identical to the verified source.

Next: resolve the four architecture integration exceptions and rerun the complete
26-gate command. Then implement native `.mgtshare` working-file import through the
distinct existing share workflow; it is NOT implemented by this image/container
transfer slice. Do not flatten editable working files or silently discard context.
No completed deletion, recovery, movement, naming/order, import/deduplication or
synchronization work should be rebuilt. No bundle 11 or live testing yet.
