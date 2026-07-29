import {
  isUsableBubbleLayout,
  type BubbleLayout,
  type BubbleShapeSpan,
} from "../../shared/bubbleLayout";
import { resolveDisjointBubbleLayout } from "../../shared/bubbleLayoutDisjoint";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { resolveBlockRenderBboxInPixels, type PixelRect } from "./maskGeometry";

/**
 * Rasterizes the same shape that the editor displays as the green bubble
 * guide. The mask is a hard safety boundary for source-text inpainting.
 */
export function buildBubbleLayoutConstraintMask(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
  imageWidth: number,
  imageHeight: number,
): InpaintingWindowMask | null {
  if (!isUsableBubbleLayout(block.bubbleLayout)) return null;
  const renderBbox = resolveBlockRenderBboxInPixels(
    block,
    page,
    imageWidth,
    imageHeight,
  );
  const bounds = clampPixelBounds(renderBbox, imageWidth, imageHeight);
  if (!bounds) return null;
  const layout =
    resolveDisjointBubbleLayout(block.bubbleLayout, {
      blockExtentPx:
        block.bubbleLayout.direction === "horizontal"
          ? renderBbox.h
          : renderBbox.w,
      inlineExtentPx:
        block.bubbleLayout.direction === "horizontal"
          ? renderBbox.w
          : renderBbox.h,
    }) ?? block.bubbleLayout;
  const data = new Uint8Array(bounds.w * bounds.h);
  for (const region of layout.regions) {
    for (const span of region.spans) {
      fillSpan(data, bounds, renderBbox, layout.direction, span);
    }
  }
  return data.some(Boolean) ? { bounds, data } : null;
}

/** Projects a page-space window mask into another page-space rectangle. */
export function projectWindowMask(
  source: InpaintingWindowMask,
  target: PixelRect,
): Uint8Array {
  const output = new Uint8Array(target.w * target.h);
  const left = Math.max(source.bounds.x, target.x);
  const top = Math.max(source.bounds.y, target.y);
  const right = Math.min(
    source.bounds.x + source.bounds.w,
    target.x + target.w,
  );
  const bottom = Math.min(
    source.bounds.y + source.bounds.h,
    target.y + target.h,
  );
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const sourceIndex =
        (y - source.bounds.y) * source.bounds.w + x - source.bounds.x;
      if (source.data[sourceIndex]) {
        output[(y - target.y) * target.w + x - target.x] = 1;
      }
    }
  }
  return output;
}

function fillSpan(
  mask: Uint8Array,
  bounds: PixelRect,
  renderBbox: BBox,
  direction: BubbleLayout["direction"],
  span: BubbleShapeSpan,
): void {
  const horizontal = direction === "horizontal";
  const xStart = horizontal ? span.inlineStart : span.blockStart;
  const xEnd = horizontal ? span.inlineEnd : span.blockEnd;
  const yStart = horizontal ? span.blockStart : span.inlineStart;
  const yEnd = horizontal ? span.blockEnd : span.inlineEnd;
  const left = renderBbox.x + xStart * renderBbox.w;
  const right = renderBbox.x + xEnd * renderBbox.w;
  const top = renderBbox.y + yStart * renderBbox.h;
  const bottom = renderBbox.y + yEnd * renderBbox.h;
  for (let y = bounds.y; y < bounds.y + bounds.h; y += 1) {
    if (y + 0.5 < top || y + 0.5 >= bottom) continue;
    for (let x = bounds.x; x < bounds.x + bounds.w; x += 1) {
      if (x + 0.5 >= left && x + 0.5 < right) {
        mask[(y - bounds.y) * bounds.w + x - bounds.x] = 1;
      }
    }
  }
}

function clampPixelBounds(
  bbox: BBox,
  imageWidth: number,
  imageHeight: number,
): PixelRect | null {
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(imageWidth, Math.ceil(bbox.x + bbox.w));
  const bottom = Math.min(imageHeight, Math.ceil(bbox.y + bbox.h));
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}
