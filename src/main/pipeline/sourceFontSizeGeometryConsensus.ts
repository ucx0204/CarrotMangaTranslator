import type { SourceTextDirection } from "../../shared/textTypes";
import {
  measureComponentAffinity,
  type ComponentAffinityMeasurement,
} from "./sourceFontSizeComponentAffinity";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import {
  measureMajorAxisPitch,
  type MajorPitchMeasurement,
} from "./sourceFontSizeMajorPitch";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";

const SOURCE_FACE_SCALE = 1.02;
const CONSENSUS_MAX_INDEPENDENT_RATIO = 1.3;
const CONSENSUS_MAX_UPWARD_INDEPENDENT_RATIO = 1.12;
const CONSENSUS_MAX_MAJOR_BAND_RATIO = 2;
const CONSENSUS_MINIMUM_REPEATED_GLYPHS = 8;
const CONSENSUS_MAX_UPWARD_LINE_FILL = 0.55;

type ProjectionEstimator = (lineCount: number) => SourceFontSizeEstimate | null;

type ConsensusGeometry = Readonly<{
  component: ComponentAffinityMeasurement;
  major: MajorPitchMeasurement;
}>;

type ConsensusRecovery = Readonly<{
  confidence: number;
  facePx: number;
  lineDistance: number;
  ratio: number;
}>;

export function estimateSourceFontFaceWithGeometryConsensus(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  estimateProjection: ProjectionEstimator,
): SourceFontSizeEstimate | null {
  const bboxCross = direction === "vertical" ? core.width : core.height;
  const bboxMajor = direction === "vertical" ? core.height : core.width;
  const formulaLineCount = estimateLineCount(glyphCount, bboxCross, bboxMajor);
  const projection = estimateProjection(formulaLineCount);
  if (glyphCount < CONSENSUS_MINIMUM_REPEATED_GLYPHS) return projection;
  if (projection) {
    return refineProjectionWithGeometryConsensus({
      bboxCross,
      core,
      direction,
      formulaLineCount,
      glyphCount,
      projection,
    });
  }
  return recoverProjectionWithGeometryConsensus(
    core,
    direction,
    glyphCount,
    formulaLineCount,
    estimateProjection,
  );
}

function refineProjectionWithGeometryConsensus(input: {
  bboxCross: number;
  core: SourceFontCoreMask;
  direction: SourceTextDirection;
  formulaLineCount: number;
  glyphCount: number;
  projection: SourceFontSizeEstimate;
}): SourceFontSizeEstimate {
  const geometry = measureConsensusGeometry(
    input.core,
    input.direction,
    input.glyphCount,
    input.formulaLineCount,
  );
  if (!geometry) return input.projection;
  const componentFace = geometry.component.primaryFace;
  const majorFace = geometry.major.face;
  const independentRatio = maximumRatio(componentFace, majorFace);
  if (independentRatio > CONSENSUS_MAX_INDEPENDENT_RATIO) {
    return input.projection;
  }
  const consensusFace =
    Math.sqrt(componentFace * majorFace) * SOURCE_FACE_SCALE;
  if (
    maximumRatio(input.projection.facePx, consensusFace) <=
    CONSENSUS_MAX_INDEPENDENT_RATIO
  ) {
    return input.projection;
  }
  const projectionLineFill =
    input.projection.facePx /
    Math.max(1, input.bboxCross / Math.max(1, input.formulaLineCount));
  if (
    consensusFace > input.projection.facePx &&
    (independentRatio > CONSENSUS_MAX_UPWARD_INDEPENDENT_RATIO ||
      projectionLineFill >= CONSENSUS_MAX_UPWARD_LINE_FILL)
  ) {
    return input.projection;
  }
  return {
    confidence: clamp(
      Math.min(geometry.component.confidence, geometry.major.confidence) -
        Math.abs(Math.log(componentFace / majorFace)) * 0.12,
      0.5,
      0.94,
    ),
    facePx: consensusFace,
    method: "raster-core-v1",
  };
}

function measureConsensusGeometry(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  lineCount: number,
): ConsensusGeometry | null {
  const component = measureComponentAffinity(core, direction, lineCount);
  const major = measureMajorAxisPitch(core, direction, glyphCount, lineCount);
  if (!component || !major) return null;
  return valueRatio(major.bandFaces) <= CONSENSUS_MAX_MAJOR_BAND_RATIO
    ? { component, major }
    : null;
}

function recoverProjectionWithGeometryConsensus(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  formulaLineCount: number,
  estimateProjection: ProjectionEstimator,
): SourceFontSizeEstimate | null {
  const maximumLines = Math.max(
    1,
    Math.min(12, Math.ceil(glyphCount / 2), formulaLineCount + 4),
  );
  const recoveries: ConsensusRecovery[] = [];
  for (let lineCount = 1; lineCount <= maximumLines; lineCount += 1) {
    const candidate = measureConsensusRecovery(
      core,
      direction,
      glyphCount,
      lineCount,
      formulaLineCount,
      estimateProjection,
    );
    if (candidate) recoveries.push(candidate);
  }
  const selected = recoveries.sort(
    (left, right) =>
      left.ratio - right.ratio ||
      right.confidence - left.confidence ||
      left.lineDistance - right.lineDistance,
  )[0];
  return selected
    ? {
        confidence: clamp(selected.confidence, 0.5, 0.94),
        facePx: selected.facePx,
        method: "raster-core-v1",
      }
    : null;
}

function measureConsensusRecovery(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  lineCount: number,
  formulaLineCount: number,
  estimateProjection: ProjectionEstimator,
): ConsensusRecovery | null {
  const lineProjection = estimateProjection(lineCount);
  const geometry = measureConsensusGeometry(
    core,
    direction,
    glyphCount,
    lineCount,
  );
  if (!lineProjection || !geometry) return null;
  const values = [
    lineProjection.facePx,
    geometry.component.primaryFace * SOURCE_FACE_SCALE,
    geometry.major.face * SOURCE_FACE_SCALE,
  ];
  const ratio = Math.max(...values) / Math.max(1, Math.min(...values));
  if (ratio > CONSENSUS_MAX_INDEPENDENT_RATIO) return null;
  return {
    confidence: Math.min(
      lineProjection.confidence,
      geometry.component.confidence,
      geometry.major.confidence,
    ),
    facePx: median(values),
    lineDistance: Math.abs(lineCount - formulaLineCount),
    ratio,
  };
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

function maximumRatio(first: number, second: number): number {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

function valueRatio(values: readonly number[]): number {
  return values.length > 0
    ? Math.max(...values) / Math.max(1, Math.min(...values))
    : Number.POSITIVE_INFINITY;
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
