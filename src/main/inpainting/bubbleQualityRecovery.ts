import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  bboxToPixels,
  clamp,
  normalizeBboxTo1000,
} from "../../shared/geometry";
import type { PixelRect } from "./maskGeometry";

export type BubbleRecoveryHint = {
  blockId: string;
  rect: PixelRect;
};

export type BubbleRecoveryMergeResult = {
  mask: Uint8Array;
  recoveredBlocks: number;
};

const MINIMUM_MASK_COVERAGE = 0.45;
const MINIMUM_BUBBLE_WIDTH_RATIO = 1.35;
const MINIMUM_BUBBLE_HEIGHT_RATIO = 1.12;

export function findBubbleRecoveryHints(
  page: MangaPage,
  bubbleMask: Uint8Array,
): BubbleRecoveryHint[] {
  const candidates = page.blocks.filter(isBubbleRecoveryCandidate);
  if (bubbleMask.length !== page.width * page.height) {
    return candidates.map((block) => toRecoveryHint(block, page));
  }
  return candidates.flatMap((block) => {
    const hint = toRecoveryHint(block, page);
    return maskNeedsRecovery(bubbleMask, page, hint.rect) ? [hint] : [];
  });
}

export function mergeRecoveredBubbleMask(
  baseMask: Uint8Array,
  recoveredMask: Uint8Array,
  page: Pick<MangaPage, "width" | "height">,
  hints: BubbleRecoveryHint[],
): BubbleRecoveryMergeResult {
  if (
    baseMask.length !== page.width * page.height ||
    recoveredMask.length !== baseMask.length
  ) {
    return { mask: baseMask, recoveredBlocks: 0 };
  }
  const mask = baseMask.slice();
  let nextId = Math.min(255, maximumMaskId(mask) + 1);
  let recoveredBlocks = 0;
  for (const [hintIndex, hint] of hints.entries()) {
    const recoveryId = hintIndex + 1;
    const recoveredPixels = countMaskId(recoveredMask, recoveryId);
    const minimumPixels = Math.max(
      16,
      Math.round(hint.rect.w * hint.rect.h * 0.5),
    );
    if (recoveredPixels < minimumPixels) continue;
    const replacedId = dominantMaskId(mask, page.width, hint.rect);
    if (replacedId) clearMaskId(mask, replacedId);
    for (let index = 0; index < mask.length; index += 1) {
      if (recoveredMask[index] === recoveryId && !mask[index]) {
        mask[index] = nextId;
      }
    }
    nextId = Math.min(255, nextId + 1);
    recoveredBlocks += 1;
  }
  return { mask, recoveredBlocks };
}

function isBubbleRecoveryCandidate(block: TranslationBlock): boolean {
  return (
    !block.inpaintExcluded &&
    block.bbox.w > 0 &&
    block.bbox.h > 0 &&
    Number.isFinite(block.bbox.x) &&
    Number.isFinite(block.bbox.y)
  );
}

function toRecoveryHint(
  block: TranslationBlock,
  page: MangaPage,
): BubbleRecoveryHint {
  const normalized = normalizeBboxTo1000(
    block.bbox,
    { width: page.width, height: page.height },
    block.bboxSpace,
  );
  const pixels = bboxToPixels(normalized, page.width, page.height);
  const x = clamp(Math.floor(pixels.x), 0, Math.max(0, page.width - 1));
  const y = clamp(Math.floor(pixels.y), 0, Math.max(0, page.height - 1));
  const right = clamp(Math.ceil(pixels.x + pixels.w), x + 1, page.width);
  const bottom = clamp(Math.ceil(pixels.y + pixels.h), y + 1, page.height);
  return {
    blockId: block.id,
    rect: { x, y, w: right - x, h: bottom - y },
  };
}

function maskNeedsRecovery(
  mask: Uint8Array,
  page: Pick<MangaPage, "width" | "height">,
  rect: PixelRect,
): boolean {
  const bubbleId = dominantMaskId(mask, page.width, rect);
  if (!bubbleId) return true;
  const coverage =
    countMaskIdInRect(mask, page.width, rect, bubbleId) /
    Math.max(1, rect.w * rect.h);
  if (coverage < MINIMUM_MASK_COVERAGE) return true;
  const bounds = findMaskIdBounds(mask, page.width, page.height, bubbleId);
  if (!bounds) return true;
  return (
    bounds.w < rect.w * MINIMUM_BUBBLE_WIDTH_RATIO ||
    bounds.h < rect.h * MINIMUM_BUBBLE_HEIGHT_RATIO
  );
}

function dominantMaskId(
  mask: Uint8Array,
  width: number,
  rect: PixelRect,
): number {
  const counts = new Uint32Array(256);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const id = mask[y * width + x] ?? 0;
      if (id) counts[id] += 1;
    }
  }
  let best = 0;
  for (let id = 1; id < counts.length; id += 1) {
    if (counts[id] > counts[best]) best = id;
  }
  return best;
}

function countMaskIdInRect(
  mask: Uint8Array,
  width: number,
  rect: PixelRect,
  id: number,
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (mask[y * width + x] === id) count += 1;
    }
  }
  return count;
}

function findMaskIdBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  id: number,
): PixelRect | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== id) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return right >= left && bottom >= top
    ? { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
    : null;
}

function countMaskId(mask: Uint8Array, id: number): number {
  let count = 0;
  for (const value of mask) {
    if (value === id) count += 1;
  }
  return count;
}

function maximumMaskId(mask: Uint8Array): number {
  let maximum = 0;
  for (const value of mask) maximum = Math.max(maximum, value);
  return maximum;
}

function clearMaskId(mask: Uint8Array, id: number): void {
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === id) mask[index] = 0;
  }
}
