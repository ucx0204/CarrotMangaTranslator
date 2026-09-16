# Selected erasure recovery: historical incomplete attempt

**Superseded:** the three tools are now implemented and registered. Current contracts and exact verification boundaries are in [selected-erasure recovery](mcp-selected-erasure-recovery.md) and [implementation closeout](mcp-erasure-recovery-closeout-20260916.md). The notes below describe the earlier withdrawn attempt only; do not reapply its draft patch or treat it as the current status.

Historical status at this attempt: **not implemented or enabled**. Existing production source was preserved at the last verified model-lifetime checkpoint `758fd261`. No release or master change.

The user requested only a selected erasure's recovery availability, undo and redo in the existing MCP branch. The native `InpaintingRevisionStore` and page ownership must remain the authorities; no OCR/inpainting model should run during replay.

## Investigation

- Native erasure returns `historyTransaction`, but the MCP projection does not retain a session-owned lookup for it.
- Native history serializes replay/release and retains before/after artifacts. `prepareInpaintingPageRevision` performs strict full-page revision checks, so later manual content changes must be refused rather than overwritten.
- Native generic replay has multi-chapter compensation logic. A remote single-page replay should use the existing atomic chapter/work transaction with a trusted commit-time authorization guard, not an unguarded compensating write after revocation.
- Job metadata and recovery responses must remain attachment-free. Only an owned, settled, successful one-block erasure with exactly one native page target is eligible. History loss/restart must report unavailable.
- Each undo/redo needs current revision plus a unique action request ID. Exact retries must never apply again, including after the opposite action.

## Preserved intermediate work

Commits `07d99f4f`, `969af6a1`, `c46ecb64`, `f9d71321`, and `cf1e3b7a` contain the unvalidated implementation draft; `9c38036d` formats it. They remain in branch ancestry, but these five draft source files were removed from the active tree because they did not yet compile at the time. They were not completed tools.

An uncommitted integration diff was also preserved locally for review only at `.tmp/mcp-erasure-recovery-20260916/incomplete-working-changes.patch` in the existing Review worktree. Do not automatically apply it.

The draft needed correction of: the unavailable-view revision union, the narrow `InpaintingJobRevisionStore` interface, and a complexity violation in single-image validation. Typecheck reported these errors; no functional tests or native replay acceptance ran during this initial attempt.

The correction request through Remote Desktop Commander was blocked because the tool could not determine its security state. It was not retried via another tool. The incomplete code was withdrawn instead of leaving a broken build or claiming it passed.

## Historical next steps

The original plan was to resume from the documented design and draft history, preserve existing storage guards and lock behavior, and add deterministic tests before enabling tools. It covered inspect/undo/redo, original and other-block preservation, stale revisions/manual changes, duplicate request IDs/opposite-action replay, wrong owner, missing/released history or files, permission revocation at commit, disconnect/cancel, and artifact retention. It then called for isolated native erasure -> inspect -> undo -> redo without real model loading and comparison of original/result pixels. Current results are recorded in the closeout linked above; live connector schema refresh and UI approval remain separate from isolated tests.

This initial attempt only read capabilities on the live connector. User artwork, authorization, model configuration and the running app were not changed.
