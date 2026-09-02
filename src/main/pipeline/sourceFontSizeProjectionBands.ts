import {
  clamp,
  closeSmallGaps,
  findActiveRuns,
  median,
  type SourceFontBand,
} from "./sourceFontSizeMath";

type Band = SourceFontBand;

export function selectLineBands(
  profile: readonly number[],
  expectedLines: number,
): Band[] {
  const gap = Math.max(1, Math.round(profile.length * 0.012));
  const minimum = Math.max(2, Math.round(profile.length * 0.025));
  const initialRuns = closeSmallGaps(
    findActiveRuns(profile.map((value) => value > 0)),
    gap,
  ).filter(([start, end]) => end - start >= minimum);
  if (initialRuns.length === 0) return [[0, profile.length]];
  if (!canUseBalancedRuns(profile, initialRuns, expectedLines)) {
    return selectDensityValleyBands(profile, expectedLines);
  }
  const runs = mergeRunsToCount(initialRuns, expectedLines, profile.length);
  return runs.length < expectedLines
    ? splitEvenly(0, profile.length, expectedLines)
    : runs;
}

function canUseBalancedRuns(
  profile: readonly number[],
  runs: readonly Band[],
  expectedLines: number,
): boolean {
  return (
    expectedLines <= 1 || hasBalancedLineRuns(profile, runs, expectedLines)
  );
}

function mergeRunsToCount(
  source: readonly Band[],
  expectedLines: number,
  profileLength: number,
): Band[] {
  const runs = source.map((run) => [...run] as Band);
  while (runs.length > expectedLines) {
    const mergeAt = findSmallestGapIndex(runs);
    const left = runs[mergeAt] ?? [0, profileLength];
    const right = runs[mergeAt + 1] ?? left;
    runs.splice(mergeAt, 2, [left[0], right[1]]);
  }
  return runs;
}

function findSmallestGapIndex(runs: readonly Band[]): number {
  let bestIndex = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs.length - 1; index += 1) {
    const gap = (runs[index + 1]?.[0] ?? 0) - (runs[index]?.[1] ?? 0);
    if (gap >= bestGap) continue;
    bestGap = gap;
    bestIndex = index;
  }
  return bestIndex;
}

/**
 * Binary runs turn edge fragments into lines and bridged columns into one run.
 * Keep balanced runs; otherwise cluster projection mass and cut at valleys.
 */
function hasBalancedLineRuns(
  profile: readonly number[],
  runs: readonly Band[],
  expectedLines: number,
): boolean {
  if (runs.length !== expectedLines) return false;
  const widths = runs.map(([start, end]) => end - start);
  const masses = runs.map(([start, end]) =>
    profile.slice(start, end).reduce((total, value) => total + value, 0),
  );
  const widthCenter = Math.max(1, median(widths));
  const massCenter = Math.max(1, median(masses));
  return (
    widths.every(
      (width) => width >= widthCenter * 0.45 && width <= widthCenter * 2.2,
    ) &&
    masses.every(
      (mass) => mass >= massCenter * 0.22 && mass <= massCenter * 3.5,
    )
  );
}

function selectDensityValleyBands(
  profile: readonly number[],
  expectedLines: number,
): Band[] {
  const first = profile.findIndex((value) => value > 0);
  const last = findLastPositiveIndex(profile);
  if (first < 0 || last < first || expectedLines <= 1) {
    return [[Math.max(0, first), last >= first ? last + 1 : profile.length]];
  }
  const supportEnd = last + 1;
  const supportLength = supportEnd - first;
  if (supportLength < expectedLines * 2) {
    return splitEvenly(first, supportEnd, expectedLines);
  }
  const centers = weightedProjectionCenters(
    profile,
    first,
    supportEnd,
    expectedLines,
  );
  const smoothed = smoothProfile(
    profile,
    Math.max(1, Math.round(profile.length * 0.008)),
  );
  const minimumBand = Math.max(
    2,
    Math.round(supportLength / Math.max(1, expectedLines * 5)),
  );
  const boundaries = buildValleyBoundaries({
    centers,
    expectedLines,
    first,
    minimumBand,
    profile: smoothed,
    supportEnd,
  });
  return Array.from({ length: expectedLines }, (_unused, index) => [
    boundaries[index] ?? first,
    boundaries[index + 1] ?? supportEnd,
  ]);
}

