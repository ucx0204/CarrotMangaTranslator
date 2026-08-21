export {
  CRUDE_SOURCE_GLYPH_COMPONENT_PROFILE,
  CRUDE_UNASSIGNED_OCR_RESIDUAL_PROFILE,
  REFINED_SOURCE_GLYPH_COMPONENT_PROFILE,
  REFINED_UNASSIGNED_OCR_RESIDUAL_PROFILE,
  SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION,
  type RawOcrGlyphHint,
  type SourceGlyphComponentResidual,
  type SourceGlyphComponentResidualDiagnostic,
  type SourceGlyphComponentResidualProfile,
  type UnassignedOcrHintResidualDiagnostic,
  type UnassignedOcrResidualProfile,
} from "./sourceGlyphResidualDiagnosticTypes";
export { measureSourceGlyphComponentResiduals } from "./sourceGlyphComponentResidual";
export { measureUnassignedOcrHintResiduals } from "./unassignedOcrResidual";
export { resolveUnassignedOcrProvenance } from "./unassignedOcrResidualProvenance";
