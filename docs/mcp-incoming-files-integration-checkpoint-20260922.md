# Bundle 10: incoming-file integration verification

> Native working-file import into a new work is now verified. See
> `mcp-work-file-import-checkpoint-20260922.md` for the current resume point.
> This document preserves the preceding byte-transfer integration checkpoint.

Status: ALL 26 REPOSITORY GATES AND ACTUAL ELECTRON RECHECK PASSED.
Verified source: `8f6dea11804ec06aa231618fb017b40b862a1aa8`.
Starting checkpoint: `3b525c21`. Continue only on `feat/mcp-app-bridge`.
This supersedes the unresolved architecture status in
`mcp-incoming-files-checkpoint-20260922.md`; its behavior and limitations remain.
Bundle 10 is not complete. Native `.mgtshare` working-file input remains.

## Applied through GitHub

Only `scripts/architecture-budget-baseline.json` changed in the implementation
commit. The current dependency check first reproduced all four outstanding failures.
The three added import-session dependencies are the owned file-upload store, strict
upload tools and uploaded-import input contract. The existing journal and output
composition directly register that contract. File-upload tools reuse the common
argument/authorization boundary, adding one consumer.

The measured file-specific ceilings are now:

- `mcpJobJournal.ts`: 16 runtime imports.
- `mcpBatchTool.ts`: 35 direct runtime consumers.
- `mcpOutputSchemas.ts`: 37 runtime imports.
- `mcpLibraryImportSession.ts`: 15 runtime imports.

All global/legacy rules and 62 unrelated exception entries remain identical.
The three updated entries retain their previous reasons and append this feature's
rationale; one new session-specific exception is documented. No forwarding wrapper,
new importer, authorization change, excluded test or global threshold change.

These are explicit, justified dependency-budget updates, not changes to the runtime
upload algorithm or a claim of new file-format support. No new tools were added.
The six file-transfer/preparation tools and 211 output contracts are unchanged.

## Remote Desktop Commander verification

At the verified source, the actual complete check returned exit 0 with all 26 stages
passed in the same sequence, including architecture, full V8 coverage, Windows build,
artwork parity, image protocol and renderer/preload boundaries. Wall time: 300.09s.
Tests: 8,524 passed, zero failures and 11 inherited skips (8,535 total).
MCP tests: 1,670 passed across 303 files. No new test cases were added in this resume.
All 1,785 coverage records and the entire coverage manifest remain unchanged.
All 4,345 tracked source/test/script file hashes matched after the complete check
and again after actual Electron verification.

The isolated Electron harness ran after the successful build. All twelve required
completion markers were present, the actual child exit was 0, and its isolated
listener 58071 was closed. The incoming-file scenario sent actual PNG byte chunks,
prepared a frozen preview, disposed the upload, published through native image
validation/library storage/OS encryption, reconstructed the MCP client, replayed
the original request and verified original preservation. Prior import, persistent
source-history matching, organization, page ordering/deletion, chapter deletion/
movement and exact-2,000-entry work recovery also passed in the same native run.

Native storage, image validation, transactions and OS encryption are real. Existing
browser/picker/editor responses and expensive-model boundaries use isolated fixtures.
This is not a restart of the user's app, real-model or website quality validation,
ChatGPT attachment ingestion or live `망번테스트` acceptance. Previously documented
JPEG/WebP/PDF/RAR and maximum-size transfer limitations remain; no new claim is made.

## Evidence and exact resume point

Evidence prefix: `.tmp/mcp-incoming-architecture-verified-`.
Files: source/result/evidence.json, check.log, timings/vitest/coverage.json and
native.log/native-result.json. The original four-failure reproduction is preserved
separately as `.tmp/mcp-incoming-architecture-resume-baseline.log`.
The earlier partial successes and failed orchestration remain historical evidence;
they are not rewritten as successful runs. The new complete run closes that gap.

Next: native `.mgtshare` input through the existing share workflow. Its contracts are
in `src/shared/shareTypes.ts`; preview/import use `libraryShareFacade.ts` and
`libraryStore/shareWorkflow.ts`. This resume only reviewed those boundaries; it did
not implement MCP working-file input. Do not flatten editable working files into
images or silently discard context. Do not redo completed library/import/recovery
features or begin bundle 11. Live acceptance remains deferred.

No user app restart, real manuscript/library modification, authentication/model/
Tailscale/OS-setting change, master merge, release or additional branch. Final
checkpoint/roadmap changes must remain documentation-only relative to the verified
source; confirm local/remote equality and a clean worktree before reporting completion.
