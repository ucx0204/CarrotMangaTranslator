# Bundle 7: durable page recovery and retained output assets

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Starting point: `7c3563d4`. Verified production/test code: `09a99b16`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundles 1-7 are implemented and automatically verified. The live app was not
restarted; user artwork, authentication and model assets were not changed.
No master merge, release, live model call or public Tailscale test was performed.

## Connected scope

Eight tools are registered in the real desktop composition and strict output
schemas. The desktop supplies the existing OS-encrypted retention codec; older
compatibility fixtures may explicitly omit it. There are 120 output schemas.

- `carrot_list_changes`
- `carrot_get_change`
- `carrot_undo_change`
- `carrot_redo_change`
- `carrot_list_outputs`
- `carrot_get_output`
- `carrot_get_output_file`
- `carrot_discard_retained`

New MCP page-content saves join the existing native library transaction. Before/after
blocks, reading order, typography and generated layers, sound-effect review,
completion content, backgrounds, masks and provenance are retained as applicable.
Page publication, private image copies, encrypted record and index share one commit
point. The initiating connection owns the record. No raw snapshot or arbitrary PC
path is accepted from remote callers. Ordinary UI saves are not silently enrolled,
and earlier session-only history is not retroactively reconstructed.

After restart, use the retained change ID rather than an expired session batch ID.
Undo/redo uses normal native handoff, activity/page ownership, original-content
checks and atomic publication of restored state plus a durable action receipt.
Exact optional-property absence is restored. Later edits, source/review changes
and chapter membership/order changes conflict. Undo may recover after a context
change; redo additionally requires context agreement. Replaying a completed action
request, including after a lost reply and reconstruction, returns its historical
receipt without another save or model call.

## Retained outputs and authorization

PNG and native ZIP bytes are copied into the retained store independently of the
short-lived download link. The source is bound before rendering and revalidated at
publication. Metadata inspection verifies the retained content hash, not just the
index. `carrot_get_output_file` issues a new ten-minute capability only after current
owner, same-profile, page/source, image permission, redaction and byte-integrity checks.
The old link does not revive after restart. Reissue does not render, run models,
resize or regenerate a replacement file. A changed page makes its old output
unavailable rather than silently changing the output content.

Read-only PNG/page-batch/ZIP export tools now preserve the initiating owner through
asynchronous job admission. This fixes the native failure found in the interrupted
run. They remain read-only with their existing image scopes: no page-write authority
or page-history participant is added to exports. Polling remains metadata-only.
Revocation, redaction, explicit discard and session shutdown invalidate access.
A newly created unrelated OAuth connection cannot inherit another connection's data.

## Working-image cleanup and storage bounds

Restored working images are independent of private retained copies, so discarding a
history record cannot break the saved page. Replaced `.mcp-recovered-UUID` images are
now retired with the next recovery publication, in the same native transaction.
Retirement is computed against the complete final chapter and only exact replaced
candidate paths. Originals, any current page reference and active native history
leases are preserved. If an owned directory contains an unrelated file, only the
known unused image files are retired. No chapter-wide or library-wide deletion scan
is performed. Normal native history release recognizes the same exact recovered
filenames; empty directories are removed without recursive cleanup. Symlink paths
are rejected and unexpected cleanup failures are reported, not treated as success.

Retention is seven days from creation, 256 records and 1 GiB of private catalog
storage. Individual files are limited to 128 MiB. One native change can cover at
most 50 pages / 4 MiB page metadata, with at most 32 retained recovery action receipts.
Existing PNG/ZIP and encrypted-envelope limits still apply. Metadata is OS-encrypted;
image/mask/output copies are private managed files checked by content hashes.

Expiry denies use immediately; the next retained write prunes only indexed expired
record directories. Explicit discard removes only the selected owned record and
its private copies. Capacity, encryption, missing-index and corruption errors refuse
publication rather than silently dropping active history. These are bounded,
restart-persistent records, not unlimited permanent archives or a total-library
1 GiB quota. Current working files and ordinary app history are separate.

