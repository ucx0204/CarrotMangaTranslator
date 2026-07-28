/**
 * Formatting-focused access to shared geometry normalization.
 *
 * Keep renderer formatting features behind one dependency edge while
 * preserving `shared/geometry` as the implementation and public API source.
 */
export {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
  applyEditableBlockBbox,
  clamp,
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  resolveEditableBlockBbox,
  resolveFontWidthScale,
} from "../../../shared/geometry";
