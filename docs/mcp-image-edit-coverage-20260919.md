# Image editing coverage - 2026-09-19

Baseline: `25bbe155`. Initial measured production code: `cef9bf12`.
The full Windows Vitest/V8 measurement completed with 7,804 passing tests,
one missing-inventory-registration failure and 11 pre-existing skips.
That failure listed precisely the nine new image-edit production modules; it did
not indicate a failed image operation. All 48 focused cases across nine files
passed, including 33 new image-edit cases and 15 existing regressions.

## Preserved evidence

All 1,601 inherited floor rows, provenance and ten deletion entries were compared
against the baseline and preserved exactly. The original 753 rows remain unchanged;
introduced rows move from 848 to 857, for 1,610 total rows. Only the nine actually
measured new modules were added. Global coverage and architecture limits stay on.

Initial full measurement: `coverage/coverage-summary.json`.
Source SHA-256:
`a1c696873073cbe93b25788ecc049378ee4929b696854ebdeb233beb513d0137`
Inherited manifest SHA-256:
`db8bd2cc3fddd7e5390a09f623f61ac1e592f56492cea6c2ac3810537efad659`
Per-file ratios and immutable comparison proof: `.tmp/mcp-image-coverage-evidence.json`.

New-module totals only: lines 351/377; statements 377/404; functions 85/85;
branches 195/230. These are not whole-repository coverage percentages.
The exact production coverage-floor command passed after registration, comparing
753 Windows baseline rows and 857 introduced rows, with ten unchanged deletions.
The subsequent full stage-graph result and its exact code SHA belong in the checkpoint.

## Native boundaries

Unit/integration tests substitute only Electron image I/O and local-model inference
at their external boundaries. Real PNG bytes, native mask calculation, pixel-space
conversion, retouch rasterizers, page/model activity, library transactions, retained
image history and OAuth/HTTP execute against isolated fixtures. Adversarial inference
attempts to modify every RGBA pixel; final output outside the reviewed mask is checked
byte-for-byte. Native glyph-mask and unprotected retouch parity tests use the app's
actual calculation functions. Model quality and live client behavior remain deferred.

The extra real-Electron image-edit script extends the existing isolated native smoke
runner, with mask/paint/color/original-restore/history assertions and no model calls
for the new checks. Its execution status must be recorded separately after it runs.
