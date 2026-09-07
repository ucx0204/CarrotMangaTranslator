# Transparent lettering readback loses visible ink

During frozen v0.4.3 discovery-004 candidate 4, page 4's actual final proposal
visibly contains 타닥 three times on the left and twice on the right. Both
background patches passed registration, and the final reviewer reported only
empty independent readback. This is a verifier-input defect, separate from the
failed artwork reconstruction on page 3.

## Exact evidence

Candidate artifact `readonly-readback-pixels-page-4-attempt-2/evidence.json`
binds the raw PNGs to the actual request's data URL SHA-256s. Both encode their
black strokes mainly in alpha; a black matte has zero pixels brighter than RGB 5. The raw first PNG displays black in direct inspection, while the two white
mattes visibly contain the expected three/two repeated words. They were not
applied to manga or substituted into the frozen candidate.

The separate `readback-alpha-preflight-v043/` preregistered exactly two independent
ephemeral Astra high calls through the frozen production `askAstraJson`, with
identical wording, schema and opaque probe IDs. Each call contains only one
condition; neither contains expected wording, source text or the other result.
Raw inputs produce two empty strings. White-matted inputs produce
`타닥\n타닥\n타닥` and `타닥\n타닥`. Both calls completed, 17,133 cumulative tokens,
zero ImageGen calls. Exact request hashes, outputs and usage receipts are saved.

This demonstrates a representation problem in this actual readback path. It
does not establish the undocumented server's internal alpha algorithm, a general
OCR accuracy gain, or a measured manga cost reduction.

## Required correction after the frozen report

Keep editable/generated assets as their original RGBA bytes. Produce explicit
opaque inspection images for blind readback, without adding expected text to
labels or prompts. Cover dark, light, mixed-color/outlined and partially
transparent lettering; white alone is insufficient for white-only lettering.
Reuse an existing raster/compositing gateway if available, with exact pixel
characterization and controlled blind-readback evidence. Preserve source asset
hashes and independent transcript comparison. Do not bypass the verifier, change
its answer to the expected string, or accept actual misspellings.

The current whole-chapter candidate remains unchanged until its persisted native
report is complete. Its wasted retries and eventual original restoration remain
part of the rejected evidence, not rewritten as if this fix had been present.

## Prepared correction and blind contrast proof

`correctness-preparation-v044/` holds copies only; production source, build and
fonts were not changed. The proposed request adapter creates white and black
opaque inspection copies of each original RGBA asset for readback stages only.
Both copies carry the same region ID with instructions to transcribe it once.
Other request stages and the stored/editable asset bytes remain unchanged.
Exact pixel characterization covers black, white, partially transparent red and
hidden transparent RGB; invalid non-PNG input is rejected before decoding.

`readback-contrast-preflight-v044/result.json` records one independent actual
Astra high call through the proposed request adapter, 12,440 cumulative tokens,
zero ImageGen calls. One asset has the original dark lettering and the other has
white lettering produced by RGB inversion with identical alpha. Four inspection
images represent two opaque IDs; no expected text or source translation is in
the model input. It returns exactly three and two repeated 타닥 respectively.
Inspection 1 (dark on white) and inspection 4 (white on black) were directly
viewed. This validates this representation/integration case, not general OCR
accuracy, manga quality or cost savings. Production integration and tests still
follow the frozen whole-chapter report.

### Integrated engineering correction

After the frozen report and direct audit, the adapter was applied to production
source. `correctness-preparation-v044/verified.json` records its final source
hashes and all 26 repository checks passing. Request evidence binds both the
original asset data URLs and the actual transmitted opaque views. Stored alpha
assets remain unchanged. This closes the demonstrated adapter defect; it does
not establish new manga quality or close any required complex-effect regression.
