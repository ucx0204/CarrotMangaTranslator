import type { SourceTextDirection } from "../../shared/textTypes";
import {
  measureComponentAffinity,
  type ComponentAffinityMeasurement,
} from "./sourceFontSizeComponentAffinity";
import { estimateSourceFontFaceWithGeometryConsensus } from "./sourceFontSizeGeometryConsensus";
import type {
  SourceFontSizeEstimate,
  SourceFontSizeGeometryOptions,
} from "./sourceFontSizeGeometryTypes";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { measureLineFaces } from "./sourceFontSizeProjection";

const CORRECTION_INTERCEPT = 0.079120888;
const CORRECTION_COEFFICIENTS = [
  -0.030603014, -0.047621106, -0.00116429, 0.016540932, -0.000914398,
  0.010149604, -0.003390012, -0.01587488, 0.014583797,
] as const;
const LEARNED_CORRECTION_BLEND = 0.35;
const SOURCE_FACE_SCALE = 1.02;
const COMPONENT_STRONG_DISAGREEMENT_CONFIDENCE = 0.62;
const COMPONENT_STRONG_DISAGREEMENT_MIN = 0.68;
const COMPONENT_STRONG_DISAGREEMENT_MAX = 1.47;
const COMPONENT_BLEND_MIN = 0.82;
const COMPONENT_BLEND_MAX = 1.22;
const COMPONENT_FACE_BLEND = 0.22;

type ProjectionEvidence = Readonly<{
  agreement: number;
  bboxCross: number;
  bboxMajor: number;
  componentMeasurement: ComponentAffinityMeasurement | null;
  componentRatio: number | null;
  dispersion: number;
  expectedLines: number;
  lineAgreement: number;
  pitch: number;
  rawFace: number;
}>;

/**
 * Measure the visible source-glyph face, not the detector box. The fixed
 * correction is a compact distillation of the held-out synthetic calibration
 * used by the research harness; it does not load an ML runtime in production.
 */
export function estimateSourceFontFace(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  options: SourceFontSizeGeometryOptions = {},
): SourceFontSizeEstimate | null {
  if (glyphCount < 2 || glyphCount > 160) return null;
  if (options.geometryConsensus === true) {
    return estimateSourceFontFaceWithGeometryConsensus(
      core,
      direction,
      glyphCount,
      (lineCount) =>
        estimateSourceFontFaceFromProjection(core, direction, glyphCount, {
          componentAffinity: false,
          lineCountOverride: lineCount,
        }),
    );
  }
  return estimateSourceFontFaceFromProjection(
    core,
    direction,
    glyphCount,
    options,
  );
}

function estimateSourceFontFaceFromProjection(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  options: SourceFontSizeGeometryOptions,
): SourceFontSizeEstimate | null {
  const evidence = measureProjectionEvidence(
    core,
    direction,
    glyphCount,
    options,
  );
  if (!evidence) return null;
  const facePx = resolveCorrectedProjectionFace(
    core,
    direction,
    glyphCount,
    evidence,
  );
  if (facePx === null) return null;
  return {
    confidence: clamp(
      resolveConfidence(evidence) +
        componentConfidenceAdjustment(
          evidence.componentMeasurement,
          evidence.componentRatio,
        ),
      0.5,
      0.94,
    ),
    facePx,
    method: "raster-core-v1",
  };
}

function measureProjectionEvidence(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  options: SourceFontSizeGeometryOptions,
): ProjectionEvidence | null {
  const bboxCross = direction === "vertical" ? core.width : core.height;
  const bboxMajor = direction === "vertical" ? core.height : core.width;
  const expectedLines = resolveExpectedLineCount(
    options.lineCountOverride,
    glyphCount,
    bboxCross,
    bboxMajor,
  );
  const faces = measureLineFaces(core, direction, expectedLines);
  if (faces.length === 0) return null;

  const coreFace = median(faces);
  const lineCross = bboxCross / Math.max(1, expectedLines);
  const glyphsPerLine = Math.max(1, glyphCount / Math.max(1, expectedLines));
  const pitch = bboxMajor / glyphsPerLine;
  const rawFace = Math.min(coreFace, lineCross * 1.06, pitch * 1.08);
  // Component affinity is an opt-in laboratory path until a locked-chapter
  // visual audit proves it can improve projection without losing coverage.
  // Keeping the default projection-only also prevents rejected experiments
  // from leaking into the currently promoted app version.
  const componentMeasurement =
    options.componentAffinity === true
      ? measureComponentAffinity(core, direction, expectedLines)
      : null;
  const componentRatio = componentMeasurement
    ? componentMeasurement.primaryFace / Math.max(1, rawFace)
    : null;
  if (hasStrongComponentDisagreement(componentMeasurement, componentRatio))
    return null;
  const dispersion = relativeDispersion(faces);
  const agreement = rawFace / Math.max(1, pitch);
  const lineAgreement = rawFace / Math.max(1, lineCross);
  if (
    !isReliableMeasurement({
      agreement,
      componentCount: core.componentCount,
      dispersion,
      foregroundRatio: core.foregroundRatio,
      glyphCount,
      lineAgreement,
      rawFace,
    })
  )
    return null;

  return {
    agreement,
    bboxCross,
    bboxMajor,
    componentMeasurement,
    componentRatio,
    dispersion,
    expectedLines,
    lineAgreement,
    pitch,
    rawFace,
  };
}

