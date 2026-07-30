import type { BubbleLayoutPolicy } from "../../shared/inpaintingTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import type {
  BlockBubbleCandidate,
  BubbleOwnershipPartition,
} from "./bubbleBlockAssociation";
import { refineBubbleSafeMask } from "./bubbleMaskRefinement";
import type { RefinedBubbleRegion } from "./bubbleMaskTypes";
import { clipRegionsToOwnershipPartition } from "./bubbleRegionPartition";

const MAX_AUTOMATIC_REGION_COUNT = 2;
const MIN_MULTI_REGION_BLOCK_COVERAGE = 0.17;
const MAX_FRAGMENT_SECONDARY_BLOCK_COVERAGE = 0.28;
const MIN_FRAGMENT_PRIMARY_BLOCK_COVERAGE = 0.45;
const MIN_REPAIRED_BLOCK_COVERAGE = 0.68;
const MAX_FRAGMENT_REGION_ASPECT_RATIO = 4;
const MAX_REPAIR_ENVELOPE_INFLATION = 2.4;

export type ScoredBubbleRegion = {
  region: RefinedBubbleRegion;
  confidence: number;
  insetPx: number;
  /** Conflict groups that actually contributed this selected region. */
  sharedGroupIds?: string[];
};

type FragmentRepairInput = {
  block: TranslationBlock;
  candidates: readonly BlockBubbleCandidate[];
  initialRegions: readonly ScoredBubbleRegion[];
  blockBounds: BBox;
  bitmap: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  policy: BubbleLayoutPolicy;
  outlineWidthPx: number;
  repairOriginalTextInk?: boolean;
};

/**
 * Returns undefined when the input is not a suspicious fragment pair, null
 * when it is suspicious but no safe replacement was found, and a replacement
 * region set on success.
 *
 * A suspicious pair is first re-segmented from each detector candidate on its
 * own. This resolves the common connected-balloon failure where one candidate
 * covers the OCR block and the adjacent candidate contributes only a shard.
 * Only when neither candidate can explain the OCR block alone do we retry the
 * combined envelope. Output is always derived from image pixels and OCR
 * prompts, never by unioning the old masks.
 */
export function repairFragmentedBubbleRegions(
  input: FragmentRepairInput,
): ScoredBubbleRegion[] | null | undefined {
  if (input.candidates.length === 1 && input.initialRegions.length > 1) {
    return null;
  }
  const repair = repairSuspiciousFragmentedBubbleRegions(input);
  if (repair !== undefined) return repair;
  return hasRedundantContainingCandidates(input) ? null : undefined;
}

function repairSuspiciousFragmentedBubbleRegions(
  input: FragmentRepairInput,
): ScoredBubbleRegion[] | null | undefined {
  if (
    !isSuspiciousFragmentPair(
      input.initialRegions.map((item) => item.region),
      input.blockBounds,
    )
  ) {
    return undefined;
  }
  const singleCandidateRepair = repairFromSingleCandidate(input);
  if (singleCandidateRepair) return singleCandidateRepair;
  if (input.candidates.length !== 2) return null;
  const bubbleBox = unionBounds(
    input.candidates.map((candidate) => candidate.bubbleBox),
  );
  const candidateArea = input.candidates.reduce(
    (sum, candidate) => sum + candidate.bubbleBox.w * candidate.bubbleBox.h,
    0,
  );
  if (
    bubbleBox.w * bubbleBox.h >
    candidateArea * MAX_REPAIR_ENVELOPE_INFLATION
  ) {
    return null;
  }
  const refined = refineBubbleSafeMask({
    bitmap: input.bitmap,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    bubbleBox,
    promptBoxes: deduplicateBoxes(
      input.candidates.flatMap((candidate) => candidate.promptBoxes),
    ),
    fontSizePx: input.block.fontSizePx,
    outlineWidthPx: input.outlineWidthPx,
    policy: input.policy,
    repairOriginalTextInk: input.repairOriginalTextInk,
  });
  if (!refined) return null;
  const partition = resolveCompatibleOwnershipPartition(input.candidates);
  if (partition === null) return null;
  const confidence =
    averageCandidateScore(input.candidates) * 0.58 + refined.confidence * 0.42;
  const repaired = clipRegionsToOwnershipPartition(
    refined.regions,
    partition ?? undefined,
  ).map((region) => ({
    region,
    confidence,
    insetPx: refined.insetPx,
    ...(partition?.sharedGroupId
      ? { sharedGroupIds: [partition.sharedGroupId] }
      : {}),
  }));
  if (
    repaired.length !== 1 ||
    !isUsableAutomaticBubbleRegionSet(
      repaired.map((item) => item.region),
      input.blockBounds,
    ) ||
    resolveRegionSetBlockCoverage(
      repaired.map((item) => item.region),
      input.blockBounds,
    ) < MIN_REPAIRED_BLOCK_COVERAGE
  ) {
    return null;
  }
  return repaired;
}

