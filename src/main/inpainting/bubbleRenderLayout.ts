import {
  bboxToPixels,
  clamp,
  normalizeBboxTo1000,
  pixelsToBbox,
} from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  buildBubbleConstraintMask,
  resolveBubbleIdForRect,
} from "./bubbleMaskDetection";
import type { PixelRect } from "./maskGeometry";

export type BubbleRenderLayoutResult = {
  blocks: TranslationBlock[];
  expandedBlocks: number;
};

export function applyBubbleRenderLayouts(
  page: MangaPage,
  bubbleMask: Uint8Array,
): BubbleRenderLayoutResult {
  if (bubbleMask.length !== page.width * page.height) {
    return { blocks: page.blocks, expandedBlocks: 0 };
  }
  let expandedBlocks = 0;
  const blocks = page.blocks.map((block) => {
    const renderBbox = resolveAutomaticRenderBbox(page, block, bubbleMask);
    if (!renderBbox) return block;
    expandedBlocks += 1;
    return {
      ...block,
      renderBbox,
      renderBboxSpace: "normalized_1000" as const,
      autoFitText: true,
    };
  });
  return { blocks, expandedBlocks };
}

export function resolveAutomaticRenderBbox(
  page: MangaPage,
  block: TranslationBlock,
  bubbleMask: Uint8Array,
): TranslationBlock["renderBbox"] | null {
  if (!isEligibleForAutomaticLayout(block)) return null;
  const sourceRect = resolveSourcePixelRect(page, block);
  const bubbleId = resolveBubbleIdForRect(bubbleMask, page.width, sourceRect);
  if (!bubbleId) return null;
  const bubbleBounds = findBubbleBounds(
    bubbleMask,
    page.width,
    page.height,
    bubbleId,
  );
  if (!bubbleBounds) return null;
  const erosionRadius = clamp(
    Math.round(Math.min(bubbleBounds.w, bubbleBounds.h) * 0.025),
    3,
    10,
  );
  const safeMask = buildBubbleConstraintMask(
    bubbleMask,
    page.width,
    page.height,
    bubbleBounds,
    bubbleId,
    erosionRadius,
  );
  const anchor = findNearestSafePixel(safeMask, bubbleBounds, sourceRect);
  if (!anchor) return null;
  const candidate = findBestAnchoredRectangle(
    safeMask,
    bubbleBounds.w,
    bubbleBounds.h,
    anchor,
    block.fontSizePx,
  );
  if (!candidate) return null;
  const padded = insetLayoutRect(
    {
      x: bubbleBounds.x + candidate.x,
      y: bubbleBounds.y + candidate.y,
      w: candidate.w,
      h: candidate.h,
    },
    block.fontSizePx,
  );
  if (!hasUsefulHorizontalGrowth(sourceRect, padded, block.fontSizePx)) {
    return null;
  }
  return pixelsToBbox(padded, page.width, page.height);
}

function isEligibleForAutomaticLayout(block: TranslationBlock): boolean {
  return (
    !block.renderBbox &&
    !block.inpaintExcluded &&
    block.renderDirection === "horizontal" &&
    Boolean(block.translatedText.trim()) &&
    block.bbox.w > 0 &&
    block.bbox.h > 0
  );
}

function resolveSourcePixelRect(
  page: MangaPage,
  block: TranslationBlock,
): PixelRect {
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
  return { x, y, w: right - x, h: bottom - y };
}

function findBubbleBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  bubbleId: number,
): PixelRect | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== bubbleId) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right >= left && bottom >= top
    ? { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
    : null;
}

function findNearestSafePixel(
  mask: Uint8Array,
  bounds: PixelRect,
  sourceRect: PixelRect,
): { x: number; y: number } | null {
  const targetX = sourceRect.x + sourceRect.w / 2 - bounds.x;
  const targetY = sourceRect.y + sourceRect.h / 2 - bounds.y;
  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < bounds.h; y += 1) {
    for (let x = 0; x < bounds.w; x += 1) {
      if (!mask[y * bounds.w + x]) continue;
      const distance = (x - targetX) ** 2 + (y - targetY) ** 2;
      if (distance < bestDistance) {
        best = { x, y };
        bestDistance = distance;
      }
    }
  }
  return best;
}

