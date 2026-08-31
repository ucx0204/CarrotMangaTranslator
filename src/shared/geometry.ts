import type { BBox, Point, TranslationBlock } from "./textTypes";
import type { ChapterSnapshot } from "./libraryTypes";
import {
  clampTranslationToVisibleBboxes,
  translateBbox,
} from "./bboxTranslation";
import {
  estimateFontSizePx,
  normalizeRenderDirection,
} from "./blockGeometryValues";
import { MIN_VISIBLE_RENDER_BBOX_EXTENT, clampRenderBbox } from "./renderBbox";
import {
  constrainEditableRenderBbox,
  resolveTransformedBlockBoundary,
  resolveTransformedBlockBounds,
} from "./editableRenderGeometry";
import { estimateReadableTextBoxSizePx } from "./readableTextBox";
import { clamp, normalizeBboxTo1000, pixelsToBbox } from "./bboxNormalization";

export {
  clamp,
  clampBbox,
  normalizeBboxTo1000,
  pixelsToBbox,
} from "./bboxNormalization";

export {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
  enforceRenderDirection,
  enforceRotationDeg,
  estimateFontSizePx,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  resolveFontWidthScale,
} from "./blockGeometryValues";
type PageSize = {
  width: number;
  height: number;
};

type BBoxSpace = NonNullable<TranslationBlock["bboxSpace"]>;
type RenderBboxBlock = Pick<TranslationBlock, "bbox" | "renderBbox"> &
  Partial<
    Pick<
      TranslationBlock,
      | "bboxSpace"
      | "renderBboxSpace"
      | "renderDirection"
      | "lineHeight"
      | "letterSpacing"
      | "fontSizePx"
      | "autoFitText"
    >
  >;

/** Intersection area relative to the smaller box, with a one-unit area floor. */
export function bboxOverlapRatio(a: BBox, b: BBox): number {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) {
    return 0;
  }
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return overlap / minArea;
}

export function sanitizeChapterBboxes(
  chapter: ChapterSnapshot,
): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) =>
        sanitizeBlockBboxes(block, { width: page.width, height: page.height }),
      ),
    })),
  };
}

function sanitizeBlockBboxes(
  block: TranslationBlock,
  pageSize?: PageSize | null,
): TranslationBlock {
  const renderBbox = block.renderBbox
    ? normalizeRenderBboxTo1000(
        block.renderBbox,
        pageSize,
        block.renderBboxSpace,
      )
    : undefined;
  const normalized: TranslationBlock = {
    ...block,
    bbox: normalizeBboxTo1000(block.bbox, pageSize, block.bboxSpace),
    bboxSpace: "normalized_1000",
    renderBbox,
    renderBboxSpace: renderBbox ? "normalized_1000" : undefined,
    renderDirection: normalizeRenderDirection(
      block.renderDirection,
      "horizontal",
    ),
  };
  return renderBbox
    ? {
        ...normalized,
        renderBbox: constrainEditableRenderBbox(normalized, renderBbox),
      }
    : normalized;
}

export function bboxToPixels(bbox: BBox, width: number, height: number): BBox {
  return {
    x: (bbox.x / 1000) * width,
    y: (bbox.y / 1000) * height,
    w: (bbox.w / 1000) * width,
    h: (bbox.h / 1000) * height,
  };
}

function pixelsToRenderBbox(bbox: BBox, width: number, height: number): BBox {
  return clampRenderBbox({
    x: (bbox.x / Math.max(1, width)) * 1000,
    y: (bbox.y / Math.max(1, height)) * 1000,
    w: (bbox.w / Math.max(1, width)) * 1000,
    h: (bbox.h / Math.max(1, height)) * 1000,
  });
}

export function normalizeRenderBboxTo1000(
  bbox: BBox,
  pageSize?: PageSize | null,
  bboxSpace?: BBoxSpace,
): BBox {
  if (bboxSpace === "pixels" && pageSize) {
    return pixelsToRenderBbox(bbox, pageSize.width, pageSize.height);
  }

  return clampRenderBbox(bbox);
}

export function resolveBlockRenderBbox(
  block: RenderBboxBlock,
  pageSize?: PageSize | null,
): BBox {
  if (block.renderBbox) {
    return normalizeRenderBboxTo1000(
      block.renderBbox,
      pageSize,
      block.renderBboxSpace,
    );
  }

  return normalizeBboxTo1000(block.bbox, pageSize, block.bboxSpace);
}

export function resolveEffectiveRenderBbox(
  block: RenderBboxBlock,
  pageSize: PageSize,
  text: string,
): BBox {
  const base = resolveBlockRenderBbox(block, pageSize);
  if (block.renderBbox || !text.trim()) {
    return base;
  }

  const basePx = bboxToPixels(base, pageSize.width, pageSize.height);
  const requiredSize = estimateReadableTextBoxSizePx(text, block, basePx);
  const nextWidth = Math.max(basePx.w, requiredSize.width);
  const nextHeight = Math.max(basePx.h, requiredSize.height);

  if (nextWidth <= basePx.w && nextHeight <= basePx.h) {
    return base;
  }

  return expandBboxAroundCenter(base, pageSize, nextWidth, nextHeight);
}

export function estimateBlockFontSizePx(
  text: string,
  block: RenderBboxBlock,
  pageSize: PageSize,
): number {
  return estimateFontSizePx(
    text,
    resolveEffectiveRenderBbox(block, pageSize, text),
    pageSize,
  );
}