function buildValleyBoundaries(input: {
  centers: readonly number[];
  expectedLines: number;
  first: number;
  minimumBand: number;
  profile: readonly number[];
  supportEnd: number;
}): number[] {
  const boundaries = [input.first];
  for (let index = 1; index < input.expectedLines; index += 1) {
    boundaries.push(resolveValleyBoundary(input, boundaries, index));
  }
  return [...boundaries, input.supportEnd];
}

function resolveValleyBoundary(
  input: Parameters<typeof buildValleyBoundaries>[0],
  boundaries: readonly number[],
  index: number,
): number {
  const leftCenter = input.centers[index - 1] ?? input.first;
  const rightCenter = input.centers[index] ?? input.supportEnd - 1;
  const centerGap = Math.max(2, rightCenter - leftCenter);
  const lower = Math.max(
    (boundaries[index - 1] ?? input.first) + input.minimumBand,
    Math.floor(leftCenter + centerGap * 0.24),
  );
  const remaining = input.expectedLines - index;
  const upper = Math.min(
    input.supportEnd - remaining * input.minimumBand,
    Math.ceil(rightCenter - centerGap * 0.24),
  );
  return findProjectionValley(
    input.profile,
    Math.min(lower, upper),
    Math.max(lower, upper),
    (leftCenter + rightCenter) / 2,
    centerGap,
  );
}

function weightedProjectionCenters(
  profile: readonly number[],
  start: number,
  end: number,
  count: number,
): number[] {
  const span = end - start;
  let centers = Array.from(
    { length: count },
    (_unused, index) => start + ((index + 0.5) * span) / count,
  );
  for (let iteration = 0; iteration < 16; iteration += 1) {
    centers = updateProjectionCenters(profile, start, end, centers);
  }
  return centers.sort((left, right) => left - right);
}

function updateProjectionCenters(
  profile: readonly number[],
  start: number,
  end: number,
  centers: readonly number[],
): number[] {
  const weightedPositions = centers.map(() => 0);
  const weights = centers.map(() => 0);
  for (let position = start; position < end; position += 1) {
    const weight = Math.max(0, profile[position] ?? 0);
    if (weight <= 0) continue;
    const nearest = nearestCenterIndex(position, centers);
    weightedPositions[nearest] =
      (weightedPositions[nearest] ?? 0) + position * weight;
    weights[nearest] = (weights[nearest] ?? 0) + weight;
  }
  return centers.map((center, index) => {
    const weight = weights[index] ?? 0;
    return weight > 0 ? (weightedPositions[index] ?? 0) / weight : center;
  });
}

function nearestCenterIndex(
  position: number,
  centers: readonly number[],
): number {
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centers.length; index += 1) {
    const distance = Math.abs(position - (centers[index] ?? position));
    if (distance >= nearestDistance) continue;
    nearest = index;
    nearestDistance = distance;
  }
  return nearest;
}

function smoothProfile(profile: readonly number[], radius: number): number[] {
  const prefix = [0];
  for (const value of profile) {
    prefix.push((prefix[prefix.length - 1] ?? 0) + Math.max(0, value));
  }
  return profile.map((_value, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(profile.length, index + radius + 1);
    return (
      ((prefix[end] ?? 0) - (prefix[start] ?? 0)) / Math.max(1, end - start)
    );
  });
}

function findProjectionValley(
  profile: readonly number[],
  start: number,
  end: number,
  midpoint: number,
  centerGap: number,
): number {
  const safeStart = clamp(Math.round(start), 1, profile.length - 1);
  const safeEnd = clamp(Math.round(end), safeStart, profile.length - 1);
  const scale = Math.max(1, ...profile.slice(safeStart, safeEnd + 1));
  let best = clamp(Math.round(midpoint), safeStart, safeEnd);
  let bestCost = Number.POSITIVE_INFINITY;
  for (let position = safeStart; position <= safeEnd; position += 1) {
    const densityCost = (profile[position] ?? 0) / scale;
    const distanceCost =
      (Math.abs(position - midpoint) / Math.max(1, centerGap)) * 0.08;
    const cost = densityCost + distanceCost;
    if (cost >= bestCost) continue;
    best = position;
    bestCost = cost;
  }
  return best;
}

function splitEvenly(start: number, end: number, count: number): Band[] {
  const step = (end - start) / count;
  return Array.from({ length: count }, (_unused, index) => [
    Math.round(start + index * step),
    Math.round(start + (index + 1) * step),
  ]);
}

function findLastPositiveIndex(profile: readonly number[]): number {
  for (let index = profile.length - 1; index >= 0; index -= 1) {
    if ((profile[index] ?? 0) > 0) return index;
  }
  return -1;
}
