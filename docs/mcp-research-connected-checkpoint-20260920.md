# Bundle 9: connected retained research reviews

Status: PUBLIC INTEGRATION AND AUTOMATIC/NATIVE VERIFICATION COMPLETE.
This checkpoint completed single-work retention. Multi-work research is now
complete in `mcp-research-batch-checkpoint-20260920.md`; follow that newer authority.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting checkpoint: `51a6de09`. Final verified source: `1c9267f3a883131ccb2bdb4b6044ae3e5f1c80f7`.
All implementation writes in this continuation use the GitHub connector; the
Windows worktree pulls those commits for verification. No branch, release,
user-app restart or user-data migration is part of this change.

## Connected scope

The existing `McpContextProposalService` accepts a native retained-research port.
External and app-engine research now use the already implemented encrypted
`McpResearchProposalRepository` and `McpResearchProposalApplication`. Their
existing library lock, work evidence, exact review policy and shared retained
transaction remain the sole persistence authorities. Ordinary manual context
previews retain their original session-only lifetime and native partial editor.

The actual page-operation composition supplies its existing retention storage
and editing boundary to the context session. `carrot_get_context_proposal` reads
retained reviews after reconstruction, and `carrot_apply_context_proposal`
applies only selected reviewed glossary/character changes. Context changes,
the one-shot proposal receipt and mandatory context recovery record publish in
one native transaction. An expired, foreign, damaged or stale retained review
is not silently downgraded to an unretained session write.

The new `carrot_list_context_proposals` tool lists only the approved owner's
retained reviews, with snapshot-bound pagination. Its strict output joins the
existing output family; the total registered output contracts is 144. It does
not expose proposal text, source URLs, raw file paths or another owner's IDs.
Use the existing explicit `carrot_discard_retained` for disposal.

Applied reviews return a `recoveryId` for the existing context migration
inspection/Undo/Redo tools. Historical request replay never reapplies a change
that has already been undone. Discarding a review is not Undo and does not
implicitly discard its separate recovery record.

## Original research evidence

App research supplies its explicit title/engine request, query/source/Tavily
usage and the original complete-work snapshot to retained admission. A change
while waiting for proposal preparation is rejected before retention, rather
than binding an old model result to newer saved dialogue. The original snapshot
is checked again at native publication. Older stored backend records without
the new optional provenance field remain readable; public callers cannot submit
that field, stored records, callbacks or raw page snapshots.

The already implemented job journal retains only bounded lookup metadata for a
completed retained result. After restart, use its proposal ID or the new catalog
rather than submitting a new research request. Lookup and recovery never run
research, OCR, translation, rendering or another model. A lookup reference is
not proof of current availability; owner, existence, expiry and work evidence
remain authoritative.

External sources remain caller-supplied evidence, not server-verified web facts.
Internet research never becomes page-read story memory automatically. Manual
previews and legacy no-retention sessions retain the existing 30-minute/restart
limit; the optional retention field is not fabricated for those previews.

The retained review uses the existing fixed seven-day policy, shared 256-entry
and 1 GiB catalog budget, and at most 100 reviewed changes. This is persistence
across restart, not unlimited archival. Normal model/account budgets are unchanged.
No new model download, provider fallback or automatic research retry was introduced.

## Contract, native storage and HTTP verification

The previous public restart-gap characterization now verifies successful exact
review reconstruction, stable entry IDs, source preservation and encrypted bytes.
Five connected-tool cases cover selected application/recovery, catalog ownership
and pagination, discard, disabled editing/processing, later manual changes and
exact-boundary expiry. Two app-engine cases verify retained provenance and
operation-journal reconstruction without another executor call, plus refusal of
original work evidence changed before retained admission.

Three real OAuth/HTTP cases verify owner isolation, strict input, server/auth
reconstruction, selected application and rollback on grant revocation during
both preview encryption and application encryption. The HTTP harness now
restores the native OAuth snapshot into a fresh session; it no longer reuses a
stopped authorization session. The existing migration and memory HTTP regressions
are preserved. The final HTTP/output regression run passed 16 cases in four files.

## Final verification

All 26 repository gates passed at `1c9267f3`, with actual process exit code zero.
The complete suite passed **8,134 tests, zero failures and 11 inherited skips**.
The MCP subset passed **1,315 cases across 207 files**.
Renderer/Electron/JavaScript types, lint, formatting, error handling, mock boundaries,
dependency/structure rules, duplicate/dead-code checks, exact coverage inventory,
Windows build and existing native artwork/image-protocol/bundle checks all passed.

All 1,707 inherited coverage records and their complete floor manifest remain
byte-identical to the starting checkpoint. No floor, global dependency budget or
permission check was lowered. No new production module was introduced.

The new isolated actual-Electron scenario also passed with **actual child exit 0**,
the required research marker and `PASS MCP native smoke finished`. It executes
OS-encrypted review storage, session reconstruction, exact selected application,
Undo/Redo, historical replay and explicit discard. It verifies original block text
and source pixels, unselected characters and actual memory-file absence.
The test listener on port 38691 was confirmed closed afterward.

The first native run reached successful selected application and recovery but its
final assertion compared a volatile timestamp synthesized for an absent memory
file. That newly added test was corrected to assert the real file remains absent,
plus unchanged memory identity/pages. No production memory policy or pre-existing
test was weakened. The complete gate sequence was rerun after that harness fix.
The earlier failed native output remains separately available for audit.

Final repository interval: `2026-09-20T09:45:07.156Z` through
`2026-09-20T09:49:08.353Z`. The preceding full pass at `4588ed59` is preserved too;
only the native assertion and documentation changed afterward. Final documentation
commits must be checked against `1c9267f3` for unchanged source/tests/scripts.

Evidence: `.tmp/mcp-research-public-complete-check.log`,
`.tmp/mcp-research-public-complete-evidence.json`, matching complete Vitest/coverage/
timings JSON, `.tmp/mcp-research-public-native-final.log`,
`.tmp/mcp-research-public-native-final-result.json` and the focused HTTP logs.
Initial formatting and native assertion failures remain in their earlier logs.

The research engine test substitutes only its external provider/model boundary.
The actual-Electron review test submits synthetic external evidence and performs
no web research or model inference. Neither is live-model quality, user-manuscript
or public ChatGPT/Tailscale acceptance. The running user app, credentials, original
library, model assets and network configuration were not changed or restarted.

## Historical remaining work at this checkpoint

Next implement multi-work research using these retained reviews and the existing
native job/activity boundaries. Fix the work selection up front, distinguish
ambiguous titles and spoiler holds, preserve per-work success/failure/usage,
and require explicit continuation after interruption. Completed reviews must not
be researched again. Reuse current selected context application/recovery.

Do not redo context merge/reference migration/memory refresh or create a second
research/GPU/storage engine. Do not start bundle 10. User-manuscript/model and
public-client/Tailscale acceptance remain deferred until all bundles are built.
