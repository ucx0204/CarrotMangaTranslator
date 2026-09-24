# Independent typography analysis boundaries — 2026-09-18

This is bundle 1 observation work, not source-match application or complete
automatic typography. No live app, user artwork or real model acceptance is run.
Selective application and exact undo/redo remain the next unfinished boundary.
The existing source-size single-page path remains available.

## Execution and evidence

`carrot_run_typography_analysis` uses the existing operation store and app job
lifecycle. It binds explicit page/revision pairs, preflight/catalog snapshots,
chapter order/membership, context revision and original-image byte hashes.
Font mode reuses the approved C23 chapter port without changing its selection
algorithm or model assets. Size-only mode uses the existing raster estimator and
never invokes the font/OCR runtime. Source projection is shared with the original
single-page measurement adapter instead of duplicating coordinate conversion.

C23 requires explicit Japanese-to-Korean OCR and app-managed asset-download
permission. Installed-only C23 preparation is not exposed yet. One CPU OCR worker
and the existing exclusive local-model lease are used; cleanup failures keep the
shared model barrier blocked and preserve any primary failure as well.

Results are expiring observations with no image/font-file/attachment payload.
Font choices have no invented calibrated score and are not approved style edits;
manual work-profile locks must still be evaluated by the later application path.
Generated/sound/empty blocks and protected manual sizes retain exclusion reasons.
No source/translation/style/image save function is imported by the analyzer.
Scope remains the explicit selected pages, not an implicit whole-chapter expansion.

## Dependency boundaries

The source adapter owns raster evidence; the font runtime owns C23 options,
profile/asset identity and canonical engine invocation; the application service
receives ports and has no Electron/library-store/model imports. The tool/session
compose the existing authorization, journal, job lease and renderer handoff.

Only exact additional consumers of established shared authorities are recorded:
logger 38, pageRevision 54, blockFingerprint 32, typed MCP errors 61, library
facade 43, and page-operation composition 21 runtime imports. Defaults remain
12 imports / 25 consumers. There is no general exemption or forwarding facade.
Geometry has no extra consumer after sharing source projection with single-page
measurement. Each new source/runtime module stays within the normal import limit.

Automatic acceptance exercises strict inputs, snapshot and original-byte changes,
per-block exclusions, no page writes, owner isolation, idempotency, cancellation,
expiry, durable receipt stripping, and cleanup fencing. HTTP tests use a temporary
library and acknowledge only its clean fixture pages at the renderer boundary.
They do not acknowledge or modify the user's live editor.

The C23 process itself is an external fake in these automated adapter tests;
raster math, argument conversion, saved data, source hashes, job ownership and
HTTP/authorization are real implementation paths. Real C23 quality/cleanup and
client/download behavior remain deferred to final integrated live acceptance.
