import type { SourceTextDirection } from "../../shared/textTypes";
import {
  measureComponentAffinity,
  type ComponentAffinityMeasurement,
} from "./sourceFontSizeComponentAffinity";
import { estimateSourceFontFace } from "./sourceFontSizeGeometry";
import { estimateLineCount } from "./sourceFontSizeMath";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { refineSourceFontFaceWithBody } from "./sourceFontSizeBodyEvidence";

/** OCR dots are an ambiguous occupancy hypothesis, not a new source column. */
export function measureSourceFontFaceForText(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  text: string,
  geometryConsensus: boolean,
) {
  const selected = selectSourceTextHypothesis(
    core,
    direction,
    text,
    geometryConsensus,
  );
  return {
    ...selected,
    estimate: selected.estimate
      ? refineSourceFontFaceWithBody(
          core,
          direction,
          selected.glyphCount,
          selected.estimate,
        )
      : null,
  };
}

function selectSourceTextHypothesis(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  text: string,
  geometryConsensus: boolean,
) {
  const count = (value: string) =>
    Array.from(value).filter((g) => !/^\s$/u.test(g)).length;
  const glyphCount = count(text);
  const compactCount = count(text.replace(/\.{3}/gu, "…"));
  const estimate = estimateSourceFontFace(core, direction, glyphCount, {
    geometryConsensus,
  });
  const baseline = { estimate, glyphCount };
  if (compactCount < 2 || compactCount === glyphCount) return baseline;
  const cross = direction === "vertical" ? core.width : core.height;
  const major = direction === "vertical" ? core.height : core.width;
  const rawLines = estimateLineCount(glyphCount, cross, major);
  const compactLines = estimateLineCount(compactCount, cross, major);
  const rawBody = measureComponentAffinity(core, direction, rawLines);
  const compactBody = measureComponentAffinity(core, direction, compactLines);
  const bodyFace = resolveStableBodyFace(rawBody, compactBody);
  if (bodyFace === null) return baseline;
  const alternative = estimateSourceFontFace(core, direction, compactCount, {
    geometryConsensus,
  });
  if (!alternative) return baseline;
  const alternativeError = ratio(alternative.facePx, bodyFace);
  if (
    alternativeError > 1.15 ||
    (estimate && alternativeError >= ratio(estimate.facePx, bodyFace))
  )
    return baseline;
  return { estimate: alternative, glyphCount: compactCount };
}

function resolveStableBodyFace(
  raw: ComponentAffinityMeasurement | null,
  compact: ComponentAffinityMeasurement | null,
): number | null {
  if (
    !raw ||
    !compact ||
    Math.min(raw.confidence, compact.confidence) < 0.7 ||
    Math.min(raw.primaryMassShare, compact.primaryMassShare) < 0.65 ||
    ratio(raw.primaryFace, compact.primaryFace) > 1.12
  )
    return null;
  return Math.sqrt(raw.primaryFace * compact.primaryFace);
}

function ratio(a: number, b: number): number {
  return Math.max(a / Math.max(1, b), b / Math.max(1, a));
}
