# Bundle 11: additional output formats and exchange

Status: IN PROGRESS; RASTER, LAYERED PSD AND NATIVE WORK-FILE OUTPUT VERIFIED.
Current isolated verification source: `a710c0b8f4b81b136354b5696bc2ea5ffccd262a`.
Read `mcp-work-file-export-checkpoint-20260923.md` for exact current evidence,
native-format limits and the preserved earlier failed attempt. The raster
checkpoint remains historical evidence for that completed slice.
Starting completed bundle-10 checkpoint: `714d3e08`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Code/tests are written through GitHub and verified through Remote Desktop Commander.
Preserve the user app, real library, credentials, model assets and Tailscale settings.
Live acceptance stays deferred until all bundles are implemented; no new branch,
master merge, dependency upgrade or release.

## Completed output slices

`carrot_export_pages_images` connects one to fifty reviewed pages in one chapter to
the native original-resolution PNG/JPEG/WebP renderer. Quality is explicit for JPEG
and WebP, and omitted for PNG. Text omission requires an already stored cleaned
background and never runs erasure automatically. Source/selection/options snapshots,
page handoff and activity ownership, redaction, permissions and cancellation remain.
The old PNG tools stay compatible.

Layered PSD uses the existing native capture/writer and preserves the original
background and supported native layers. Original-background and native typography
limitations require explicit acknowledgment. Actual native PSD layer parsing,
original pixels, ZIP packaging and reconstructed retained bytes pass at the current
source; the format is not a full font/history/profile backup.

`carrot_preflight_work_file_export` reviews selected editable chapters and source
evidence. `carrot_export_work_file` packages that reviewed selection with the existing
streaming `.mgtshare` v1 writer. Work/chapter titles and order, supported editable
blocks and references, original/processed image bytes and the work style guide are
preserved. Original-image inclusion and v1 memory/history limitations require
explicit acknowledgment. Working-file input remains the completed bundle-10 path.

The existing streaming ZIP writer packages exact produced page files with numbered
names, options and partial-result metadata. Retrieval remains explicit through the
existing job-file and retained-output tools. Polling never attaches files or exposes
URLs. Retained image/PSD/ZIP/work-file reissue after reconstruction does not rerender
or serialize again. Source, owner, corruption and permission checks remain.

## Current verification

All 26 repository gates passed at the current verified source in 350.48 seconds:
1,150 test files; 8,673 tests passed, zero failures and 11 inherited pending tests.
The build was a cache miss and rebuilt Electron and renderer inputs; native asset
outputs were reused only where the canonical content verifier found them unchanged.
The production-cleanup coverage gate passed with all 1,796 inherited records
unchanged and five measured records added, totaling 1,801. The introduced inventory
is 1,044. Nine exact per-file architecture allowances were recorded; defaults and
unrelated allowances remain unchanged.

Actual Electron then passed all seventeen required markers against that same fresh
build, including registered work-file export, editable incoming-file roundtrip,
HTTP bytes, reconstructed retained reissue, discard revocation and original/guide
preservation. Child and wrapper exited zero; listener 61906 closed; owned native
fixtures and the isolated profile were removed. All 4,426 tracked source/test/script/
configuration hashes matched before and after both executions.

The earlier `2bafc03988cca33b32a12c921253a414f9ae5b24` check failed the JavaScript
NodeNext import gate before tests/build. Its evidence remains preserved. The explicit
`.js` import fix was verified by the complete current check. Local isolated evidence
does not claim GitHub CI success or live client/model/maximum-byte acceptance.

## Remaining implementation slices

1. Explicit source-format selection: follow the native per-page format policy;
   never label arbitrary bytes as the requested type. At this checkpoint the raster
   tool accepts explicit PNG/JPEG/WebP, not a source-format option.
2. Review text/context exchange: reuse native serializers and reviewed application
   paths; preserve IDs/revisions, report unsupported fields, no implicit replacement.
3. Delivery diagnostics and approved output synchronization: distinguish generation,
   retained availability, link issuance and client receipt. No arbitrary URL fetch,
   filesystem paths, automatic attachments or unsupported client-success claims.

## Verification and handoff

Each remaining slice needs contract/HTTP, preserved-data, cancellation, source/
permission/redaction changes and reconstruction tests. Add actual Windows coverage
for introduced files without lowering old floors. Run all gates and the dedicated
native path before declaring a slice verified. Record exact source/exit evidence.
Partial bundle progress is not bundle completion: bundle 11 remains in progress,
and bundles 12 and 13 remain later work. Do not ask for live tests between units.
