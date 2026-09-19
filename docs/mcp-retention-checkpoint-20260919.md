# Bundle 7: durable page recovery and retained output assets

Status: CORE IMPLEMENTED AND REGISTERED; BUNDLE 7 REMAINS IN PROGRESS.
Starting point: `7c3563d4`. Current production/test code: `60788857`.
Only `feat/mcp-app-bridge` and the existing MCP-Review worktree are used.
Do not restart the live app, alter user artwork/authentication/model assets,
merge master, release, or start bundle 8. All live acceptance remains deferred.

## Connected scope

Eight tools join actual app composition when the native encrypted retention codec
is supplied. Production desktop composition supplies it; existing compatibility
fixtures may deliberately omit it. The complete output inventory is 120 schemas.

- `carrot_list_changes`
- `carrot_get_change`
- `carrot_undo_change`
- `carrot_redo_change`
- `carrot_list_outputs`
- `carrot_get_output`
- `carrot_get_output_file`
- `carrot_discard_retained`

Actual MCP page-content saves participate in the existing library transaction.
Before/after blocks, order, SFX review, completion content, generated layers and
original/cleaned/mask evidence are bound to the initiating connection. Page data,
image copies, encrypted record and index publish together at the native commit
point. No raw snapshots or arbitrary local paths are accepted from the transport.
Native crash rollback and commit recovery protect the combined state.

Undo/redo uses native page handoff, activity ownership and atomic publication of
restored content plus action receipts. Subsequent user edits and changed source,
review or chapter membership conflict. Undo can survive context changes; redo
still requires context agreement. Exact request replay returns its old receipt
without reapplying changes. Optional-field absence and generated image content
are preserved. Executable model observations and work queues are not restored.
Cross-work context migration remains bundle 9 and job resume remains bundle 8.

Native PNG/ZIP bytes are retained separately from ten-minute session links. New
links require current ownership, permission/redaction and page/source checks.
Original evidence is captured before rendering and rechecked during retention.
Output inspection checks actual retained file hashes, not just metadata. Opening
and streaming recheck file identity and authorization; reissue does not render.
Old links are never revived after a session restart. Changed pages make old output
unavailable instead of silently generating replacement bytes.

## Bounds

Seven-day durable records, 256 entries / 1 GiB private catalog, 128 MiB individual
files. Native change records hold at most 50 pages / 4 MiB page metadata and 32
action receipts. Existing PNG/ZIP and encrypted-envelope limits still apply.
Expiry denies access immediately; subsequent retained writes prune indexed expired
copies. Capacity/encryption/corruption failures reject new publication rather than
silently losing history. Missing index with surviving records fails closed.
Explicit discard removes only that store-owned record/copies, not restored pages.

These are restart-persistent, bounded records, not unlimited permanent archival.
Recovered working image files are independent of the private catalog quota.

## Verification already completed

The focused native-storage suites pass for exact text/image recovery across session
reconstruction, upload disposal followed by generated-layer recovery, foreign owners,
malformed requests, source mutation, corrupt/missing metadata, expiry/capacity,
revocation after encrypted staging and post-save notification failures.

Native transaction crash tests cover after-publish-step, after-replace-step,
before-commit-point and after-commit-point. Committed recovery survives a lost
reply and remains idempotent after startup transaction recovery. PNG and real ZIP
bytes survive session disposal and are reissued byte-identically without rendering.
A source mutation during the renderer boundary refuses retained publication.

The first full Vitest/V8 run at `6634f57f` had 7,876 passing cases, one inventory
registration failure and 11 existing skips. All static stages passed. Nineteen new
module records and one newly tracked existing file have since been registered from
that measurement; all 1,643 inherited rows/provenance/deletions remain unchanged.
The new existing file has 100% for every metric, not an invented old measurement.
The separate 27-case coverage inventory suite passed after registration.

## Remaining work and exact resume point

The exact coverage gate still fails on inherited output modules:

- mcpArtifactStore.ts lines: 148/157 (94.26%), required 60/62 (96.77%).
- mcpArtifactZip.ts lines: 20/21 (95.23%), required 100%.
- mcpArtifactZip.ts statements: 22/23 (95.65%), required 100%.
- mcpArtifactZip.ts branches: 6/7 (85.71%), required 100%.

A request adding behavioral tests for retention-publication failure/cleanup failure,
borrowed-file admission rejection and oversized ZIP budgeting was not executed by
the tool. It did not modify tests/mcpArtifactRetention.test.ts. Do not lower floors
or remove validation to turn this into a passing gate.

Two other requests were not executed: the separate scoped OAuth/HTTP extension test
file and a managed-directory/candidate-cleanup extension for restored working images.
The latter matters because unused `.mcp-recovered-*` working copies can accumulate
after repeated undo/redo and are outside the 1 GiB private catalog quota. Do not
claim a complete cleanup lifecycle or delete current user images as a workaround.

The full rerun `.tmp/mcp-retention-full-check4.log`, independent Windows build
`.tmp/mcp-retention-build.log`, and isolated native Electron run
`.tmp/mcp-retention-native-20260919.log` are in progress at this checkpoint. Read the
terminal statuses before claiming success. The native script uses port 38557,
Tailscale disabled, actual OS encryption/renderer/transactions and a reconstructed
MCP session, not real models or user artwork. Require both its retention-specific
PASS marker and `PASS MCP native smoke finished`, plus exit code zero.

Next: finish the above verification, retain exact evidence, complete missing error
path tests and recovered-working-image cleanup, then close bundle 7. Do not advance
the roadmap to bundle 8 while these items remain unresolved.

Details: `mcp-retention-boundaries-20260919.md` and
`mcp-retention-coverage-20260919.md`.
