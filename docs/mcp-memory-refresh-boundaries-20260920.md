# Bundle 9: memory refresh boundaries

Status: connected; all 26 automatic gates and isolated native checks passed.
Verified source: `e6495aa1`; final results are recorded in the checkpoint.
Bundle 9 remains in progress until multi-work research and retained proposals finish.

The three registered tools inspect saved text memory, preview a selected refresh and
apply that exact intent. No OCR, image access, translation, renderer, search provider
or model is executed. A native excerpt is deterministic existing-app text, not an
AI-authored synopsis. A reviewed summary is supplied by the calling AI/user and must
be about the saved page; source correctness and semantic quality are not certified.

## Data and evidence

Full source and translated strings, stored block order and speaker/glossary references
are fingerprinted with the existing canonical hash. The existing story-memory
builder produces excerpts. Legacy excerpts and timestamps do not prove freshness:
old memories report unknown. Edited summaries invalidate their previous evidence;
manual visual descriptions are preserved and explicitly not checked. Work catalog
changes conservatively stale the text proof. Chapter summaries are the existing
page-memory list, not a newly synthesized chapter-wide narrative.

Only explicitly selected saved pages change. Nonempty summaries require explicit
replacement consent. Duplicate rows reject refresh; orphan rows remain untouched.
Unselected memory rows, existing references, manual visuals, catalog and artwork are
preserved. Empty saved text rejects refresh rather than treating external web facts
or image-only observations as verified page-text memory. The native excerpt builder
retains its original stored-block-order behavior; no new inference algorithm exists.

## Publication and recovery

The native context application receives a trusted preparation callback, never raw
snapshots from a tool. Whole-work revision checks, structure/context ownership,
metadata-byte/presence checks, encrypted record quotas and the existing transaction
commit point are reused. Refresh creates a context retention record labelled with
its real operation. Existing context inspection/list/Undo/Redo/discard tools handle
it. The generic page-history wrapper is excluded because this operation owns its
mandatory encrypted context publication; no page text or image file is written.

Memory file presence is captured natively. Undo of a newly created memory file
removes only that file; both availability inspection and Redo reject a manually
recreated empty file using the same native presence rule. Old records
without presence metadata retain their previous behavior. Request replay never
reapplies an already-recorded refresh. Retention remains seven days/256 entries/1GiB;
32 recovery actions per record. This is restart-persistent, not unlimited history.

## Direct dependency declarations

New full-text evidence and memory policy directly consume blockFingerprint (74 total
consumers). The memory policy directly consumes pageRevision (69 total). New policy
and extracted actual recovery validation use McpEditError (137 total); the original
application no longer imports that error itself. The output composition root has
26 direct imports after registering this strict contract family. These are specific
measured declarations, not global ceiling changes or dependency-hiding wrappers.

## Tests and remaining verification

Focused pure/native/OAuth tests cover excerpt-tail edits, block-reference-only edits,
manual visual preservation, old-summary protection, no-op refresh, strict inputs,
read-only grants, disabled editing, other-owner denial, late grant revocation,
concurrent raw metadata changes, interrupted publication, reconstruction, exact
replay and absent-file restoration. Existing migration regressions still execute.
Full gate results and native Electron evidence belong in the checkpoint, not inferred
from tool registration. User artwork/authentication/live app/models are not touched.