type HorizontalRun = { left: number; right: number };

function findBestAnchoredRectangle(
  mask: Uint8Array,
  width: number,
  height: number,
  anchor: { x: number; y: number },
  fontSizePx: number,
): PixelRect | null {
  const runs = Array.from({ length: height }, (_, y) =>
    findHorizontalRun(mask, width, y, anchor.x),
  );
  if (!runs[anchor.y]) return null;
  const minimumHeight = Math.max(8, Math.round(fontSizePx * 1.35));
  let best: { rect: PixelRect; score: number } | null = null;
  let topLeft = 0;
  let topRight = width - 1;
  for (let top = anchor.y; top >= 0; top -= 1) {
    const topRun = runs[top];
    if (!topRun) break;
    topLeft = Math.max(topLeft, topRun.left);
    topRight = Math.min(topRight, topRun.right);
    best = expandCandidateDown({
      anchorY: anchor.y,
      best,
      fontSizePx,
      minimumHeight,
      runs,
      top,
      topLeft,
      topRight,
    });
  }
  return best?.rect ?? null;
}

function expandCandidateDown(options: {
  anchorY: number;
  best: { rect: PixelRect; score: number } | null;
  fontSizePx: number;
  minimumHeight: number;
  runs: Array<HorizontalRun | null>;
  top: number;
  topLeft: number;
  topRight: number;
}): { rect: PixelRect; score: number } | null {
  let best = options.best;
  let left = options.topLeft;
  let right = options.topRight;
  for (
    let bottom = options.anchorY;
    bottom < options.runs.length;
    bottom += 1
  ) {
    const run = options.runs[bottom];
    if (!run) break;
    left = Math.max(left, run.left);
    right = Math.min(right, run.right);
    const rect = {
      x: left,
      y: options.top,
      w: right - left + 1,
      h: bottom - options.top + 1,
    };
    if (rect.w <= 0 || rect.h < options.minimumHeight) continue;
    const score = scoreHorizontalLayout(rect, options.fontSizePx);
    if (!best || score > best.score) best = { rect, score };
  }
  return best;
}

function findHorizontalRun(
  mask: Uint8Array,
  width: number,
  y: number,
  x: number,
): HorizontalRun | null {
  if (!mask[y * width + x]) return null;
  let left = x;
  let right = x;
  while (left > 0 && mask[y * width + left - 1]) left -= 1;
  while (right + 1 < width && mask[y * width + right + 1]) right += 1;
  return { left, right };
}

function scoreHorizontalLayout(rect: PixelRect, fontSizePx: number): number {
  const area = rect.w * rect.h;
  const aspectRatio = rect.w / Math.max(1, rect.h);
  const widthBonus = 0.8 + Math.min(2.5, aspectRatio) * 0.2;
  const shallowPenalty = Math.min(1, rect.h / Math.max(1, fontSizePx * 1.8));
  return area * widthBonus * shallowPenalty;
}

function insetLayoutRect(rect: PixelRect, fontSizePx: number): PixelRect {
  const inset = clamp(Math.round(fontSizePx * 0.12), 1, 4);
  if (rect.w <= inset * 2 + 1 || rect.h <= inset * 2 + 1) return rect;
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    w: rect.w - inset * 2,
    h: rect.h - inset * 2,
  };
}

function hasUsefulHorizontalGrowth(
  source: PixelRect,
  candidate: PixelRect,
  fontSizePx: number,
): boolean {
  const minimumWidth = Math.max(source.w * 1.15, fontSizePx * 3.2);
  const minimumHeight = Math.max(fontSizePx * 1.15, 8);
  return candidate.w >= minimumWidth && candidate.h >= minimumHeight;
}
