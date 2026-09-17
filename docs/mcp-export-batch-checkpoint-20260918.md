# MCP multi-page PNG / ZIP checkpoint — 2026-09-18

Status: implementation checkpoint, NOT a completed or deployed MCP feature.
Latest resume: 705 MCP tests passed and 2 new retention regressions failed.
The earlier verification counts below are historical; see the resume section.

## Starting point

- Worktree: CarrotMangaTranslator-MCP-Review; branch: feat/mcp-app-bridge.
- The user's pre-existing link-only download changes were committed unchanged
  first as fe0553e2 and pushed before new implementation began.
- Link-only / optional-attachment tests passed (22 cases); formatting followed.
- The user considers the previous feature's live tests complete; do not repeat them.

## Implemented, with service-level regression tests

- Fixed one-chapter selection (1–50 pages), order/membership snapshot and revisions.
- Sequential PNG export through the existing page exporter and native job handoff.
- Completed / failed / cancelled / unprocessed page outcomes; no model calls or edits.
- Separately requested ZIP of already generated PNGs, reusing the app's atomic,
  sequential streaming share-archive writer. No rerendering for another ZIP attempt.
- Explicit partial ZIP opt-in; ordered filenames and a metadata-only omission manifest.
- Existing operation receipts, ownership, request deduplication and durable metadata.
- File access remains subject to grant, redaction, revision, expiry and server lifetime.
- Configured limits: PNG 64 MiB / ZIP 128 MiB / session 256 MiB. Concurrent expiry
  accounting has an unresolved defect described below; no silent downscaling.
- Files and links remain session-local with ten-minute expiry; receipts last seven days.
- Restart does not restore files, and this checkpoint does not implement automatic resume.
- ZIP tests use real file/archive I/O but synthetic renderer bytes, not native pixel QA.

## Integration still pending

A combined remote edit request for the public file-tool arguments, content MIME
union, output schemas and artifact HTTP route was blocked by the tool safety check.
Those edits were NOT applied and were NOT retried through another tool or channel.
The attempted early batch registration was removed to avoid advertising unfinished tools.
Existing single-page tools remain registered; the new tool definitions are not published.

Complete these boundaries before exposing the new tools:

1. mcpOutputSchemas.ts: batch/ZIP receipt targets, preflight output and ZIP metadata.
2. mcpOperationTools.ts: explicit pageId for a batch file and correct ZIP attachment metadata.
3. mcpReadTools.ts: application/zip resource-link content type.
4. mcpArtifactHttp.ts: owned ZIP route, streaming transfer, HEAD and disconnect behavior.
5. mcpPageOperationSession.ts: only then add the batch tool list to the actual server.
6. HTTP authorization/schema/file tests, native multi-page render and ZIP byte parity,
   streaming cancellation/cleanup, full checks and measured coverage registration.
7. Review finite output retention/budget behavior before expanding to large chapters.

Important implementation notes:

- Completed files of a cancelled batch use retained grant checks independently of
  the cancelled processing signal; authorization/revision/redaction still apply.
- Old single-PNG read-failure tests caught a metadata-only availability regression.
  Actual PNG read verification was restored; those tests were not weakened.
- A ZIP is not a page edit and does not provide Undo or automatic background AI work.
- No live app restart, user-library edit, authentication migration or model run occurred.

## Verification at the earlier checkpoint

- All MCP Vitest suites: 695 passed / 92 files, including 14 new export/ZIP cases.
- Renderer/tests, Electron and JavaScript type checks: all exit 0.
- Changed TypeScript file ESLint, test-mock-boundary and error-handling checks: pass.
- Regression log: .tmp/mcp-export-batch-20260918/mcp-tests-final.log.
- Service ZIP tests read back the archive and compare each entry with stored PNG bytes.
- Initial four legacy PNG availability-test failures were fixed without altering tests.
- Full repository check, new native batch checks and coverage registration: NOT completed.
- Live plugin use of the new batch tools: NOT possible yet; intentionally unregistered.

Five direct-consumer ceilings were measured and documented individually, without
changing global limits: pageRevision 51, blockFingerprint 28, mcpEditPolicy 53,
library facade 40, and page-operation composition imports 19. These reuse existing
revision, fingerprint, error, library and native-job authorities rather than copies.

## Resume result — 2026-09-18

The user's request to commit the current code first was completed before further work.
All 16 pre-existing changed/new files were preserved as fd83373e. Existing remote
formatting work was merged without rewriting history and pushed as c126f79c.

GitHub direct file creation succeeded for tests/mcpArtifactRetention.test.ts in
1b0eeef5. These are new, active regression tests, not skipped or expected-failure tests.
They reproduce one expiry-cleanup concurrency defect in two scenarios:

- Two simultaneous writes both remove the same expired output. The cleanup loop
  then subtracts the same entry size twice, so retained-byte accounting is incorrect.
- When the first removal fails, another concurrent write independently proceeds
  instead of sharing that in-flight cleanup outcome. A later explicit retry must
  remain possible after a failed cleanup.

The request to change mcpArtifactStore.ts to share in-flight expiry cleanup was
blocked by OpenAI's tool safety check and did not execute. No alternate tool was
used to retry that blocked production edit. Git diff confirmed no production source
changes after the preserved checkpoint. The defect remains unresolved.

### Checks actually run during this resume

- Export/ZIP, job-file and operation-HTTP suites: 36 passed / 3 files.
- All tests selected by Vitest filter mcp: 705 passed, 2 failed / 94 files total
  (93 passing files and the new failing retention-regression file).
- JSON report: .tmp/mcp-export-resume-20260918-tests.json.
- TypeScript renderer/tests, Electron and JavaScript projects: all exit 0.
- Test-mock-boundary and error-handling policy checks: pass.
- New retention-test ESLint: pass; formatting uses repository Prettier.
- Full repository check, new native multi-page rendering, coverage registration
  and live client use of batch export: not completed.
- Live capabilities read succeeded; the running connection does not advertise
  the new batch export tools. No user-page edits or previous live tests were run.

The branch is deliberately an unfinished checkpoint with two failing regressions,
not a release-ready implementation. Preserve the tests and existing source. Resolve
the retention defect and outstanding integration through permitted development
operations before advertising the batch tools or claiming successful ZIP delivery.
