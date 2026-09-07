import type { SourceTextDirection } from "../../shared/textTypes";
import {
  measureComponentAffinity,
  type ComponentAffinityMeasurement,
} from "./sourceFontSizeComponentAffinity";
import { estimateSourceFontFace } from "./sourceFontSizeGeometry";
import {
  buildCrossProfile,
  closeSmallGaps,
  estimateLineCount,
  findActiveRuns,
  SOURCE_FONT_FACE_SCALE,
} from "./sourceFontSizeMath";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { refineSourceFontFaceWithBody } from "./sourceFontSizeBodyEvidence";
import { measureLineFaces } from "./sourceFontSizeProjection";

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
      : recoverBodyBesidePunctuation(core, direction, text),
  };
}

/** A separate dot column is not another full-width text column. */
function recoverBodyBesidePunctuation(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  text: string,
) {
  if (!hasBodyAndPunctuation(text)) return null;
  const profile = buildCrossProfile(core, direction);
  const runs = closeSmallGaps(
    findActiveRuns(profile.map((value) => value > 0)),
    Math.max(1, Math.round(profile.length * 0.012)),
  );
  if (runs.length < 2 || runs.length > 4) return null;
  const widths = runs.map(([start, end]) => end - start);
  const widest = Math.max(...widths);
  if (!widths.some((width) => width <= widest * 0.3)) return null;
  const body = measureComponentAffinity(core, direction, runs.length);
  if (
    !body ||
    body.confidence < 0.7 ||
    body.primaryMassShare < 0.55 ||
    ratio(body.primaryFace, widest) > 1.15
  )
    return null;
  const faces = measureLineFaces(core, direction, runs.length);
  const matching = faces.filter(
    (face) => ratio(face, body.primaryFace) <= 1.15,
  );
  const [projectionFace] = matching;
  if (
    matching.length !== 1 ||
    projectionFace === undefined ||
    !faces.some((face) => face < body.primaryFace * 0.35)
  )
    return null;
  // Projection width and independently assembled body components agree. This
  // recovery neither rewrites the OCR string nor guesses a character count.
  return {
    confidence: Math.min(0.8, body.confidence),
    facePx:
      Math.sqrt(projectionFace * body.primaryFace) * SOURCE_FONT_FACE_SCALE,
    method: "raster-core-v1" as const,
  };
}

function hasBodyAndPunctuation(text: string): boolean {
  const body = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  );
  return /[….·・⋯⋮]/u.test(text) && body !== null && body.length >= 2;
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
