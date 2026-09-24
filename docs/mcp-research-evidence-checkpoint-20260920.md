# Bundle 9 continuation: research evidence and job references

Status: RESEARCH EVIDENCE/JOB-REFERENCE CHANGES AUTOMATICALLY VERIFIED.
Bundle 9 public durable-proposal integration and multi-work research are NOT complete. Continue only on `feat/mcp-app-bridge` in the MCP-Review worktree.
Starting source: `4f1a0153`; its verified native retention backend remains intact.

## Implemented changes

The existing `carrot_run_context_research` execution now binds complete saved-work
evidence using the existing `readWorkContextReferences` and
`contextMigrationSnapshot` authorities. It checks before the researcher runs,
after engine cleanup and after queued proposal preparation. A change in another
chapter's dialogue or speaker/glossary references can no longer produce a public
successful result merely because the anchor chapter's context revision matches.
The existing researcher, app jobs, model cleanup, ownership and partial editor are
unchanged. No new search engine, GPU queue or automatic context application exists.

The job journal can retain a bounded `retainedContextProposal` lookup reference
when a native app-research result explicitly reports seven-day retention. It keeps
only proposal/work/chapter IDs, expiry, retention and `availability: lookup-required`.
Research changes, source URLs, warnings and capability links are not copied into
this reference. Expiry is computed on read; a reference is NOT proof that its disk
record still exists or is applicable. Owner, presence and current state must be
checked by the proposal reader. Legacy session-only research still expires across
restart. Repeated journal serialization must not extend expiry or execute work.

This journal support does not make the old public proposal service persistent:
that service still does not emit retained app-research metadata. No new MCP tool
is registered by this continuation.

## Reproduction and checks

Two real-library/OAuth/HTTP cases reproduce changed source text and glossary
references in a non-anchor chapter during the research engine boundary. The
corrected fixture has real chapter-scoped image files and validates both chapters
before execution. Against the unchanged research implementation both cases wrongly
complete; with full-work checks they reject and preserve all saved user edits.
Evidence: `.tmp/mcp-research-work-evidence-valid-repro.log` and
`.tmp/mcp-research-work-evidence-final.log`. The earlier fixture-path diagnostic is
not used as evidence of the fixed production bug.

Job-reference tests cover strict fields, legacy behavior, inclusive expiry,
serialization identity, private-content exclusion and actual operation-service
reconstruction/replay without another executor call. A mismatched chapter reference
is invalid journal state. The operation-service persistence boundary in this test
uses serialized fixture data; it is not an OS-encryption or public-client test.

The initial focused source/reference, existing research HTTP/concurrency/validation
and job-reference run passed eighteen cases. The expanded final focused run passed
25 cases across six files, including actual operation-service reconstruction/replay
and legacy session behavior. Scoped lint and architecture checks passed.
Evidence: `.tmp/mcp-research-evidence-focused.log`.

The native research adapter directly consumes thirteen runtime imports to reuse
the existing complete-work evidence authority. Only that measured composition
boundary is declared; global limits and existing coverage floors are unchanged.
No production module is added, so no new coverage-floor row is needed.

## Final verification

Verified production/test/configuration: `2afa6ccb374fb5438899d56388b6e690f652e4dd`. All 26 repository gates
passed with actual process exit code zero. The complete Vitest/V8 suite passed
**8,124 tests, zero failures and 11 inherited skips**.
The MCP subset passed **1,305 cases across 204 files**.

Renderer/Electron/JavaScript type projects, lint, formatting, dependency/structure,
duplicate/dead-code rules, test boundaries, exact coverage/inventory, Windows
application build and existing native artwork/image-protocol/renderer/preload checks
passed in the same sequence. The prior workflow-expiry regression also passed in
this full run. No failing whole-suite result is being replaced by focused success.

All 1,707 inherited coverage records, provenance and deletion records are unchanged;
the complete coverage manifest is byte-identical to `4f1a0153`. No coverage row or
floor was added or lowered. Current source/test/configuration hashes were recorded
before the full check and rechecked after completion; final documentation changes
do not alter that verified code.

Gate interval: `2026-09-20T08:49:10.614Z` through `2026-09-20T08:53:12.900Z`.
Evidence: `.tmp/mcp-research-evidence-full-check.log`,
`.tmp/mcp-research-evidence-source.json`,
`.tmp/mcp-research-evidence-final-evidence.json`, and final Vitest/coverage/timings
JSON with the same prefix. The successful source and failed baseline reproduction
are preserved separately.

No standalone actual-Electron research-reconstruction scenario was added or run.
The existing native parity gate does not stand in for that pending public-tool test.
External provider responses are fixture boundaries, not live model quality evidence.

## Unapplied work

A request to change `McpContextProposalService` for retained backend injection was
rejected by the tool safety check before execution. It was not reapplied through
another tool. The newly created but unconnected research factory was removed,
leaving no missing-type import or unregistered tool implementation in the tree.
The proposal service, context tool/session composition and public restart-gap
characterization remain unchanged from the starting checkpoint.

Next: connect the already tested native retained proposal repository/application
to the public service, carry initial research evidence into retained preparation,
register owned listing, and verify OAuth/HTTP and actual Electron reconstruction.
Then implement fixed multi-work selection, ambiguity/spoiler holds, sequential
execution, per-work failures and explicit resume. Completed proposals must be
reused rather than researching again. Do not start bundle 10.

The running user app, user artwork, credentials, model assets, Tailscale and OS
security settings are not changed. Live model/client acceptance remains deferred.
No branch creation, master merge or release is part of this work.
