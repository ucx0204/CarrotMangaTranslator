# Transformed foreground protection · v0.4.2 defect, v0.4.3 verified correction

Observed during the frozen v0.4.2 discovery-004 candidate 3 run. No production
source, compiled output, fonts, model inputs or manga artifact was changed.

`preservedReadingConflicts` and `failedRegionClosure` compare source and
untransformed render boxes. Actual production foreground can rotate and warp.
Consequently, the automatic keep guard and restoration closure can both miss
visible translated ink over source that must be preserved.

Synthetic reproduction uses the existing saved partial-reading QA page and the
actual production page exporter. No model calls or corpus reuse. The definitive
artifact is `.tmp/astra-typesetting-research/transformed-keep-probe-v042-003/`:
600×800 page; render rectangle 180,320,240,80 pixels; `MM`, 64 px; 90° rotation.
Actual renderer telemetry reports one line and `overflow: false`. There are
726 foreground pixels outside the unrotated box; pixel 307,315 is changed by the
rendered translation. Making that observed pixel a keep region yields zero
guard issues, and making it a restored failed source region leaves the rotated
translation outside the failure closure. The native raster was directly viewed.

Probe 1 failed because the diagnostic supplied unsupported block properties to
the strict export schema; its error is retained. Probe 2 reproduced the guard
miss with `MMMM` but also wrapped a line, so probe 3 isolates it from ordinary
layout overflow. These diagnostics are not a manga candidate or quality pass.

Fix after the current trial and its persisted report are complete. Reuse the
existing `resolveTransformedBlockBounds`/boundary geometry instead of inventing
another transform implementation. Apply transforms in actual pixel coordinates
on non-square pages, then compare in one consistent coordinate space. Both keep
protection and restoration closure require characterization for rotation,
warping, non-square pages and untransformed parity; account explicitly for ink
overflow/outline beyond the nominal box. Do not alter protected global geometry
authority casually. Verify with the same production renderer and preserve the
initial-plus-two repair budget.

Until fixed and verified, v0.4.2 cannot be promoted even if automatic visual
review happens not to report this condition in the current chapter. The original
user's generated-background seam issue remains a separate unfinished check.

Correction was implemented only after candidate 3's persisted fourteen-page
report and original-render pixel comparison completed. Production v0.4.3 renders
each block alone through the existing native transparent page exporter and uses
all nonzero-alpha painted bounds in both guards. This covers actual curves,
outlines, generated layers and font overhang. Bounds are conservative rectangles,
not an exact per-pixel overlap mask. Existing transform geometry is the fallback
for older ports, computed in pixel space before normalization; missing production
transparent rendering or rescaled output fails. Actual renderer overflow becomes
a deterministic repair issue. The initial plus two repair budget is unchanged.

`painted-protection-proof-v043/result.json` records five actual production
fixtures: rotation, warp, curve, outline and generated layer. Each uses a pixel
observed to change in the real render as its keep region, detects the conflict,
includes the block in restoration closure and restores every final pixel to the
original production baseline. All five output variants and the preserved rotation
were directly viewed; the five restored images are pixel-identical to baseline.
Native empty transparency is verified. No manga or model call was used. Focused
tests and the complete 26-gate check/build passed. This closes this engineering
defect, not the user's separate seam-quality report or the promotion gate.

## Separate over-rejection found during frozen v0.4.3

The new actual painted evidence exposes a different pre-existing predicate
problem on candidate 4 page 1. `preservedReadingConflicts` also rejects source
bounding-box intersection unconditionally. Subtitle/English-logo and
promotion/diamond boxes overlap in their small bounding margins, although the
accepted production erase masks contain zero protected pixels and the actual
painted bounds do not intersect either keep box. A read-only replay of the
production predicate with those recorded inputs still reports both regions.

Evidence is `discovery-004/candidate-004/readonly-source-box-protection-probe.json`
with input hashes, exact boxes and zero protected-permission counts. The actual
first native render was directly viewed. This probe does not change the frozen
candidate or create another manga trial. Promotion must also address this
over-rejection: use the appropriate actual erasure/painted authority, preserve
failure restoration closure and keep-pixel protection, and characterize existing
source-overlap cases before changing the predicate. Do so only after the current
whole-chapter run and immutable persisted report finish. Do not count repeated
layout calls on fixed source geometry as an effective repair of this condition.
