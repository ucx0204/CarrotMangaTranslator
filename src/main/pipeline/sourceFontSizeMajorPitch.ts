import type { SourceTextDirection } from "../../shared/textTypes";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { selectLineBands } from "./sourceFontSizeProjectionBands";

const MINIMUM_BAND_MASS_SHARE = 0.08;

type Band = readonly [number, number];

export type MajorPitchMeasurement = Readonly<{
  bandFaces: readonly number[];
  confidence: number;
  face: number;
  lineCount: number;
}>;

/**
 * Estimate visible glyph face from repeated spacing on the writing axis.
 * Cross-axis projection and connected components both fail when an incorrect
 * line count merges adjacent columns; the occupied major span divided by the
 * longest plausible column length is independent evidence.
 */
export function measureMajorAxisPitch(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  expectedLines: number,
): MajorPitchMeasurement | null {
  if (glyphCount < 2 || expectedLines < 1) return null;
  const crossProfile = buildCrossProfile(core, direction);
  const bands = selectLineBands(crossProfile, expectedLines);
  if (bands.length === 0) return null;
  const occupiedByBand = bands.map((band) =>
    collectMajorPositions(core, direction, band),
  );
  const masses = occupiedByBand.map((positions) => positions.length);
  const totalMass = masses.reduce((sum, mass) => sum + mass, 0);
  const glyphsInLongestLine = Math.max(1, Math.ceil(glyphCount / bands.length));
  const bandFaces = occupiedByBand.flatMap((positions) => {
    if (
      positions.length < 3 ||
      positions.length < totalMass * MINIMUM_BAND_MASS_SHARE
    ) {
      return [];
    }
    const face = measureGlyphRunFace(positions, glyphsInLongestLine);
    return Number.isFinite(face) && face >= 4 ? [face] : [];
  });
  if (bandFaces.length === 0) return null;
  // Short final columns legitimately have a smaller occupied span. The upper
  // median represents a full column without letting one contaminated band win.
  const face = upperMedian(bandFaces);
  const upperFaces = bandFaces.filter((value) => value >= median(bandFaces));
  const dispersion = relativeDispersion(upperFaces);
  if (!Number.isFinite(face) || face < 4 || dispersion > 0.42) return null;
  const massCenter = Math.max(1, median(masses.filter((mass) => mass > 0)));
  const massDispersion = relativeDispersion(
    masses.filter((mass) => mass > 0).map((mass) => mass / massCenter),
  );
  const confidence = clamp(
    0.58 +
      Math.min(0.14, bandFaces.length * 0.035) +
      Math.min(0.12, Math.log1p(glyphCount) * 0.035) -
      dispersion * 0.22 -
      Math.min(0.16, massDispersion * 0.08),
    0.5,
    0.9,
  );
  return { bandFaces, confidence, face, lineCount: bands.length };
}

function measureGlyphRunFace(
  positions: readonly number[],
  expectedGlyphs: number,
): number {
  const low = Math.floor(Math.min(...positions));
  const high = Math.ceil(Math.max(...positions));
  const profile = Array.from({ length: high - low + 1 }, () => false);
  for (const position of positions) profile[Math.round(position) - low] = true;
  const runs = closeSmallGaps(findRuns(profile), 2).filter(
    ([start, end]) => end - start >= 2,
  );
  while (runs.length > expectedGlyphs) {
    const mergeAt = smallestGapIndex(runs);
    const left = runs[mergeAt];
    const right = runs[mergeAt + 1];
    if (!left || !right) break;
    runs.splice(mergeAt, 2, [left[0], right[1]]);
  }
  if (runs.length < Math.max(2, Math.floor(expectedGlyphs * 0.35))) {
    return Number.NaN;
  }
  const widths = runs.map(([start, end]) => end - start);
  const center = Math.max(1, median(widths));
  const reliable = widths.filter(
    (width) => width >= center * 0.38 && width <= center * 2.1,
  );
  return quantile(
    [...(reliable.length > 0 ? reliable : widths)].sort(
      (left, right) => left - right,
    ),
    0.7,
  );
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
  source: Array<[number, number]>,
  maximumGap: number,
): Array<[number, number]> {
  if (source.length < 2) return source;
  const merged: Array<[number, number]> = [[...source[0]]];
  for (const run of source.slice(1)) {
    const previous = merged[merged.length - 1];
    if (previous && run[0] - previous[1] <= maximumGap) {
      previous[1] = run[1];
    } else {
      merged.push([...run]);
    }
  }
  return merged;
}

function smallestGapIndex(
  runs: ReadonlyArray<readonly [number, number]>,
): number {
  let selected = 0;
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs.length - 1; index += 1) {
    const gap = (runs[index + 1]?.[0] ?? 0) - (runs[index]?.[1] ?? 0);
    if (gap >= smallest) continue;
    selected = index;
    smallest = gap;
  }
  return selected;
}

function collectMajorPositions(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  [start, end]: Band,
): number[] {
  const positions: number[] = [];
  for (let y = 0; y < core.height; y += 1) {
    for (let x = 0; x < core.width; x += 1) {
      if (!core.mask[y * core.width + x]) continue;
      const cross = direction === "vertical" ? x : y;
      if (cross < start || cross >= end) continue;
      positions.push(direction === "vertical" ? y : x);
    }
  }
  return positions;
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

function relativeDispersion(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = median(values);
  return (
    median(values.map((value) => Math.abs(value - center))) /
    Math.max(1, center)
  );
}

function upperMedian(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
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