Executable analysis plans, running-job state, automatic multi-page resumption,
work-context migration and cross-connection takeover are not restored by this bundle.
Those remain in the later workflow/context/client bundles.

## Final automatic verification

The complete repository check at `09a99b16` passed all 26 gates, exit code 0.

| Check                                                                   | Result                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| Complete Vitest/V8 suite                                                | 7,893 passed; zero failures; 11 existing skips |
| MCP cases in that suite                                                 | 1,077 passed across 159 files                  |
| Renderer, Electron and JavaScript type projects                         | Passed                                         |
| Lint, format, architecture, duplicates, unused code and mock boundaries | Passed                                         |
| Exact coverage-floor and inventory checks                               | Passed                                         |
| Windows app build                                                       | Passed                                         |
| Existing artwork parity, image protocol and renderer/preload checks     | Passed                                         |
| Additional real Electron retention check                                | Passed; required markers and exit code 0       |

The added scoped HTTP tests use actual OAuth authorization, native edits and
persistent records. They cover reconnection using restored authorization, owned
undo, exact replay, foreign/read-only denial, malformed snapshot input, new file
links, HEAD/GET size/hash equality, explicit discard, redaction and persisted grant
revocation. Only their external renderer is substituted with deterministic PNG bytes.

Storage tests use actual isolated native transactions and authenticated test
metadata encryption. They cover missing/corrupt metadata and files, expiry/capacity,
source mutation, image retention after upload disposal, page/receipt crash recovery,
post-commit notification failure, repeated image undo/redo, leased/current files,
unrelated files, symlink denial and cleanup failures. Injected process-loss tests
judge the durable state after startup transaction recovery, not an artificial
in-process reply from a simulated crash.

The interrupted native export-owner failure is fixed and covered by a real
read-only export-tool/job regression. Missing artifact error-path tests now exercise
publication/cleanup failures, borrowed-file admission/expiry and oversized ZIP
budgeting. The old PNG/ZIP floors pass without lowering them. All 1,643 inherited
coverage records, provenance and ten deletion records are unchanged. This bundle
adds 20 new modules plus one newly tracked existing file (100% initial floor), for
1,664 records. The final cleanup registration also preserves all 1,663 records
already present at the interrupted checkpoint. See the coverage provenance document.

## Native run and preserved evidence

Ran `node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs` with
`CARROT_MCP_SMOKE_PORT=38557` and `CARROT_MCP_SMOKE_TAILSCALE=0`.
The additional test uses actual Electron, OS encryption, production tool composition,
native transactions and the app renderer in an isolated library. It creates a
change, closes/reconstructs the MCP session, restores it with undo/redo, renders a
real PNG, reconstructs again and reissues byte-identical stored output without
rerendering. Original bytes and saved content are preserved. Both markers were read:

`PASS native OS-encrypted durable edit -> reconstructed session undo/redo -> actual PNG -> retained byte-identical reissue without rerender`

`PASS MCP native smoke finished`

The process exited with code 0. This is not a live-user app restart, actual model
quality assessment, chat attachment reception or public Tailscale acceptance.
Those tests remain deferred until all implementation bundles are complete.

Evidence: `.tmp/mcp-retention-final-evidence.json`,
`.tmp/mcp-retention-final-check-timings.json`, `.tmp/mcp-retention-final-vitest.json`,
`.tmp/mcp-retention-final-coverage-summary.json`, `.tmp/mcp-retention-full-check6.log`,
`.tmp/mcp-retention-native-final-20260919.log` and `.tmp/check-logs/`.
Final check times: `2026-09-19T08:22:32.336Z` to `2026-09-19T08:25:42.052Z`.

NEXT: bundle 8, model-grouped sequential jobs, chapter batches and explicit resume.
Reuse this durable content/output store and the existing app job/model ownership.
Do not create another GPU scheduler, revive model plans or redo bundles 1-7.
Keep frequent commits in this branch and defer live acceptance as instructed.
