import type { SourceTextDirection } from "../../shared/textTypes";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";

const CORRECTION_INTERCEPT = 0.079120888;
const CORRECTION_COEFFICIENTS = [
  -0.030603014, -0.047621106, -0.00116429, 0.016540932, -0.000914398,
  0.010149604, -0.003390012, -0.01587488, 0.014583797,
] as const;
const LEARNED_CORRECTION_BLEND = 0.35;
const SOURCE_FACE_SCALE = 1.02;

export type SourceFontSizeEstimate = Readonly<{
  confidence: number;
  facePx: number;
  method: "raster-core-v1";
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
): SourceFontSizeEstimate | null {
  if (glyphCount < 2 || glyphCount > 160) return null;
  const bboxCross = direction === "vertical" ? core.width : core.height;
  const bboxMajor = direction === "vertical" ? core.height : core.width;
  const expectedLines = estimateLineCount(glyphCount, bboxCross, bboxMajor);
  const faces = measureLineFaces(core, direction, expectedLines);
  if (faces.length === 0) return null;

  const coreFace = median(faces);
  const lineCross = bboxCross / Math.max(1, expectedLines);
  const glyphsPerLine = Math.max(1, glyphCount / Math.max(1, expectedLines));
  const pitch = bboxMajor / glyphsPerLine;
  const rawFace = Math.min(coreFace, lineCross * 1.06, pitch * 1.08);
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
  const facePx = clamp(
    rawFace *
      Math.exp(correction * LEARNED_CORRECTION_BLEND) *
      SOURCE_FACE_SCALE,
    1,
    512,
  );
  if (!Number.isFinite(facePx) || facePx <= 0) return null;
  return {
    confidence: resolveConfidence({ agreement, dispersion, lineAgreement }),
    facePx,
    method: "raster-core-v1",
  };
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

function measureLineFaces(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  expectedLines: number,
): number[] {
  const profile = buildCrossProfile(core, direction);
  const bands = selectLineBands(profile, expectedLines);
  const positionsByBand = bands.map(() => [] as number[]);
  const bandByCross = new Int16Array(profile.length).fill(-1);
  bands.forEach(([start, end], bandIndex) => {
    bandByCross.fill(bandIndex, start, end);
  });
  for (let y = 0; y < core.height; y += 1) {
    for (let x = 0; x < core.width; x += 1) {
      if (!core.mask[y * core.width + x]) continue;
      const cross = direction === "vertical" ? x : y;
      const bandIndex = bandByCross[cross] ?? -1;
      if (bandIndex >= 0) positionsByBand[bandIndex]?.push(cross);
    }
  }
  const faces: number[] = [];
  for (const positions of positionsByBand) {
    if (positions.length < 3) continue;
    positions.sort((left, right) => left - right);
    faces.push(quantile(positions, 0.995) - quantile(positions, 0.005) + 1);
  }
  return faces.filter((value) => Number.isFinite(value) && value > 0);
}

function buildCrossProfile(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
): number[] {
  const length = direction === "vertical" ? core.width : core.height;
  const profile = Array.from({ length }, () => 0);
  for (let y = 0; y < core.height; y += 1) {
    for (let x = 0; x < core.width; x += 1) {
      if (!core.mask[y * core.width + x]) continue;
      const cross = direction === "vertical" ? x : y;
      profile[cross] = (profile[cross] ?? 0) + 1;
    }
  }
  return profile;
}

function selectLineBands(
  profile: readonly number[],
  expectedLines: number,
): Array<[number, number]> {
  const active = profile.map((value) => value > 0);
  const gap = Math.max(1, Math.round(profile.length * 0.012));
  let runs = closeSmallGaps(findRuns(active), gap);
  const minimum = Math.max(2, Math.round(profile.length * 0.025));
  runs = runs.filter(([start, end]) => end - start >= minimum);
  if (runs.length === 0) return [[0, profile.length]];

  while (runs.length > expectedLines) {
    let mergeAt = 0;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < runs.length - 1; index += 1) {
      const currentGap = (runs[index + 1]?.[0] ?? 0) - (runs[index]?.[1] ?? 0);
      if (currentGap < smallestGap) {
        mergeAt = index;
        smallestGap = currentGap;
      }
    }
    const left = runs[mergeAt] ?? [0, profile.length];
    const right = runs[mergeAt + 1] ?? left;
    runs.splice(mergeAt, 2, [left[0], right[1]]);
  }
  if (runs.length < expectedLines) {
    const step = profile.length / expectedLines;
    return Array.from({ length: expectedLines }, (_unused, index) => [
      Math.round(index * step),
      Math.round((index + 1) * step),
    ]);
  }
  return runs;
}

function findRuns(active: readonly boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= active.length; index += 1) {
    if (active[index] && start < 0) start = index;
    if ((!active[index] || index === active.length) && start >= 0) {
      runs.push([start, index]);
      start = -1;
    }
  }
  return runs;
}

function closeSmallGaps(
  runs: Array<[number, number]>,
  maximumGap: number,
): Array<[number, number]> {
  if (runs.length < 2) return runs;
  const merged: Array<[number, number]> = [runs[0] as [number, number]];
  for (const run of runs.slice(1)) {
    const previous = merged[merged.length - 1] as [number, number];
    if (run[0] - previous[1] <= maximumGap) previous[1] = run[1];
    else merged.push([...run]);
  }
  return merged;
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

function quantile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const position = clamp(ratio, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const fraction = position - lower;
  return (
    (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
