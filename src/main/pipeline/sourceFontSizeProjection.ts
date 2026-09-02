import type { SourceTextDirection } from "../../shared/textTypes";
import {
  buildCrossProfile,
  clamp,
  median,
  quantile,
} from "./sourceFontSizeMath";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";
import { selectLineBands } from "./sourceFontSizeProjectionBands";

const DOMINANT_PROJECTION_MASS = 0.85;
type Band = [number, number];
type BandMeasurement = { face: number; mass: number };

export function measureLineFaces(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  expectedLines: number,
): number[] {
  const profile = buildCrossProfile(core, direction);
  const bands = selectLineBands(profile, expectedLines);
  const positions = collectBandPositions(
    core,
    direction,
    profile.length,
    bands,
  );
  const measurements = positions.flatMap((bandPositions, index) => {
    const measurement = measureBand(
      bandPositions,
      bands[index] ?? [0, profile.length],
      profile,
    );
    return measurement ? [measurement] : [];
  });
  return selectReliableFaces(measurements);
}

function collectBandPositions(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  profileLength: number,
  bands: readonly Band[],
): number[][] {
  const positionsByBand = bands.map(() => [] as number[]);
  const bandByCross = new Int16Array(profileLength).fill(-1);
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
  return positionsByBand;
}

function measureBand(
  positions: number[],
  [start, end]: Band,
  profile: readonly number[],
): BandMeasurement | null {
  if (positions.length < 3) return null;
  positions.sort((left, right) => left - right);
  const rawFace = quantile(positions, 0.995) - quantile(positions, 0.005) + 1;
  const denseSpan = shortestProjectionMassSpan(
    profile.slice(start, end),
    DOMINANT_PROJECTION_MASS,
  );
  // Restore the dominant interval to a full-width estimate. Ruby/satellite
  // modes below 15% stay outside the core, while the visible span is a cap.
  const denseFace =
    denseSpan === null ? rawFace : denseSpan / DOMINANT_PROJECTION_MASS;
  return { face: Math.min(rawFace, denseFace), mass: positions.length };
}

function selectReliableFaces(
  measurements: readonly BandMeasurement[],
): number[] {
  if (measurements.length === 0) return [];
  const massCenter = Math.max(
    1,
    median(measurements.map((measurement) => measurement.mass)),
  );
  const reliable = measurements.filter(
    (measurement) => measurement.mass >= massCenter * 0.12,
  );
  return (reliable.length > 0 ? reliable : measurements)
    .map((measurement) => measurement.face)
    .filter((value) => Number.isFinite(value) && value > 0);
}

function shortestProjectionMassSpan(
  profile: readonly number[],
  targetRatio: number,
): number | null {
  const total = profile.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return null;
  const target = total * clamp(targetRatio, 0, 1);
  let best = Number.POSITIVE_INFINITY;
  let end = 0;
  let mass = 0;
  for (let start = 0; start < profile.length; start += 1) {
    while (end < profile.length && mass < target) {
      mass += Math.max(0, profile[end] ?? 0);
      end += 1;
    }
    if (mass >= target) best = Math.min(best, end - start);
    mass -= Math.max(0, profile[start] ?? 0);
  }
  return Number.isFinite(best) && best > 0 ? best : null;
}
