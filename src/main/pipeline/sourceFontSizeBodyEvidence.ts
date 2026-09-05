import type { SourceTextDirection } from "../../shared/textTypes";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { measureComponentAffinity } from "./sourceFontSizeComponentAffinity";
import { measureMajorAxisPitch } from "./sourceFontSizeMajorPitch";
import { estimateLineCount } from "./sourceFontSizeMath";

/** Reconcile a narrow projection with independently repeated body strokes. */
export function refineSourceFontFaceWithBody(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  estimate: SourceFontSizeEstimate,
): SourceFontSizeEstimate {
  const cross = direction === "vertical" ? core.width : core.height;
  const majorExtent = direction === "vertical" ? core.height : core.width;
  const lines = estimateLineCount(glyphCount, cross, majorExtent);
  const component = measureComponentAffinity(core, direction, lines);
  const major = measureMajorAxisPitch(core, direction, glyphCount, lines);
  if (!component || !major) return estimate;
  const agreement = Math.max(
    component.primaryFace / major.face,
    major.face / component.primaryFace,
  );
  const bandRatio =
    Math.max(...major.bandFaces) / Math.max(1, Math.min(...major.bandFaces));
  if (
    component.confidence < 0.65 ||
    component.primaryMassShare < 0.6 ||
    major.confidence < 0.65 ||
    agreement > 1.12 ||
    bandRatio > 1.5
  )
    return estimate;
  const bodyFace = Math.sqrt(component.primaryFace * major.face);
  const ratio = bodyFace / estimate.facePx;
  if (ratio < 1.05 || ratio > 1.5) return estimate;
  return {
    ...estimate,
    facePx: Math.sqrt(estimate.facePx * bodyFace),
    confidence: Math.min(
      estimate.confidence,
      component.confidence,
      major.confidence,
    ),
  };
}
