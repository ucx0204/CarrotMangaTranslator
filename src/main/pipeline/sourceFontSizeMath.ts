import type { SourceTextDirection } from "../../shared/textTypes";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";

export const SOURCE_FONT_FACE_SCALE = 1.02;

export type SourceFontBand = [number, number];

export type SourceFontSizeHypothesisPoint<Source extends string = string> =
  Readonly<{
    confidence: number;
    face: number;
    lineCount: number;
    source: Source;
    weight: number;
  }>;

export function maximumValueRatio(values: readonly number[]): number {
  return values.length >= 2
    ? Math.max(...values) / Math.max(1, Math.min(...values))
    : 1;
}

export function valuePairRatio(first: number, second: number): number {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

export function estimateLineCount(
  glyphCount: number,
  cross: number,
  major: number,
): number {
  if (glyphCount <= 1 || cross <= 0 || major <= 0) return 1;
  return clamp(
    Math.round(Math.sqrt((glyphCount * cross) / major)),
    1,
    maximumLineCount(glyphCount),
  );
}

export function isPlausibleLineCount(
  lineCount: number,
  glyphCount: number,
): boolean {
  return (
    Number.isInteger(lineCount) &&
    lineCount >= 1 &&
    lineCount <= maximumLineCount(glyphCount)
  );
}

export function maximumLineCount(glyphCount: number): number {
  return Math.max(1, Math.min(12, Math.ceil(glyphCount / 2)));
}

export function mean(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function relativeDispersion(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = median(values);
  return (
    median(values.map((value) => Math.abs(value - center))) /
    Math.max(1, center)
  );
}

export function quantile(sorted: readonly number[], ratio: number): number {
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

export function buildCrossProfile(
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

export function findActiveRuns(active: readonly boolean[]): SourceFontBand[] {
  const runs: SourceFontBand[] = [];
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

export function closeSmallGaps(
  source: ReadonlyArray<readonly [number, number]>,
  maximumGap: number,
): SourceFontBand[] {
  const merged: SourceFontBand[] = [];
  for (const run of source) {
    const previous = merged[merged.length - 1];
    if (previous && run[0] - previous[1] <= maximumGap) {
      previous[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }
  return merged;
}

export function weightedMedianFace<T extends { face: number; weight: number }>(
  points: readonly T[],
): number | null {
  const sorted = [...points].sort((left, right) => left.face - right.face);
  const totalWeight = sorted.reduce((sum, point) => sum + point.weight, 0);
  let running = 0;
  for (const point of sorted) {
    running += point.weight;
    if (running >= totalWeight / 2) return point.face;
  }
  return sorted.at(-1)?.face ?? null;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
