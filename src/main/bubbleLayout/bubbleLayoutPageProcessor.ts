import { createHash } from "node:crypto";
import { isGeneratedBubbleLayout } from "../../shared/bubbleLayout";
import type { BubbleLayoutPolicy } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import type { BubbleLayoutBlockPatch } from "../inpainting/bubbleLayoutRunner";
import { associateComicDetections } from "./association";
import {
  selectBlockBubbleCandidates,
  type BlockBubbleCandidate,
} from "./bubbleBlockAssociation";
import {
  isUsableAutomaticBubbleRegionSet,
  repairFragmentedBubbleRegions,
  type ScoredBubbleRegion,
} from "./bubbleFragmentRepair";
import { partitionSharedBubbleOwnership } from "./bubbleOwnershipPartition";
import type { ComicPageDetection } from "./contracts";
import { refineBubbleSafeMask } from "./bubbleMaskRefinement";
import {
  buildOwnershipFallbackRegion,
  clipRegionsToOwnershipPartition,
  resolveBubblePartitionGapPx,
} from "./bubbleRegionPartition";
import { buildBubbleShapeProfile } from "./bubbleShapeProfileBuilder";

const BUBBLE_LAYOUT_MODEL_ID =
  "comic-rtdetr-v4-s-int8+safe-distance-v2-overlap-fragment-guard-v3";

const POLICY_CONFIDENCE_THRESHOLD = {
  safe: 0.72,
  balanced: 0.61,
  maximize: 0.52,
} as const;

type ScoredRegion = ScoredBubbleRegion;

export function processDetectedBubbleLayouts(options: {
  page: MangaPage;
  bitmap: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  detections: ComicPageDetection[];
  policy: BubbleLayoutPolicy;
  paddingRatio?: number;
  sharedOwnershipGapPx?: number;
  pageRevision: string;
  repairOriginalTextInk?: boolean;
}): BubbleLayoutBlockPatch[] {
  const associations = associateComicDetections(options.detections);
  const eligibleOwnerships = options.page.blocks
    .filter(isEligibleBlock)
    .map((block) => ({
      owner: block,
      candidates: selectBlockBubbleCandidates(
        blockBboxToPixels(block, options),
        associations,
      ),
    }));
  const ownerships = partitionSharedBubbleOwnership(
    eligibleOwnerships,
    (block) => blockBboxToPixels(block, options),
    options.sharedOwnershipGapPx ??
      resolveBubblePartitionGapPx(options.imageWidth, options.imageHeight),
  );
  const candidatesByBlock = new Map(
    ownerships.map(({ owner, candidates }) => [owner, candidates]),
  );
  const patches: BubbleLayoutBlockPatch[] = [];
  for (const block of options.page.blocks) {
    const patch = processBlock(
      block,
      candidatesByBlock.get(block) ?? [],
      options,
    );
    if (patch) patches.push(patch);
  }
  return patches;
}

