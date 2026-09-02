import {
  SOURCE_FONT_FACE_SCALE,
  type SourceFontSizeHypothesisPoint,
} from "./sourceFontSizeMath";
import type { SourceFontSizeHypothesisTrial } from "./sourceFontSizePeerGatedTypes";

export type MajorBandHypothesisPoint =
  SourceFontSizeHypothesisPoint<"major-band">;

export function createMajorBandHypothesisPoints(
  trial: SourceFontSizeHypothesisTrial,
): MajorBandHypothesisPoint[] {
  const measurement = trial.majorPitch;
  if (!measurement?.bandFaces.length) return [];
  const weight =
    measurement.confidence / Math.sqrt(measurement.bandFaces.length);
  return measurement.bandFaces.map((face) => ({
    confidence: measurement.confidence,
    face: face * SOURCE_FONT_FACE_SCALE,
    lineCount: trial.lineCount,
    source: "major-band",
    weight,
  }));
}
