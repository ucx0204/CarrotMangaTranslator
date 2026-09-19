# Bundle 8 continuation: connected model groups and owner storage

Status: IN PROGRESS. Do not mark bundle 8 complete or begin bundle 9.
Current source/test checkpoint: `5cc0ae3a629fbd740747828c975047ce93e53412`.
This continuation began at `00ec55fb`. Use only `feat/mcp-app-bridge` and the
existing `CarrotMangaTranslator-MCP-Review` worktree. Live acceptance remains
postponed until all implementation bundles are complete.

This file supersedes the remaining-work list in `mcp-workflow-checkpoint-20260919.md`.
It does not supersede the existing runtime, authorization or data-protection rules.

## Changes actually saved in this continuation

### Sequential model-group connection

`mcpWorkflowRunner.ts` now executes pending steps by explicit stage index and calls
an optional native group boundary around that stage. Completed steps remain skipped;
pause and external waiting still stop progression, and child failures stop the run.
`mcpWorkflowRuntime.ts` connects translation and erasure stages to the existing
`ActiveJobStore.runModelGroup` and `withModelWorkload` boundaries. Physical resource
release is awaited before the group returns and the next stage can begin.

The existing per-child identity, native page ownership, execution settings and
cleanup failure checks remain in place. No new GPU scheduler or model algorithm was
introduced. Outside these explicit groups, existing per-operation behavior remains.
OCR still uses its existing native per-page pipeline; this continuation does not
claim a single persistent OCR model across all pages.

The source is connected and typechecked, but current grouped workflow behavior has
NOT been reverified by the focused model-group suite in this continuation. Do not
claim one-load runtime success merely from this connection or its compilation.
Source commit: `7e011141`.

### Atomic storage primitive for later explicit handoff

`McpRetentionStorage.stageRecord` accepts a native-only optional workflow owner
transition. It requires a workflow entry, the expected current owner, a valid
receiving identity and the same owner in the replacement record. Record and index
are staged in the same existing library transaction. The previous owner's prepare
request identity is cleared from the index. Page-change history and output ownership
are not changed. No transport input accepts a raw record or arbitrary file path.
Source commit: `b8e80e49`.

This is only the storage primitive. The existing two-party handoff service and four
handoff tool definitions are STILL NOT connected to the workflow repository/session
and output registration. They must not be advertised as usable MCP tools.

### New native storage regression tests

`tests/mcpWorkflowOwnerStorage.test.ts` has four passing tests using an isolated
library, actual transactions, encrypted test records and reconstructed MCP sessions:

- Record and index ownership change together, while prior page history stays owned.
- The workflow-only transition rejects ordinary retained page history.
- A stale owner, inconsistent replacement owner or invalid receiving ID publishes nothing.
- Revocation after encrypted staging rolls back both files and preserves the page.

No model or renderer is executed by these tests. Test commit: `ceeb7ff2`.
The repository formatter's resulting source/test tree is `5cc0ae3a`.

## Verification observed for this continuation

- New owner-storage suite: 4 passed / 1 file, exit code 0.
- Renderer type project (`tsconfig.typecheck.json`): exit code 0.
- Electron type project (`tsconfig.electron-typecheck.json`): exit code 0.
- JavaScript type project (`tsconfig.checkjs.json`): exit code 0.
- Changed-file lint: FAILED with two function-length errors in `mcpWorkflowRuntime.ts`:
  `createMcpWorkflowRuntime` is 92 lines and `open` is 81 lines; maximum is 80.
- Architecture: FAILED with two fan-in limits:
  `src/shared/blockFingerprint.ts` 66 / 65;
  `src/main/application/mcpEditPolicy.ts` 130 / 127.
- No current full-suite, complete 26-gate, Windows build or real-Electron success is claimed.
- Existing coverage floors, inventory and global lint/architecture limits were not lowered.

An initial focused baseline test request was not executed by the tool safety check.
A subsequent grouping-helper extraction request and a request connecting settled
admission plus repository handoff were also not executed. Those code changes are
NOT present. The accepted owner-storage tests above are separate new tests, not a
reported success for the blocked baseline request.

The workflow-specific real-Electron scenario already exists in
`scripts/mcp-native-workflow.cjs`. Older evidence records a native pass, but that
is not evidence for the new group connection at this checkpoint. Revalidate it
when the remaining source integration and static checks are complete.

## Exact next implementation steps

1. Extract the native model grouping composition without changing its behavior so
   the existing 80-line function rule is met. Review native model lifetime, child
   cancellation and failure cleanup before reporting runtime grouping success.
2. Connect the existing handoff service to settled workflow admission and an atomic
   repository transfer. Exclude active/admitting/uncertain workflows. Both approved
   connections must still authorize at publication. Transfer the plan only; keep
   existing native job/change/output ownership unchanged and clear foreign receipt
   IDs from the transferred plan. Preserve completed steps and attempt counters.
3. Register the four existing handoff tools and their strict output schemas in the
   real session composition, only after the native transfer path is complete.
4. Add real composition/OAuth, ownership/revocation, restart/replay, concurrency and
   crash-publication tests. Resolve measured architecture dependencies without
   suppressing checks. Register any previously untracked modules from real coverage.
5. Reverify grouped model workloads, pause/cancel/cleanup, all workflow cases, full
   repository gates and the isolated native workflow scenario. Record exact results
   and commit before advancing the roadmap to bundle 9.

## Logs and protected state

- `.tmp/mcp-workflow-owner-storage.log`
- `.tmp/mcp-workflow-resume-typecheck.log`
- `.tmp/mcp-workflow-resume-electron-typecheck.log`
- `.tmp/mcp-workflow-resume-checkjs.log`
- `.tmp/mcp-workflow-resume-changed-lint.log`
- `.tmp/mcp-workflow-resume-architecture.log`

The user's running app was not restarted. User artwork, library, OAuth credentials,
model assets, Tailscale and Windows security settings were not modified. Tests used
an isolated temporary library. No master merge, release or new branch was created.
