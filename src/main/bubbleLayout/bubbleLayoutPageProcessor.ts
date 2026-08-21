import { createHash } from "node:crypto";
import { isGeneratedBubbleLayout } from "../../shared/bubbleLayout";
import type { BubbleLayoutPolicy } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { resolveEffectiveTextOutlineWidthPx } from "../../shared/textOutline";
import { readUnsuppressedTextLayoutIntent } from "../../shared/textLayoutIntent";
import type {
  BBox,
  RenderTextDirection,
  TranslationBlock,
} from "../../shared/textTypes";
import type { BubbleLayoutBlockPatch } from "../inpainting/bubbleLayoutRunnerPatches";
import { associateComicDetections } from "./association";
import {
  selectBlockBubbleCandidates,
  type BlockBubbleCandidate,
} from "./bubbleBlockAssociation";
import { partitionSharedBubbleOwnership } from "./bubbleOwnershipPartition";
import type { ComicPageDetection } from "./contracts";
import {
  clipRegionsToOwnershipPartition,
  resolveBubblePartitionGapPx,
} from "./bubbleRegionPartition";
import { buildBubbleShapeProfile } from "./bubbleShapeProfileBuilder";
import { isBubbleLayoutBlockEligible } from "./bubbleLayoutBlockEligibility";
import { refineKoharuBubbleMask } from "./koharuMaskRefinement";

const BUBBLE_LAYOUT_MODEL_ID =
  "koharu-layout-rfdetr-seg-2xl-1152+mask-safe-inset-v1+ownership-partition-v1";

const POLICY_CONFIDENCE_THRESHOLD = {
  safe: 0.72,
  balanced: 0.61,
  maximize: 0.52,
} as const;

type ScoredRegion = {
  region: import("./bubbleMaskTypes").RefinedBubbleRegion;
  confidence: number;
  insetPx: number;
  sharedGroupIds?: string[];
};

export function processDetectedBubbleLayouts(options: {
  page: MangaPage;
  /** Retained only for call-site compatibility; Koharu fitting never reads it. */
  bitmap?: Uint8Array;
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
    .filter((block) => isBubbleLayoutBlockEligible(block))
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
  if (!isBubbleLayoutBlockEligible(block)) return null;
  const scoredRegions = candidates.flatMap((candidate) =>
    refineCandidateRegions(block, candidate, options),
  );
  const initialRegions = deduplicateRegions(scoredRegions).slice(0, 4);
  const blockBounds = blockBboxToPixels(block, options);
  const regions = initialRegions;
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
    renderDirection: resolveAutomaticBubbleRenderDirection(block),
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
  const outlineWidthPx = resolveBubbleLayoutOutlineWidthPx(block);
  if (isImplausiblyPageWideBubble(candidate, options)) return [];
  if (!candidate.bubbleDetection.mask) return [];
  const refined = refineKoharuBubbleMask({
    mask: candidate.bubbleDetection.mask,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    bubbleBox: candidate.bubbleBox,
    promptBoxes: candidate.promptBoxes,
    fontSizePx: block.fontSizePx,
    outlineWidthPx,
    policy: options.policy,
  });
  if (refined) {
    const regions = clipRegionsToOwnershipPartition(
      refined.regions,
      candidate.ownershipPartition,
    );
    if (regions.length > 0) {
      const confidence = candidate.score * 0.72 + refined.confidence * 0.28;
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
  return [];
}

function isImplausiblyPageWideBubble(
  candidate: BlockBubbleCandidate,
  options: Pick<
    Parameters<typeof processDetectedBubbleLayouts>[0],
    "imageWidth" | "imageHeight"
  >,
): boolean {
  const imageArea = options.imageWidth * options.imageHeight;
  const bubbleArea = candidate.bubbleBox.w * candidate.bubbleBox.h;
  const promptArea = candidate.promptBoxes.reduce(
    (sum, prompt) => sum + prompt.w * prompt.h,
    0,
  );
  return (
    bubbleArea / Math.max(1, imageArea) >= 0.8 &&
    promptArea / Math.max(1, bubbleArea) < 0.25
  );
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

export function resolveBubbleLayoutOutlineWidthPx(
  block: TranslationBlock,
): number {
  return resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx);
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
      `${pageRevision}:${block.bboxSpace ?? "normalized_1000"}:${block.bbox.x}:${block.bbox.y}:${block.bbox.w}:${block.bbox.h}:${resolveAutomaticBubbleRenderDirection(block)}:${BUBBLE_LAYOUT_MODEL_ID}`,
    )
    .digest("hex");
}

function resolveAutomaticBubbleRenderDirection(
  block: TranslationBlock,
): RenderTextDirection {
  // A vertical Gemma advisory is unresolved until this detector proves the
  // block is not a balloon. Automatic balloon profiles therefore stay on the
  // ordinary horizontal default and can safely veto the advisory afterward.
  return readUnsuppressedTextLayoutIntent(block) === "vertical"
    ? "horizontal"
    : block.renderDirection;
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

function isUsableAutomaticBubbleRegionSet(
  regions: readonly import("./bubbleMaskTypes").RefinedBubbleRegion[],
  blockBounds: BBox,
): boolean {
  if (regions.length === 0 || regions.length > 2) return false;
  if (regions.length === 1) return true;
  const blockArea = blockBounds.w * blockBounds.h;
  if (blockArea <= 0) return false;
  return regions.every(
    (region) =>
      countRegionPixelsInsideBox(region, blockBounds) / blockArea >= 0.17,
  );
}

function countRegionPixelsInsideBox(
  region: import("./bubbleMaskTypes").RefinedBubbleRegion,
  box: BBox,
): number {
  const originX = Math.round(region.bounds.x);
  const originY = Math.round(region.bounds.y);
  const startX = Math.max(0, Math.floor(box.x - originX));
  const startY = Math.max(0, Math.floor(box.y - originY));
  const endX = Math.min(region.width, Math.ceil(box.x + box.w - originX));
  const endY = Math.min(region.height, Math.ceil(box.y + box.h - originY));
  let pixels = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      pixels += region.mask[y * region.width + x] ?? 0;
    }
  }
  return pixels;
}
