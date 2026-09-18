# MCP independent typography checkpoint — 2026-09-18

## First verified unit: read-only font inventory and preparation

Base: `bb37822e` on `feat/mcp-app-bridge`; same review worktree.
No user library, model artifacts, credentials, or running app were changed.

Registered `carrot_list_fonts` and `carrot_preflight_typography` as read-only
`carrot.read` tools with strict input/output contracts. Queries use actual app
font catalog/registry metadata without legacy font migration or directory creation.
Original default registry query behavior remains unchanged.

Preflight reports explicit ordered targets, revisions, C23 ja-to-ko OCR requirement,
size-only independence, generated/sound/empty-source exclusions and manual-size
protection. It performs no analysis, rendering, downloading or page writes.
`inputs_available` is NOT runtime readiness. `analysisToolAvailable` is false until
an actual executor is registered; no placeholder analysis success is returned.
Catalog snapshots bind metadata, not font file bytes; base face metadata is not
complete weight/style or per-string glyph coverage. Missing/unsafe custom files
are omitted by the existing registry; uninspectable existing custom files are marked.

Verified first unit: 32 tests across typography reads, actual font catalog, and
existing custom font registry; Electron TypeScript and changed-file ESLint pass.
Full repository, measured coverage registration, and native/live invocation are
not yet verified for this unit.

## Pending

Independent model/raster analysis, analysis-result binding to revisions/catalog,
selective application and exact source-size state undo/redo, native parity,
coverage and full checks. Do not mark the full typography bundle complete yet.
