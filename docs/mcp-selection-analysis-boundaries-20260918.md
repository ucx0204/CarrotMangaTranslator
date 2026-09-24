# Bundle 3 observation boundary - 2026-09-18

This is the independent selected OCR/translation slice of bundle 3, not its
analysis-bound application, region insertion or block-reference editor.
The attempted new selection-edit projection was refused by the tool checker.
It was not installed; the unused edit contract was removed rather than exposed.

Three tools are composed through the existing app MCP session:
`carrot_run_selection_ocr`, `carrot_run_selection_translation`, and
`carrot_get_selection_analysis`. The first two require read/process authority;
result lookup requires read authority and the completed job's connection owner.
Images and credentials are never returned, and none of the tools saves artwork.

Explicit scope: one chapter, 1-20 pages, at most 100 selected targets in total.
All source targets are validated before the first inference. Saved block OCR uses
known-block crop mode; explicit regions use native page-crop mode. Source pixels,
containing-pixel rounding, OCR projection and overlap math reuse existing code.
No existing block is replaced and no discovery is silently appended.

Translation uses the existing text-only engine, one request per eligible block,
sequentially. It is not joint page/chapter translation. Expected provider must
match the app; task-local language/context options do not rewrite global settings.
Nonempty translations are protected unless overwrite is explicitly requested;
there is no fabricated manual-translation flag. Generated/empty-source blocks
are excluded. Hosted HTTPS API/Codex requires explicit external-text permission;
managed local OCR/Gemma requires asset permission. Installed-only preparation
and local compatible HTTP providers are not exposed by this slice.

## Lifecycle and freshness

The native app job/page/model leases are retained across the complete request.
Every original hash, selected page revision and context/membership snapshot is
rechecked before evidence publication. Inference and cleanup must both finish;
progress-listener failure cannot skip OCR cleanup. Failures and cancellation
publish no partial analysis and trigger no automatic paid retry.

A discovered integration defect was fixed: ActiveJobStore.run resets execution
settings unless supplied, so selected analysis now re-enters its captured settings
inside that native job boundary. Existing job defaults and queues are unchanged.

Evidence is bounded to 16 records and one million serialized characters per
analysis, expires 30 minutes after completion, and is unavailable after restart.
Job receipts survive without the evidence or source hashes. Result lookup cannot
resurrect or rerun an expired analysis and cannot read another connection's job.
Shutdown rejects late publication even when external cleanup completes afterward.

Six exact additional canonical-boundary declarations are documented in the
architecture baseline: languages 33, geometry 42, typed MCP errors 76, library
facade 52, output composition 15 imports and page-operation composition 24.
Default limits remain 12 imports / 25 consumers. No alternate parser, geometry
algorithm, error authority, forwarding facade or GPU queue was added.

Automatic tests use isolated libraries/settings and the real save-free adapters,
original byte reads/crops, context reader, operation journal, page handoffs and
OAuth/HTTP. Only native raster/model transport boundaries are substituted.
No live user app restart, real inference, model download, user-artwork change,
authentication migration, master merge or release is part of this checkpoint.