function processBlock(
  block: TranslationBlock,
  candidates: readonly BlockBubbleCandidate[],
  options: Parameters<typeof processDetectedBubbleLayouts>[0],
): BubbleLayoutBlockPatch | null {
  if (!isEligibleBlock(block)) return null;
  const scoredRegions = candidates.flatMap((candidate) =>
    refineCandidateRegions(block, candidate, options),
  );
  const initialRegions = deduplicateRegions(scoredRegions).slice(0, 4);
  const blockBounds = blockBboxToPixels(block, options);
  const fragmentRepair = repairFragmentedBubbleRegions({
    block,
    candidates,
    initialRegions,
    blockBounds,
    bitmap: options.bitmap,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    policy: options.policy,
    outlineWidthPx: resolveOutlineWidthPx(block),
    repairOriginalTextInk: options.repairOriginalTextInk,
  });
  if (fragmentRepair === null) {
    return clearGeneratedLayoutPatch(block);
  }
  const regions = fragmentRepair ?? initialRegions;
  const confidence = resolveCombinedConfidence(regions);
  const hasSharedOwnership = candidates.some(
    (candidate) => candidate.ownershipPartition !== undefined,
  );
  if (
    regions.length === 0 ||
    !isUsableAutomaticBubbleRegionSet(
      regions.map((item) => item.region),
      blockBounds,
    ) ||
    (!hasSharedOwnership &&
      confidence < POLICY_CONFIDENCE_THRESHOLD[options.policy])
  ) {
    return clearGeneratedLayoutPatch(block);
  }
  const insetPx = Math.max(...regions.map((item) => item.insetPx));
  const profile = buildBubbleShapeProfile({
    regions: regions.map((item) => item.region),
    pageWidth: options.imageWidth,
    pageHeight: options.imageHeight,
    textBounds: blockBounds,
    renderDirection: block.renderDirection,
    sourceDirection: block.sourceDirection,
    confidence,
    modelId: BUBBLE_LAYOUT_MODEL_ID,
    sourceImageRevision: resolveBubbleLayoutBlockRevision(
      options.pageRevision,
      block,
    ),
    insetPx,
    regionGapPx: resolveBubblePartitionGapPx(
      options.imageWidth,
      options.imageHeight,
    ),
    paddingRatio: options.paddingRatio,
  });
  if (!profile) return clearGeneratedLayoutPatch(block);
  const sharedInpaintGroupIds = resolveSharedInpaintGroupIds(
    regions,
    options.sharedOwnershipGapPx,
  );
  return {
    blockId: block.id,
    ...profile,
    ...(sharedInpaintGroupIds.length ? { sharedInpaintGroupIds } : {}),
  };
}

function resolveSharedInpaintGroupIds(
  regions: readonly ScoredRegion[],
  sharedOwnershipGapPx: number | undefined,
): string[] {
  if (sharedOwnershipGapPx !== 0) return [];
  return [...new Set(regions.flatMap((region) => region.sharedGroupIds ?? []))];
}

function refineCandidateRegions(
  block: TranslationBlock,
  candidate: BlockBubbleCandidate,
  options: Parameters<typeof processDetectedBubbleLayouts>[0],
): ScoredRegion[] {
  const outlineWidthPx = resolveOutlineWidthPx(block);
  const refined = refineBubbleSafeMask({
    bitmap: options.bitmap,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    bubbleBox: candidate.bubbleBox,
    promptBoxes: candidate.promptBoxes,
    fontSizePx: block.fontSizePx,
    outlineWidthPx,
    policy: options.policy,
    repairOriginalTextInk: options.repairOriginalTextInk,
  });
  if (refined) {
    const regions = clipRegionsToOwnershipPartition(
      refined.regions,
      candidate.ownershipPartition,
    );
    if (regions.length > 0) {
      const confidence = candidate.score * 0.58 + refined.confidence * 0.42;
      return regions.map((region) => ({
        region,
        confidence,
        insetPx: refined.insetPx,
        ...(candidate.ownershipPartition?.sharedGroupId
          ? {
              sharedGroupIds: [candidate.ownershipPartition.sharedGroupId],
            }
          : {}),
      }));
    }
  }
  const insetPx = resolveFallbackInsetPx(block, outlineWidthPx);
  const allowOriginalFallback =
    options.repairOriginalTextInk === true &&
    isCredibleOriginalFallbackCandidate(candidate, options);
  const fallback = buildOwnershipFallbackRegion(
    candidate,
    insetPx,
    allowOriginalFallback,
  );
  return fallback
    ? [
        {
          region: fallback,
          confidence:
            candidate.score * (options.repairOriginalTextInk ? 0.7 : 0.55),
          insetPx,
          ...(candidate.ownershipPartition?.sharedGroupId
            ? {
                sharedGroupIds: [candidate.ownershipPartition.sharedGroupId],
              }
            : {}),
        },
      ]
    : [];
}

