> Historical first checkpoint. Current implementation and verification are in
> `mcp-context-migration-connected-checkpoint-20260920.md` (verified source
> `74c6dd52`). Desktop access, native migration publication and retained Undo/Redo
> are now verified. Bundle 9 still needs memory refresh and multi-work research.

# Bundle 9 continuation: whole-work context reference inspection

Status: IN PROGRESS. Bundle 9 is not complete; do not begin bundle 10.
Continue only `feat/mcp-app-bridge`. Bundles 1-8 remain completed with their
previous automatic evidence; live acceptance remains deferred until all thirteen
bundles are implemented.

The user-PC Remote Desktop Commander device is offline in this continuation.
Repository writes use the authorized GitHub connection. Do not claim the user's
worktree was synchronized, tests ran on that PC, or the live app was restarted.
No user artwork, library, credentials, model assets or tunnel settings were changed.

## Implemented in this continuation

`carrot_get_context_references` is connected to actual desktop composition and a
strict output schema. It is an approved-connection, read-only `carrot.read` tool;
editing, processing and image permissions are not required.

The anchor chapter resolves its work, then the native existing library read lock
covers every saved chapter in that work's declared order. Missing chapters are
not filtered away. Raw story memories, including orphan rows, remain visible to
the inspection policy. The normal per-chapter context/edit tools are unchanged.

The result locates block speaker/glossary and memory character/glossary references.
It distinguishes active, disabled, absent and duplicate-ID/ambiguous entries,
duplicate links, orphaned memory rows and duplicate page-memory rows. It returns
identifiers and counts, not names, story text, image bytes or local paths. The same
page ID in different chapters remains qualified by chapter. Ambiguous chapter,
page or block identities are rejected rather than silently merged.

Pagination requires the first result's fingerprint after offset zero. That
fingerprint binds the anchor, filters, whole-work context, chapter order, page order
and canonical page revisions. Regenerated timestamps of absent default root context
files do not change it. Changing another chapter or the filter invalidates the
continuation. Filters change the reference list, not whole-work counts.

Current limits: 100 chapters, 1,000 pages, 100,000 blocks, 200,000 references/memory
rows; 100 selected entry IDs and 100 returned references per call. Capacity errors
return no apparently complete partial inventory. No semantic name matching or
memory freshness certification is performed.

## Verification status

Tests have been added for pure projection, malformed input, whole-work pagination,
prototype-looking IDs, disabled/absent/ambiguous entries, unchanged source data,
authorization/revocation, actual native reads, missing chapters and real desktop
tool registration with editing disabled. GitHub Windows checkpoint verification
is being used because the user's PC is unavailable. No unobserved test success or
full-gate success is claimed in this checkpoint.

The three new production modules still require measurement-based coverage inventory
registration. Existing floors and provenance must not be reduced. Source-specific
architecture consumers must be reviewed rather than hiding dependencies behind
forwarding wrappers. The normal checkpoint formatter now covers shared MCP contracts
and the directly changed native context facade as well as existing MCP files.

## Exact next implementation steps

1. Finish the current reference-inspection tests, static gates and measured new-module
   inventory; capture the exact verified source commit and CI results.
2. Add explicit glossary/character merge, deletion and replacement plans, preserving
   manual entries by default. Use exact IDs and explicit mappings, not inferred
   same-name identity. Preview all affected blocks and memories across the work.
3. Publish context plus migrated references through the existing native transaction
   and retained-history boundaries; do not expose apply until source, membership,
   authority and exact recovery validation are connected. Preserve unrelated text,
   formatting, coordinates, original images and optional property absence.
4. Connect work-wide exact undo/redo, stale-memory inspection and selected refresh.
   Internet research must not be stored as already-read chapter events.
5. Reuse existing single-work research and bundle-eight orchestration for explicit
   multi-work research, ambiguous-title holds, partial failure and resume. Context
   replacement and modifying existing translated dialogue remain separate actions.

This continuation has not implemented or registered context merge/replacement/apply,
reference migration writes, their undo/redo, or multi-work research. The new read
inspection is a prerequisite, not a completion claim for those operations.