function repairFromSingleCandidate(
  input: FragmentRepairInput,
): ScoredBubbleRegion[] | undefined {
  const blockArea = input.blockBounds.w * input.blockBounds.h;
  if (blockArea <= 0) return undefined;
  const repairs = input.candidates.flatMap((candidate) => {
    const candidateArea = candidate.bubbleBox.w * candidate.bubbleBox.h;
    if (candidateArea / blockArea > 12) return [];
    const refined = refineBubbleSafeMask({
      bitmap: input.bitmap,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      bubbleBox: candidate.bubbleBox,
      promptBoxes: candidate.promptBoxes,
      fontSizePx: input.block.fontSizePx,
      outlineWidthPx: input.outlineWidthPx,
      policy: input.policy,
      repairOriginalTextInk: input.repairOriginalTextInk,
    });
    if (!refined) return [];
    const regions = clipRegionsToOwnershipPartition(
      refined.regions,
      candidate.ownershipPartition,
    );
    const bestRegion = [...regions].sort(
      (left, right) =>
        countRegionPixelsInsideBox(right, input.blockBounds) -
        countRegionPixelsInsideBox(left, input.blockBounds),
    )[0];
    if (!bestRegion) return [];
    const coverage = resolveRegionSetBlockCoverage(
      [bestRegion],
      input.blockBounds,
    );
    if (coverage < MIN_REPAIRED_BLOCK_COVERAGE) return [];
    const confidence = candidate.score * 0.58 + refined.confidence * 0.42;
    return [
      {
        coverage,
        scored: {
          region: bestRegion,
          confidence,
          insetPx: refined.insetPx,
          ...(candidate.ownershipPartition?.sharedGroupId
            ? {
                sharedGroupIds: [candidate.ownershipPartition.sharedGroupId],
              }
            : {}),
        },
      },
    ];
  });
  const best = repairs.sort(
    (left, right) =>
      right.coverage - left.coverage ||
      right.scored.confidence - left.scored.confidence,
  )[0];
  return best ? [best.scored] : undefined;
}

function hasRedundantContainingCandidates(input: FragmentRepairInput): boolean {
  if (input.initialRegions.length <= 1) return false;
  return (
    input.candidates.filter(
      (candidate) =>
        boxCoverage(input.blockBounds, candidate.bubbleBox) >= 0.88,
    ).length >= 2
  );
}

function boxCoverage(subject: BBox, container: BBox): number {
  const width = Math.max(
    0,
    Math.min(subject.x + subject.w, container.x + container.w) -
      Math.max(subject.x, container.x),
  );
  const height = Math.max(
    0,
    Math.min(subject.y + subject.h, container.y + container.h) -
      Math.max(subject.y, container.y),
  );
  return (width * height) / Math.max(1, subject.w * subject.h);
}

export function isUsableAutomaticBubbleRegionSet(
  regions: readonly RefinedBubbleRegion[],
  blockBounds: BBox,
): boolean {
  if (regions.length === 0 || regions.length > MAX_AUTOMATIC_REGION_COUNT) {
    return false;
  }
  if (regions.length === 1) return true;
  const blockArea = blockBounds.w * blockBounds.h;
  if (blockArea <= 0) return false;
  return regions.every(
    (region) =>
      countRegionPixelsInsideBox(region, blockBounds) / blockArea >=
      MIN_MULTI_REGION_BLOCK_COVERAGE,
  );
}