function isCredibleOriginalFallbackCandidate(
  candidate: BlockBubbleCandidate,
  options: Parameters<typeof processDetectedBubbleLayouts>[0],
): boolean {
  const minimumScore = {
    safe: 0.9,
    balanced: 0.84,
    maximize: 0.78,
  }[options.policy];
  if (candidate.score < minimumScore) return false;
  const prompts = candidate.promptBoxes.filter(
    (prompt) => prompt.w > 0 && prompt.h > 0,
  );
  if (prompts.length === 0) return false;
  const containedArea = prompts.reduce(
    (sum, prompt) => sum + intersectionArea(prompt, candidate.bubbleBox),
    0,
  );
  const promptArea = prompts.reduce(
    (sum, prompt) => sum + prompt.w * prompt.h,
    0,
  );
  if (containedArea / Math.max(1, promptArea) < 0.92) return false;
  const promptEnvelope = unionBounds(prompts);
  const bubbleArea = candidate.bubbleBox.w * candidate.bubbleBox.h;
  const imageArea = options.imageWidth * options.imageHeight;
  return (
    bubbleArea / Math.max(1, promptEnvelope.w * promptEnvelope.h) <= 12 &&
    bubbleArea / Math.max(1, imageArea) <= 0.72
  );
}

function unionBounds(boxes: readonly BBox[]): BBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function isEligibleBlock(block: TranslationBlock): boolean {
  return (
    !block.inpaintExcluded &&
    !block.curveLayout &&
    Boolean(block.translatedText.trim()) &&
    block.bbox.w > 0 &&
    block.bbox.h > 0
  );
}

function resolveFallbackInsetPx(
  block: TranslationBlock,
  outlineWidthPx: number,
): number {
  return Math.min(8, Math.max(2, block.fontSizePx * 0.12, outlineWidthPx * 2));
}

function blockBboxToPixels(
  block: TranslationBlock,
  options: {
    page: MangaPage;
    imageWidth: number;
    imageHeight: number;
  },
): BBox {
  if (block.bboxSpace === "pixels") {
    return {
      x: (block.bbox.x / Math.max(1, options.page.width)) * options.imageWidth,
      y:
        (block.bbox.y / Math.max(1, options.page.height)) * options.imageHeight,
      w: (block.bbox.w / Math.max(1, options.page.width)) * options.imageWidth,
      h:
        (block.bbox.h / Math.max(1, options.page.height)) * options.imageHeight,
    };
  }
  return {
    x: (block.bbox.x / 1000) * options.imageWidth,
    y: (block.bbox.y / 1000) * options.imageHeight,
    w: (block.bbox.w / 1000) * options.imageWidth,
    h: (block.bbox.h / 1000) * options.imageHeight,
  };
}

function resolveOutlineWidthPx(block: TranslationBlock): number {
  const scale = block.outlineWidthScale ?? 1;
  if (scale <= 0) return 0;
  return (
    (Math.round(Math.min(4, Math.max(0.35, block.fontSizePx * 0.055)) * 10) /
      10) *
    scale
  );
}

function deduplicateRegions(regions: ScoredRegion[]): ScoredRegion[] {
  const ordered = [...regions].sort(
    (left, right) => right.confidence - left.confidence,
  );
  const kept: ScoredRegion[] = [];
  for (const candidate of ordered) {
    if (
      !kept.some(
        (existing) =>
          intersectionOverUnion(
            existing.region.bounds,
            candidate.region.bounds,
          ) > 0.68,
      )
    ) {
      kept.push(candidate);
    }
  }
  return kept;
}

function resolveCombinedConfidence(regions: ScoredRegion[]): number {
  if (regions.length === 0) return 0;
  return (
    regions.reduce((total, item) => total + item.confidence, 0) / regions.length
  );
}

function clearGeneratedLayoutPatch(
  block: TranslationBlock,
): BubbleLayoutBlockPatch | null {
  if (!isGeneratedBubbleLayout(block.bubbleLayout)) return null;
  return {
    blockId: block.id,
    renderBbox: null,
    renderBboxSpace: null,
    bubbleLayout: null,
  };
}

export function resolveBubbleLayoutBlockRevision(
  pageRevision: string,
  block: TranslationBlock,
): string {
  return createHash("sha256")
    .update(
      `${pageRevision}:${block.bboxSpace ?? "normalized_1000"}:${block.bbox.x}:${block.bbox.y}:${block.bbox.w}:${block.bbox.h}:${block.renderDirection}:${BUBBLE_LAYOUT_MODEL_ID}`,
    )
    .digest("hex");
}

function intersectionOverUnion(left: BBox, right: BBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.w * left.h + right.w * right.h - intersection;
  return intersection / Math.max(1, union);
}

function intersectionArea(left: BBox, right: BBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
