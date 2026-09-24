# Bundle 10 continuation: reviewed chapter deletion and exact recovery

Status: IMPLEMENTED AND CONNECTED; ALL 26 REPOSITORY GATES AND DEDICATED ELECTRON PASSED.
Verified source/tests/configuration: `447c2e7ea8edbf59018f28663f7248b903a8e28b`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting connected source: `10291299`; the resumed tree was already at `a575ad0c`.
That interrupted implementation was preserved, not rebuilt. Bundle 10 is NOT complete.

## Connected behavior

Seven tools are registered in the real app composition, permissions and output
contracts (output inventory 178 -> 185):

- `carrot_preview_chapter_deletion`
- `carrot_delete_chapter`
- `carrot_get_chapter_deletion`
- `carrot_list_chapter_deletions`
- `carrot_undo_chapter_deletion`
- `carrot_redo_chapter_deletion`
- `carrot_discard_chapter_deletion`

Preview hashes the ordinary chapter directory and returns names, file/page counts,
source byte count, a bound snapshot and the explicit recovery-expiration warning.
It does not publish, transmit images or return filesystem paths/private content.
Actual removal requires the reviewed snapshot, a new request ID and the exact
`delete-chapter-with-seven-day-recovery` acknowledgement. Read permission is separate
from the existing edit/process permissions; image-transfer permission is not needed.

The chapter directory, INCLUDING its library originals, memory and run files, is
removed only after an encrypted recovery copy is created AND decoded/digest-verified.
The native work-order change, directory retirement, encrypted files/record and
retention index commit in one existing library transaction. A last publication
check verifies the staged copy, written recovery metadata, current chapter/work
state and current approval. External source files outside the chapter directory
are not touched. This is actual bounded library deletion, not merely hiding a row.

Undo restores exact directory file contents, empty directories and original work
metadata; Redo uses the same record. It does not promise inode, ACL or filesystem
creation-time restoration. A missing work or occupied original location is never
recreated/overwritten. Later work/chapter changes block exact recovery. Replayed
requests return historical receipts, including replaying deletion after Undo.
No model, network, OCR, translation, new importer or second job queue is involved.

The original desktop chapter-deletion function shares its prepare/stage logic
with MCP; existing native transaction crash tests preserve its behavior. This does
not add a new desktop trash UI or change ordinary desktop deletion into MCP recovery.

A fresh nonce-correlated trusted renderer probe requires the target chapter CLOSED,
even if it has no unsaved pages. Missing or timed-out probes fail closed. The probe
is connected through actual desktop composition and checked again immediately
before publication. Existing work/chapter/page-content/work-context ownership stays.
New successful changes use the existing metadata-only renderer notification. If
notification fails after commit, saved data/receipt remain and a warning is returned.

## Recovery limits and disposal

At most one chapter, 50 pages, 2000 filesystem entries, 128 MiB per ordinary file and
256 MiB source bytes per request. Existing same-profile/owner seven-day retention,
256-record/1-GiB shared catalog and 32 recovery-action limit apply. Encryption overhead
counts against the catalog quota. Oversized, linked or ambiguous paths are rejected.
This is NOT permanent trash storage. After seven days the recovery may be permanently
pruned; deletion explicitly acknowledges this. No early purge is offered: generic
discard rejects this kind, and dedicated discard requires exact prior restoration.
Discarding a restored record does not delete the restored chapter or external source.

## Additional regressions fixed during final verification

### Encrypted recovery metadata must actually be recoverable

The original byte-copy verification did not prove that the codec's successful return
contained the intended record/index. Two external-codec fault injections returned
valid encryption of incorrect metadata; both initially deleted the source and
reported success. The common existing `McpRetentionStorage` now serializes the
ciphertext envelope as a restarted reader would, decodes it and compares it to the
intended JSON value before staging. Optional-field JSON semantics are preserved;
no plaintext record is written and no cryptographic algorithm was replaced.

A third real-filesystem regression changes an already written staged record during
index preparation. Encryption round-trip alone missed that case. The shared bounded
record reader now verifies the written record, and chapter deletion verifies it
again at the final pre-publication boundary alongside the encrypted file parts.
All three cases now reject without source deletion, retained history or notification.
A subsequent legitimate request can still delete and restore normally.

These are injected failures, not a claim that real OS encryption naturally corrupts
data. Reproductions: `.tmp/mcp-chapter-deletion-metadata-repro.log` and
`.tmp/mcp-chapter-deletion-staged-record-repro.log`.

### Existing PNG timeout cancellation survived only until source collection

A complete repository run exposed an existing `pageExportSecurity.test.ts` failure:
the decoder timeout was reported, but its retained signal was not aborted. The
unchanged file passed alone; that focused result was not substituted for a fix.