function isSuspiciousFragmentPair(
  regions: readonly RefinedBubbleRegion[],
  blockBounds: BBox,
): boolean {
  if (regions.length !== 2) return false;
  const blockArea = blockBounds.w * blockBounds.h;
  if (blockArea <= 0) return false;
  const ranked = regions
    .map((region) => ({
      region,
      coverage: countRegionPixelsInsideBox(region, blockBounds) / blockArea,
    }))
    .sort((left, right) => right.coverage - left.coverage);
  const primary = ranked[0];
  const secondary = ranked[1];
  if (
    !primary ||
    !secondary ||
    primary.coverage < MIN_FRAGMENT_PRIMARY_BLOCK_COVERAGE ||
    secondary.coverage >= MAX_FRAGMENT_SECONDARY_BLOCK_COVERAGE
  ) {
    return false;
  }
  return (
    secondary.coverage < MIN_MULTI_REGION_BLOCK_COVERAGE ||
    regionAspectRatio(secondary.region) >= MAX_FRAGMENT_REGION_ASPECT_RATIO
  );
}

function resolveRegionSetBlockCoverage(
  regions: readonly RefinedBubbleRegion[],
  blockBounds: BBox,
): number {
  const blockArea = blockBounds.w * blockBounds.h;
  if (blockArea <= 0) return 0;
  return Math.min(
    1,
    regions.reduce(
      (sum, region) => sum + countRegionPixelsInsideBox(region, blockBounds),
      0,
    ) / blockArea,
  );
}

function countRegionPixelsInsideBox(
  region: RefinedBubbleRegion,
  box: BBox,
): number {
  const originX = Math.round(region.bounds.x);
  const originY = Math.round(region.bounds.y);
  const startX = clampInteger(Math.floor(box.x - originX), 0, region.width);
  const startY = clampInteger(Math.floor(box.y - originY), 0, region.height);
  const endX = clampInteger(
    Math.ceil(box.x + box.w - originX),
    0,
    region.width,
  );
  const endY = clampInteger(
    Math.ceil(box.y + box.h - originY),
    0,
    region.height,
  );
  let pixels = 0;
  for (let y = startY; y < endY; y += 1) {
    const rowOffset = y * region.width;
    for (let x = startX; x < endX; x += 1) {
      if (region.mask[rowOffset + x]) pixels += 1;
    }
  }
  return pixels;
}

function regionAspectRatio(region: RefinedBubbleRegion): number {
  const shorter = Math.max(1, Math.min(region.bounds.w, region.bounds.h));
  return Math.max(region.bounds.w, region.bounds.h) / shorter;
}

function resolveCompatibleOwnershipPartition(
  candidates: readonly BlockBubbleCandidate[],
): BubbleOwnershipPartition | undefined | null {
  const partitions = candidates
    .map((candidate) => candidate.ownershipPartition)
    .filter(
      (partition): partition is BubbleOwnershipPartition =>
        partition !== undefined,
    );
  const first = partitions[0];
  if (!first) return undefined;
  const baseline = ownershipPartitionKey(first);
  return partitions.every(
    (partition) => ownershipPartitionKey(partition) === baseline,
  )
    ? first
    : null;
}

function ownershipPartitionKey(partition: BubbleOwnershipPartition): string {
  return JSON.stringify({
    sharedGroupId: partition.sharedGroupId,
    ownerBox: partition.ownerBox,
    competingOwnerBoxes: partition.competingOwnerBoxes,
    competingBubbleBoxes: partition.competingBubbleBoxes,
    scope: partition.scope,
    gapPx: partition.gapPx,
    ownerCount: partition.ownerCount,
  });
}

function deduplicateBoxes(boxes: readonly BBox[]): BBox[] {
  const seen = new Set<string>();
  return boxes.filter((box) => {
    const key = [box.x, box.y, box.w, box.h]
      .map((value) => value.toFixed(3))
      .join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unionBounds(boxes: readonly BBox[]): BBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function averageCandidateScore(
  candidates: readonly BlockBubbleCandidate[],
): number {
  return (
    candidates.reduce((sum, candidate) => sum + candidate.score, 0) /
    Math.max(1, candidates.length)
  );
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
