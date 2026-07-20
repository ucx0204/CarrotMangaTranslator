import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { bboxToPixelRect, type PixelRect } from "./maskGeometry";
import { buildLightweightBubbleMask } from "./lightweightBubbleDetection";

export { buildLightweightBubbleMask } from "./lightweightBubbleDetection";

export type BubbleMaskDetectionResult = {
  mask: Uint8Array;
  matchedBlocks: number;
  regions: number;
  splitRegions: number;
  recoveryCandidates?: number;
  recoveredBlocks?: number;
};

export function refinePreciseBubbleMask(
  preciseMask: Uint8Array,
  bitmap: Buffer,
  page: MangaPage,
): BubbleMaskDetectionResult {
  if (preciseMask.length !== page.width * page.height) {
    return buildLightweightBubbleMask(bitmap, page);
  }
  const blocks = page.blocks.filter((block) => blockHasDetectableBubble(block));
  const { assignments, unmatched } = assignBlocksToBubbles(
    preciseMask,
    page,
    blocks,
  );
  const output = new Uint8Array(preciseMask.length);
  let nextId = 1;
  let splitRegions = 0;
  for (const [bubbleId, assignedBlocks] of assignments) {
    const outputIds = assignedBlocks.map(() => Math.min(255, nextId++));
    if (assignedBlocks.length > 1) {
      splitRegions += 1;
    }
    paintAssignedPreciseRegion({
      assignedBlocks,
      bubbleId,
      output,
      outputIds,
      page,
      preciseMask,
    });
  }
  const fallback = buildLightweightBubbleMask(bitmap, {
    ...page,
    blocks: unmatched,
  });
  nextId = mergeFallbackMask(output, fallback.mask, nextId);
  return {
    mask: output,
    matchedBlocks: blocks.length - unmatched.length + fallback.matchedBlocks,
    regions: countMaskIds(output),
    splitRegions,
  };
}

function blockHasDetectableBubble(block: TranslationBlock): boolean {
  const { x, y, w, h } = block.bbox;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0 &&
    !block.inpaintExcluded
  );
}

function assignBlocksToBubbles(
  preciseMask: Uint8Array,
  page: MangaPage,
  blocks: TranslationBlock[],
): {
  assignments: Map<number, TranslationBlock[]>;
  unmatched: TranslationBlock[];
} {
  const assignments = new Map<number, TranslationBlock[]>();
  const unmatched: TranslationBlock[] = [];
  for (const block of blocks) {
    const bubbleId = resolveBubbleIdForRect(
      preciseMask,
      page.width,
      bboxToPixelRect(block.bbox, page),
    );
    if (!bubbleId) {
      unmatched.push(block);
      continue;
    }
    assignments.set(bubbleId, [...(assignments.get(bubbleId) ?? []), block]);
  }
  return { assignments, unmatched };
}

function mergeFallbackMask(
  output: Uint8Array,
  fallback: Uint8Array,
  startingId: number,
): number {
  const idMap = new Map<number, number>();
  let nextId = startingId;
  for (let index = 0; index < output.length; index += 1) {
    const fallbackId = fallback[index] ?? 0;
    if (output[index] || !fallbackId) {
      continue;
    }
    let outputId = idMap.get(fallbackId);
    if (!outputId) {
      outputId = Math.min(255, nextId++);
      idMap.set(fallbackId, outputId);
    }
    output[index] = outputId;
  }
  return nextId;
}

function countMaskIds(mask: Uint8Array): number {
  const ids = new Set(mask);
  return ids.size - (ids.has(0) ? 1 : 0);
}

export function resolveBubbleIdForRect(
  bubbleMask: Uint8Array,
  pageWidth: number,
  rect: PixelRect,
): number {
  const counts = new Uint32Array(256);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const id = bubbleMask[y * pageWidth + x] ?? 0;
      if (id) counts[id] += 1;
    }
  }
  let bestId = 0;
  for (let id = 1; id < counts.length; id += 1) {
    if (counts[id] > counts[bestId]) bestId = id;
  }
  return bestId;
}

export function buildBubbleConstraintMask(
  bubbleMask: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  rect: PixelRect,
  bubbleId: number,
  erosionRadius = 2,
): Uint8Array {
  const local = new Uint8Array(rect.w * rect.h);
  if (!bubbleId) return local;
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      paintConstraintPixel({
        bubbleId,
        bubbleMask,
        erosionRadius,
        local,
        pageHeight,
        pageWidth,
        rect,
        x,
        y,
      });
    }
  }
  return local;
}

function paintConstraintPixel(options: {
  bubbleId: number;
  bubbleMask: Uint8Array;
  erosionRadius: number;
  local: Uint8Array;
  pageHeight: number;
  pageWidth: number;
  rect: PixelRect;
  x: number;
  y: number;
}): void {
  const pageX = options.rect.x + options.x;
  const pageY = options.rect.y + options.y;
  if (
    pageX < 0 ||
    pageX >= options.pageWidth ||
    pageY < 0 ||
    pageY >= options.pageHeight ||
    options.bubbleMask[pageY * options.pageWidth + pageX] !== options.bubbleId
  ) {
    return;
  }
  if (
    bubblePixelHasInset(
      options.bubbleMask,
      options.pageWidth,
      options.pageHeight,
      pageX,
      pageY,
      options.bubbleId,
      options.erosionRadius,
    )
  ) {
    options.local[options.y * options.rect.w + options.x] = 1;
  }
}

function paintAssignedPreciseRegion(options: {
  assignedBlocks: TranslationBlock[];
  bubbleId: number;
  output: Uint8Array;
  outputIds: number[];
  page: MangaPage;
  preciseMask: Uint8Array;
}): void {
  const rects = options.assignedBlocks.map((block) =>
    bboxToPixelRect(block.bbox, options.page),
  );
  for (let index = 0; index < options.preciseMask.length; index += 1) {
    if (options.preciseMask[index] !== options.bubbleId) continue;
    const x = index % options.page.width;
    const y = Math.floor(index / options.page.width);
    const best = nearestRectIndex(rects, x, y);
    options.output[index] = options.outputIds[best] ?? 0;
  }
}

function nearestRectIndex(rects: PixelRect[], x: number, y: number): number {
  let best = 0;
  for (let candidate = 1; candidate < rects.length; candidate += 1) {
    if (
      normalizedCenterDistance(rects[candidate], x, y) <
      normalizedCenterDistance(rects[best], x, y)
    ) {
      best = candidate;
    }
  }
  return best;
}

function normalizedCenterDistance(
  rect: PixelRect,
  x: number,
  y: number,
): number {
  const dx = (x - (rect.x + rect.w / 2)) / Math.max(1, rect.w);
  const dy = (y - (rect.y + rect.h / 2)) / Math.max(1, rect.h);
  return dx * dx + dy * dy;
}

function bubblePixelHasInset(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  id: number,
  radius: number,
): boolean {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (
        nx < 0 ||
        nx >= width ||
        ny < 0 ||
        ny >= height ||
        mask[ny * width + nx] !== id
      ) {
        return false;
      }
    }
  }
  return true;
}
