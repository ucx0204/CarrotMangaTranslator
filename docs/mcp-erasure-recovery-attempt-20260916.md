# Selected erasure recovery: incomplete attempt

Status: **not implemented or enabled**. Existing production source is preserved at the last verified model-lifetime checkpoint `758fd261`. No release or master change.

The user requested only a selected erasure's recovery availability, undo and redo in the existing MCP branch. The native `InpaintingRevisionStore` and page ownership must remain the authorities; no OCR/inpainting model should run during replay.

## Investigation

- Native erasure returns `historyTransaction`, but the MCP projection does not retain a session-owned lookup for it.
- Native history serializes replay/release and retains before/after artifacts. `prepareInpaintingPageRevision` performs strict full-page revision checks, so later manual content changes must be refused rather than overwritten.
- Native generic replay has multi-chapter compensation logic. A remote single-page replay should use the existing atomic chapter/work transaction with a trusted commit-time authorization guard, not an unguarded compensating write after revocation.
- Job metadata and recovery responses must remain attachment-free. Only an owned, settled, successful one-block erasure with exactly one native page target is eligible. History loss/restart must report unavailable.
- Each undo/redo needs current revision plus a unique action request ID. Exact retries must never apply again, including after the opposite action.

## Preserved intermediate work

Commits `07d99f4f`, `969af6a1`, `c46ecb64`, `f9d71321`, and `cf1e3b7a` contain the unvalidated implementation draft; `9c38036d` formats it. They remain in branch ancestry, but these five draft source files were removed from the active tree because they do not yet compile. They are not completed tools.

An uncommitted integration diff is also preserved locally for review only at `.tmp/mcp-erasure-recovery-20260916/incomplete-working-changes.patch` in the existing Review worktree. Do not automatically apply it.

The draft needs correction of: the unavailable-view revision union, the narrow `InpaintingJobRevisionStore` interface, and a complexity violation in single-image validation. Typecheck reported these errors; no functional tests or native replay acceptance ran for this feature.

The correction request through Remote Desktop Commander was blocked because the tool could not determine its security state. It was not retried via another tool. The incomplete code is withdrawn instead of leaving a broken build or claiming it passed.

## Next legitimate implementation/verification

When source editing is available, resume from the documented design and draft history, preserve existing storage guards and lock behavior, and add deterministic tests before enabling tools. Cover inspect/undo/redo, original and other-block preservation, stale revisions/manual changes, duplicate request IDs/opposite-action replay, wrong owner, missing/released history or files, permission revocation at commit, disconnect/cancel, and artifact retention. Then wire isolated native erasure -> inspect -> undo -> redo without real model loading and compare original/result pixels. Live connector schema refresh and UI approval remain separate from isolated tests.

This attempt only read capabilities on the live connector. User artwork, authorization, model configuration and the running app were not changed.