export function resolveEditableBlockBbox(
  block: RenderBboxBlock,
  pageSize?: PageSize | null,
  text = "",
): { key: "bbox" | "renderBbox"; bbox: BBox } {
  if (block.renderBbox) {
    return {
      key: "renderBbox",
      bbox: normalizeRenderBboxTo1000(
        block.renderBbox,
        pageSize,
        block.renderBboxSpace,
      ),
    };
  }

  const bbox = normalizeBboxTo1000(block.bbox, pageSize, block.bboxSpace);
  if (pageSize && text.trim()) {
    const effectiveRenderBbox = resolveEffectiveRenderBbox(
      block,
      pageSize,
      text,
    );
    if (!areBboxesClose(effectiveRenderBbox, bbox)) {
      return { key: "renderBbox", bbox: effectiveRenderBbox };
    }
  }

  return { key: "bbox", bbox };
}

/**
 * Resolves the frame users can see and manipulate in the editor. Source OCR
 * geometry is deliberately excluded once a render box exists, and visual
 * transforms are included so marquee selection matches the displayed frame.
 */
export function resolveBlockSelectionBounds(
  block: TranslationBlock,
  pageSize: PageSize,
): BBox {
  const text = block.translatedText || block.sourceText || "...";
  const target = resolveEditableBlockBbox(block, pageSize, text);
  return resolveTransformedBlockBounds(block, target.bbox);
}

export function resolveBlockSelectionBoundary(
  block: TranslationBlock,
  pageSize: PageSize,
): Point[] {
  const text = block.translatedText || block.sourceText || "...";
  const target = resolveEditableBlockBbox(block, pageSize, text);
  return resolveTransformedBlockBoundary(block, target.bbox);
}

export function applyEditableBlockBbox(
  block: TranslationBlock,
  nextBbox: BBox,
  _pageSize?: PageSize | null,
  _text = "",
): TranslationBlock {
  const renderBbox = constrainEditableRenderBbox(block, nextBbox);
  return {
    ...block,
    renderBbox,
    renderBboxSpace: "normalized_1000",
  };
}

/**
 * Moves only the pointer-editable render box. The OCR/inpainting source box is
 * immutable during manual placement.
 */
export function applyMovedEditableBlockBbox(
  block: TranslationBlock,
  nextBbox: BBox,
  pageSize?: PageSize | null,
  text = "",
): TranslationBlock {
  const target = resolveEditableBlockBbox(block, pageSize, text);
  const visualBounds = resolveTransformedBlockBounds(block, target.bbox);
  const delta = clampTranslationToVisibleBboxes(
    [visualBounds],
    {
      x: nextBbox.x - target.bbox.x,
      y: nextBbox.y - target.bbox.y,
    },
    MIN_VISIBLE_RENDER_BBOX_EXTENT,
  );
  if (delta.x === 0 && delta.y === 0) {
    return block;
  }

  return {
    ...block,
    renderBbox: clampRenderBbox(translateBbox(target.bbox, delta)),
    renderBboxSpace: "normalized_1000",
  };
}

/**
 * Restricts a shared interactive move so each transformed render box keeps a
 * small recoverable extent on-page. Source OCR boxes do not participate.
 */
export function resolveSharedEditableBlockMoveDelta(
  blocks: readonly TranslationBlock[],
  pageSize: PageSize,
  requestedDelta: { x: number; y: number },
): { x: number; y: number } {
  const bboxes = blocks.map((block) =>
    resolveTransformedBlockBounds(
      block,
      resolveEditableBlockBbox(
        block,
        pageSize,
        block.translatedText || block.sourceText || "...",
      ).bbox,
    ),
  );
  return clampTranslationToVisibleBboxes(
    bboxes,
    requestedDelta,
    MIN_VISIBLE_RENDER_BBOX_EXTENT,
  );
}

export function offsetBlockBboxes(
  block: TranslationBlock,
  dx: number,
  dy: number,
  pageSize?: PageSize | null,
): TranslationBlock {
  const target = resolveEditableBlockBbox(
    block,
    pageSize,
    block.translatedText || block.sourceText || "...",
  );
  const delta = clampTranslationToVisibleBboxes(
    [resolveTransformedBlockBounds(block, target.bbox)],
    { x: dx, y: dy },
    MIN_VISIBLE_RENDER_BBOX_EXTENT,
  );

  return {
    ...block,
    renderBbox: clampRenderBbox(translateBbox(target.bbox, delta)),
    renderBboxSpace: "normalized_1000",
  };
}

function expandBboxAroundCenter(
  bbox: BBox,
  pageSize: PageSize,
  targetWidthPx: number,
  targetHeightPx: number,
): BBox {
  const px = bboxToPixels(bbox, pageSize.width, pageSize.height);
  const width = Math.min(pageSize.width, Math.max(px.w, targetWidthPx));
  const height = Math.min(pageSize.height, Math.max(px.h, targetHeightPx));
  const centerX = px.x + px.w / 2;
  const centerY = px.y + px.h / 2;
  const x = clamp(centerX - width / 2, 0, Math.max(0, pageSize.width - width));
  const y = clamp(
    centerY - height / 2,
    0,
    Math.max(0, pageSize.height - height),
  );
  return pixelsToBbox(
    { x, y, w: width, h: height },
    pageSize.width,
    pageSize.height,
  );
}

function areBboxesClose(a: BBox, b: BBox): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 &&
    Math.abs(a.h - b.h) < 0.01
  );
}