On this PC's Node 26.7.0, an isolated process compiling the actual production
lifecycle modules reproduced the failure deterministically when native garbage
collection happened after timeout settlement and before the decoder inspected
its unobserved composite signal. The deadline wrapper now observes the SAME
operation signal supplied to the decoder, preserving cancellation before cleanup
and source collection. The parent is not cancelled by a child deadline.

The original security/cancellation tests, deadlines and assertions are unchanged.
A new child-process GC regression passes with the fix, and the full export/security/
cancellation subset passed 49 cases across four files. No runtime upgrade, dependency
installation, new renderer or global cancellation implementation was introduced.
Evidence: `.tmp/mcp-chapter-deletion-export-gc-test-repro.log`,
`.tmp/mcp-chapter-deletion-export-gc-fixed.log`; earlier diagnostic attempts and the
failed complete run remain separate. A narrow coverage diagnostic intentionally
lacked unrelated global coverage and is not represented as whole-suite success.

## Final whole-repository verification

At the verified source, all 26 gates passed with actual process exit zero:
**8,377 tests passed, zero failures, 11 inherited skips**. The MCP subset passed
**1,531 cases across 268 files**. The chapter-deletion/editor/inventory focused run
passed **72 cases across 12 files**; export lifetime/security/cancellation passed
**49 cases across four files**. These focused counts overlap the complete suite.

Renderer/Electron/JavaScript types, formatting, lint, error handling, test boundaries,
architecture/maintainability, duplicate/dead-code checks, exact coverage inventory
and floors, Windows build, artwork parity, image protocol and renderer/preload gates
passed in one complete run using the existing process-local eight-worker option.
Default workers, timeouts, inherited skips and global thresholds were not changed.
Gate interval: `2026-09-21T05:22:26.138Z` through `2026-09-21T05:27:39.583Z`.

The resumed initial full run passed 8,371 tests and failed only unregistered source
inventory. Seven new production modules were registered from that Windows V8
measurement. A missing invalid chapter-catalog branch was covered by a new contract
test, retaining the original 100% floor of `mcpRetentionRecords.ts`. The later full
run passed 8,375 and failed the decoder signal assertion described above; the final
run includes its deterministic regression and corrected production code.

All **1,747 inherited coverage records, provenance and deletion entries are
unchanged** from `e1a57949`. Exactly seven measured modules were added, bringing the
inventory to **1,754: 756 historical and 998 introduced records**. No old floor was
lowered, production file excluded or success inferred from a partial run. Dependency
budget exceptions remain measured native composition/authority reuse, not changes
to global limits. See the preserved coverage-registration JSON for exact ratios.

HTTP tests cover approved scopes, owner isolation, strict review/confirmation,
revocation and response contracts. Filesystem/native tests cover empty chapters,
source changes, encrypted corruption, occupied restoration paths, missing work,
expiry and interrupted transaction recovery. Crash tests inject the existing native
transaction crash points; they are not arbitrary real-process kill experiments.

## Dedicated actual-Electron verification

The new chapter-deletion scenario passed at the SAME verified source together with
existing native regressions. It uses a freshly imported chapter in the smoke-owned
profile, real image validation/library files and real OS encryption. It exercises
review, encrypted copy, deletion, MCP session reconstruction, exact Undo/Redo,
historical request replay, protected disposal and original/external-source retention.

All seven required completion markers were present; actual child exit was zero and
the isolated listener on port **57084** closed. The renderer's editor-state response
is a fixture boundary; the actual nonce-correlated `McpEditorGuard` runs. File
selection/browser collection in the enclosing import scenario also use fixtures.
This is not a user-app restart, live website/model quality or public MCP acceptance.
No renderer layout changed, and no new screen-capture verification is claimed.

Final evidence: `.tmp/mcp-chapter-deletion-full-check-final-2.log`,
`.tmp/mcp-chapter-deletion-final-evidence.json`, final-source.json, final-vitest.json,
final-coverage.json, final-timings.json, coverage-registration-continue.json and
native.log/native-result.json under the same mcp-chapter-deletion prefix. Failed
runs/reproductions are separately preserved. Thirty-eight changed source/test/script
hashes are recorded; final documentation commits must compare identical for code.

## Exact next work

Continue bundle 10 with reviewed movement, work/page deletion recovery as applicable,
and general incoming file bytes / native working-file input. Those are NOT completed
by the chapter-only deletion slice. Do not duplicate completed imports, source
history, naming/chapter/page ordering, chapter recovery or synchronization. Do not
advance to bundle 11. No live user-app restart, real library mutation, authentication,
model asset, Tailscale or OS security changes were made. No master merge, new branch
or release. Live acceptance remains deferred until all implementation bundles.