function resolveExpectedLineCount(
  lineCountOverride: number | undefined,
  glyphCount: number,
  bboxCross: number,
  bboxMajor: number,
): number {
  if (!Number.isInteger(lineCountOverride) || Number(lineCountOverride) < 1) {
    return estimateLineCount(glyphCount, bboxCross, bboxMajor);
  }
  return clamp(
    Number(lineCountOverride),
    1,
    Math.max(1, Math.min(12, Math.ceil(glyphCount / 2))),
  );
}

function hasStrongComponentDisagreement(
  measurement: ComponentAffinityMeasurement | null,
  ratio: number | null,
): boolean {
  return Boolean(
    measurement &&
    measurement.confidence >= COMPONENT_STRONG_DISAGREEMENT_CONFIDENCE &&
    ratio !== null &&
    (ratio < COMPONENT_STRONG_DISAGREEMENT_MIN ||
      ratio > COMPONENT_STRONG_DISAGREEMENT_MAX),
  );
}

function resolveCorrectedProjectionFace(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  evidence: ProjectionEvidence,
): number | null {
  const {
    bboxCross,
    bboxMajor,
    componentMeasurement,
    componentRatio,
    dispersion,
    expectedLines,
    pitch,
    rawFace,
  } = evidence;

  const features = [
    rawFace / Math.max(1, bboxCross / Math.max(1, expectedLines)),
    rawFace / Math.max(1, pitch),
    bboxCross / Math.max(1, bboxMajor),
    core.foregroundRatio,
    core.componentCount / Math.max(1, glyphCount),
    Math.log1p(glyphCount),
    expectedLines,
    dispersion,
    direction === "vertical" ? 1 : 0,
  ];
  const correction = clamp(
    CORRECTION_INTERCEPT +
      features.reduce(
        (sum, value, index) =>
          sum + value * (CORRECTION_COEFFICIENTS[index] ?? 0),
        0,
      ),
    -0.2,
    0.2,
  );
  let facePx = clamp(
    rawFace *
      Math.exp(correction * LEARNED_CORRECTION_BLEND) *
      SOURCE_FACE_SCALE,
    1,
    512,
  );
  if (
    componentMeasurement &&
    componentRatio !== null &&
    componentRatio >= COMPONENT_BLEND_MIN &&
    componentRatio <= COMPONENT_BLEND_MAX
  ) {
    facePx = blendComponentFace(facePx, componentMeasurement.primaryFace);
  }
  return Number.isFinite(facePx) && facePx > 0 ? facePx : null;
}

function blendComponentFace(facePx: number, componentFacePx: number): number {
  const componentFace = componentFacePx * SOURCE_FACE_SCALE;
  return clamp(
    Math.exp(
      Math.log(Math.max(1, facePx)) * (1 - COMPONENT_FACE_BLEND) +
        Math.log(Math.max(1, componentFace)) * COMPONENT_FACE_BLEND,
    ),
    1,
    512,
  );
}

function componentConfidenceAdjustment(
  measurement: ComponentAffinityMeasurement | null,
  ratio: number | null,
): number {
  if (!measurement || ratio === null) return 0;
  const distance = Math.abs(Math.log(Math.max(0.01, ratio)));
  if (distance <= Math.log(1.12)) {
    return 0.04 * measurement.confidence;
  }
  if (distance <= Math.log(1.28)) return 0;
  return -0.08 * measurement.confidence;
}

function isReliableMeasurement(input: {
  agreement: number;
  componentCount: number;
  dispersion: number;
  foregroundRatio: number;
  glyphCount: number;
  lineAgreement: number;
  rawFace: number;
}): boolean {
  return !(
    input.rawFace < 6 ||
    input.foregroundRatio < 0.003 ||
    input.foregroundRatio > 0.47 ||
    input.componentCount > Math.max(20, input.glyphCount * 8) ||
    input.agreement < 0.34 ||
    input.agreement > 1.3 ||
    input.lineAgreement < 0.24 ||
    input.lineAgreement > 1.08 ||
    input.dispersion > 0.4
  );
}

function estimateLineCount(
  glyphCount: number,
  cross: number,
  major: number,
): number {
  if (glyphCount <= 1 || cross <= 0 || major <= 0) return 1;
  const estimate = Math.sqrt((glyphCount * cross) / major);
  const maximum = Math.max(1, Math.min(12, Math.ceil(glyphCount / 2)));
  return clamp(Math.round(estimate), 1, maximum);
}

function relativeDispersion(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = median(values);
  return (
    median(values.map((value) => Math.abs(value - center))) /
    Math.max(1, center)
  );
}

function resolveConfidence(input: {
  agreement: number;
  dispersion: number;
  lineAgreement: number;
}): number {
  const agreementPenalty = Math.min(1, Math.abs(input.agreement - 0.82) / 0.48);
  const linePenalty = Math.min(1, Math.abs(input.lineAgreement - 0.72) / 0.48);
  const dispersionPenalty = Math.min(1, input.dispersion / 0.4);
  return clamp(
    0.94 -
      agreementPenalty * 0.12 -
      linePenalty * 0.1 -
      dispersionPenalty * 0.16,
    0.5,
    0.94,
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
