# Connected typography checkpoint - 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
This supersedes the missing-production-binding section of
`mcp-typography-selective-checkpoint-20260918.md`. The previous records remain
historical evidence, not the current registration or static-check status.

## Bundle 1 implementation

Previously rejected source-evidence, shared context-lease and test-lint changes
were implemented through the GitHub connector. The source validator reads only
paths from saved library pages, streams bounded original-file hashes, checks
original dimensions, and checks font catalog/profile/runtime identity before AND
after reading originals. It preserves errors and rechecks authorization/expiry.
No downloads, model inference, image transfer or source modifications occur here.

The production adapter accepts only an owned, completed and unexpired
`carrot_run_typography_analysis` job for the requested chapter. It never accepts
caller-supplied evidence, arbitrary paths or whole-block replacements. Legacy
single-page `carrot_run_page_source_size` observations are not silently promoted
into this richer context-bound contract; use typography analysis in size mode.

The six registered application tools are:

- `carrot_preview_typography_batch`
- `carrot_get_typography_batch`
- `carrot_apply_typography_batch`
- `carrot_undo_typography_batch`
- `carrot_redo_typography_batch`
- `carrot_cancel_typography_batch`

Preview/select/apply/undo/redo/cancel reuse the existing batch lifecycle, canonical
font and source-size appliers, native page handoff and atomic save. Application is
registered only when editing AND processing are enabled. Inspect requires read
scope; the other tools require read/edit/process. Every operation remains owned.
The output registry has 66 strict contracts including these six tools.

Apply/redo hold the existing nonwaiting context/dependency leases after native
page handoff. They recheck full analysis scope and original/font evidence before
saving. Revisions advance only from this plan's acknowledged commits. Cancellation
stops future saves; partial saves remain explicit and can be undone independently.
Undo requires the current target revision and membership but does not require
expired observation data, removed fonts or missing originals to be re-created.
It restores exact optional-field absence and never overwrites later user edits.

App-owned dependency edits are excluded while a forward save is in progress.
Out-of-process filesystem replacement is detected by byte checks, not prevented
by an operating-system-wide file lock. Catalog snapshots identify registry
metadata and canonical candidate/runtime descriptors, not font binary hashes or
a per-string glyph-coverage proof. No stronger guarantee is claimed.

## Scope and next work

Bundle 1 is connected; final automatic checks and measured new-module coverage
are recorded below when completed. Bundle 2 remains the next implementation:
independent bubble layout, advanced typography and reusable rules/presets.
Bundles 2-13 are not completed by this change.

Actual C23 inference/quality, live ChatGPT/Tailscale calls and final client file
acceptance remain deferred until the requested implementation sequence is built.
No running user app was restarted; user artwork, library, credentials, approved
model assets, master and releases were not changed. Undo/history remains bounded
and session-only; durable recovery is still bundle 7, not completed here.
