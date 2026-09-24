# Bundle 9 continuation: shared research proposal policy

Historical checkpoint. The current continuation is
`mcp-research-retention-backend-checkpoint-20260920.md`: native retained research
storage/recovery is implemented and all repository gates pass at `98e3fa06`,
while public tool integration and multi-work execution remain pending.
The failures and preparation-only state below describe the earlier checkpoint.

Status: IMPLEMENTATION PREPARATION ONLY; NOT DURABLE RESEARCH COMPLETION.
Starting point: `a535a668`. Continue only on `feat/mcp-app-bridge` in the
existing MCP-Review worktree. Do not begin bundle 10.

## Implemented scope

The existing `McpContextProposalService` now delegates deterministic proposal
creation, exact selection and reviewed-result construction to
`src/main/application/mcpContextProposalPolicy.ts`. Existing session lifetime,
30-minute expiry, capacity, request caches, ownership, authority and native
commit paths remain in the original service. The existing partial editor is
still canonical; no researcher, storage engine, GPU queue or tool was added.

New policy tests compare edit/external-research/app-research proposals before
and after JSON roundtrip. Stable new entry IDs (including an own-property
`__proto__` key), selected results, origins, evidence separation, unselected
entries, tampered reviews, changed IDs, revoked authority and stale context
are checked. This is in-memory serialization evidence, NOT disk persistence
or a claim that pending proposals survive a restart.

`tests/mcpResearchProposalGap.test.ts` deliberately characterizes the still
unimplemented behavior: the actual composed tools lose pending research on
session reconstruction, recreate a different proposal ID, and leave saved
artwork/catalogs and the retained catalog untouched. The desired restart
success assertion was run first and failed with missing/expired proposal in
`.tmp/mcp-research-retention-repro.log`. No pre-existing test was removed,
disabled or changed to accept a failure.

## Blocked operation and exact boundary

One request to connect research record schemas and native single-index
publication was rejected by the tool safety check before execution. It was
not retried through another tool. A later request to synchronize the existing
workflow expiry test with actual cleanup was also rejected before execution;
that test and its production workflow implementation remain unchanged. No research record kind, persistence field,
new output contract or storage publication change from that request exists
in this continuation. Do not describe this as a Git/Windows permission error.

New research remains session-local. Output contract count remains 143.
The verified memory refresh and context migration from the preceding
checkpoint remain implemented; they are not being redone.

## Structure and coverage

The extracted policy is one genuine direct consumer of canonical hashing and
typed errors. Source-specific fan-in declarations are 75 for blockFingerprint
and 138 for mcpEditPolicy. Global ceilings, hashing and error semantics are
unchanged. Original proposal transaction, availability, research validation
and concurrency tests exercise the same service path after extraction.

The focused policy/native regression run passed 25 cases across six files.
The new policy was measured on Windows with the existing Vitest/V8 toolchain:
{"lines": {"total": 35, "covered": 35, "skipped": 0, "pct": 100}, "statements": {"total": 37, "covered": 37, "skipped": 0, "pct": 100}, "functions": {"total": 15, "covered": 15, "skipped": 0, "pct": 100}, "branches": {"total": 18, "covered": 18, "skipped": 0, "pct": 100}}
Source measurement: `.tmp/mcp-research-policy-coverage/coverage-summary.json`.
SHA-256: `a7c9cc45a9da7a27aa893cbaee441c0715d205c849f3469fea18e5a8da4d1d3d`.
All 1,702 inherited records, provenance and ten deletion records are unchanged;
one measured policy module brings the inventory to 1,703. No floor is lowered.
The first whole-repository test run passed all 8,096 cases with the existing
11 skips, but its exact inherited coverage gate failed: extracting covered
branches changed the service ratio to 21/26 (80.76%), below its inherited
37/44 (84.09%) baseline. This run was not reported as a complete check pass.

Two native tests were added to `mcpContextAvailability.test.ts`: complete
paginated review/returned-clone isolation and expiration of cached applied
receipts. No production code or coverage floor was relaxed. The expanded
focused run passed 31 cases across seven files; service branches were 23/26
(88.46%), and the extracted policy retained 100% of its measured four metrics.
Evidence: `.tmp/mcp-research-policy-expanded-tests.log` and
`.tmp/mcp-research-policy-expanded-coverage/coverage-summary.json`.

## Verification at the final code checkpoint

Code/test checkpoint: `c16437d21bcacbe8a640bbbe9884956aad5e5b51`.
Whole repository check: **FAILED**, not a 26-gate pass.
Final full suite: 8,097 passed, one failure and
11 inherited skips. MCP: 1,278 passed,
one failure across 198 files. All static stages completed successfully.

The remaining full-suite failure is
`tests/mcpWorkflowPersistenceEdges.test.ts`, case
`rejects output publication if retention expires during the native renderer boundary`.
Its shared error sink observes the child operation before the parent workflow's
reconciliation and final cleanup necessarily finish. `McpWorkflowService.get`
returns active metadata during that interval; the immediate rejection assertion
therefore races cleanup. Inspection of the native runner/service establishes
that the error notification is not a settlement signal. A bounded wait for the
same final rejection was proposed, but that edit was blocked and is NOT applied.
No production expiry, output publication, scope or cleanup rule was weakened.

The unmodified workflow file passes its two tests in a separate focused run,
exit zero. This supports the timing diagnosis; it does not cancel the full-suite
failure or count as its repair. Latest full-check timing interval:
`2026-09-20T06:31:57.088Z` through `2026-09-20T06:36:02.992Z`.

After the failed suite, the exact coverage gate was run against its latest
complete Windows V8 report and passed: 754 baseline files, 949 introduced
records and ten recorded deletions. The separate actual Windows application
build also passed with exit zero. Renderer bundle-size and absent optional
font-runtime-source build messages were warnings, not verified model readiness.
No new standalone real-Electron research scenario was run in this continuation;
no live model, user manuscript or public-client acceptance is claimed.

Evidence: `.tmp/mcp-research-policy-final-evidence.json`,
`.tmp/mcp-research-policy-final-vitest.json`, final coverage/timings JSON,
`.tmp/mcp-research-policy-full-check-final.log`,
`.tmp/mcp-research-policy-final-floor.log`, `.tmp/mcp-research-policy-build.log`
and `.tmp/mcp-research-policy-workflow-isolated.log`.
The original first full-run evidence and the initial desired-persistence
failure are retained separately, not overwritten by focused success.

## Resume here

First fix the remaining workflow-expiry test synchronization without changing
production retention/cleanup semantics, and rerun the complete gate sequence.
The source storage/schema changes listed below have not been applied.

1. Retain reviewed research proposals separately from applied context changes.
   Preserve fixed request/owner/expiry, exact new entry IDs, review evidence,
   options, explicit title/engine and per-work usage results.
2. Publish selected catalog changes, the applied-proposal receipt and mandatory
   context Undo/Redo data in one existing native transaction with one retained
   index publication. Recheck authority, expiry, full work evidence and manual
   changes; no raw transport-supplied snapshot or forced overwrite.
3. Reconstruct pending/applied reviews without research or model calls. Add
   strict owned listing, expiry/discard, no-op/replay, concurrent publication,
   revocation and crash-boundary tests before completion claims.
4. Then connect fixed multi-work selection, ambiguity/spoiler holds, bounded
   external processing, partial failures, cancellation and explicit resume
   using the existing research adapter and workflow/job ownership. Completed
   proposals must not be queried again after restart.

No live app restart, user artwork, credentials, model assets, Tailscale,
Windows security changes, master merge or release belong to this continuation.
Live user/client/model acceptance stays deferred until all bundles are built.
