import type {
  BBox,
  BlockType,
  RenderTextDirection,
  TranslationBlock,
} from "./textTypes";
import type { ChapterSnapshot } from "./libraryTypes";

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

export const MIN_READABLE_FONT_SIZE_PX = 10;

/** 장평 (horizontal glyph scale) bounds, shared by editor preview and export. */
export const MIN_FONT_WIDTH_SCALE = 0.5;
export const MAX_FONT_WIDTH_SCALE = 1.5;
const DEFAULT_FONT_WIDTH_SCALE = 1;

const READABLE_AVERAGE_CHAR_WIDTH_RATIO = 0.95;
const READABLE_VERTICAL_COLUMN_WIDTH_RATIO = 1.15;
const READABLE_MAX_VERTICAL_COLUMNS = 2;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** Clamp a 장평 value to the supported range; undefined/invalid means 1. */
export function resolveFontWidthScale(
  value: number | undefined | null,
): number {
  return clamp(
    Number(value ?? DEFAULT_FONT_WIDTH_SCALE),
    MIN_FONT_WIDTH_SCALE,
    MAX_FONT_WIDTH_SCALE,
  );
}

export function clampBbox(bbox: BBox): BBox {
  const x = clamp(bbox.x, 0, 999);
  const y = clamp(bbox.y, 0, 999);
  const w = clamp(bbox.w, 1, 1000 - x);
  const h = clamp(bbox.h, 1, 1000 - y);
  return { x, y, w, h };
}

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
    ? normalizeBboxTo1000(block.renderBbox, pageSize, block.renderBboxSpace)
    : undefined;
  return {
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
}

export function bboxToPixels(bbox: BBox, width: number, height: number): BBox {
  return {
    x: (bbox.x / 1000) * width,
    y: (bbox.y / 1000) * height,
    w: (bbox.w / 1000) * width,
    h: (bbox.h / 1000) * height,
  };
}

export function pixelsToBbox(bbox: BBox, width: number, height: number): BBox {
  return clampBbox({
    x: (bbox.x / Math.max(1, width)) * 1000,
    y: (bbox.y / Math.max(1, height)) * 1000,
    w: (bbox.w / Math.max(1, width)) * 1000,
    h: (bbox.h / Math.max(1, height)) * 1000,
  });
}

export function normalizeBboxTo1000(
  bbox: BBox,
  pageSize?: PageSize | null,
  bboxSpace?: BBoxSpace,
): BBox {
  if (bboxSpace === "pixels" && pageSize) {
    return pixelsToBbox(bbox, pageSize.width, pageSize.height);
  }

  return clampBbox(bbox);
}

export function resolveBlockRenderBbox(
  block: RenderBboxBlock,
  pageSize?: PageSize | null,
): BBox {
  if (block.renderBbox) {
    return normalizeBboxTo1000(
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
      bbox: normalizeBboxTo1000(
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

export function applyEditableBlockBbox(
  block: TranslationBlock,
  nextBbox: BBox,
  pageSize?: PageSize | null,
  text = "",
): TranslationBlock {
  const target = resolveEditableBlockBbox(block, pageSize, text);
  const clamped = clampBbox(nextBbox);
  return target.key === "renderBbox"
    ? { ...block, renderBbox: clamped, renderBboxSpace: "normalized_1000" }
    : { ...block, bbox: clamped, bboxSpace: "normalized_1000" };
}

export function offsetBlockBboxes(
  block: TranslationBlock,
  dx: number,
  dy: number,
  pageSize?: PageSize | null,
): TranslationBlock {
  const bbox = normalizeBboxTo1000(block.bbox, pageSize, block.bboxSpace);
  const renderBbox = block.renderBbox
    ? normalizeBboxTo1000(block.renderBbox, pageSize, block.renderBboxSpace)
    : undefined;

  return {
    ...block,
    bbox: offsetBbox(bbox, dx, dy),
    bboxSpace: "normalized_1000",
    renderBbox: renderBbox ? offsetBbox(renderBbox, dx, dy) : undefined,
    renderBboxSpace: renderBbox ? "normalized_1000" : undefined,
  };
}

export function enforceRenderDirection(
  type: BlockType,
  direction: unknown,
): RenderTextDirection {
  void type;
  return direction === "vertical" ? "vertical" : "horizontal";
}

export function enforceRotationDeg(type: BlockType, value: unknown): number {
  void type;
  return normalizeRotationDeg(value);
}

export function normalizeRotationDeg(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  let normalized = ((((numeric + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180 && numeric > 0) {
    normalized = 180;
  }

  const rounded = Math.round((normalized + Number.EPSILON) * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeBlockType(value: unknown): BlockType {
  void value;
  return "nonsolid";
}

export function normalizeRenderDirection(
  value: unknown,
  fallback: RenderTextDirection | "rotated" | "hidden",
): RenderTextDirection {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "vertical") {
    return "vertical";
  }
  if (text === "horizontal" || text === "rotated" || text === "hidden") {
    return "horizontal";
  }
  return fallback === "vertical" ? "vertical" : "horizontal";
}

export function estimateFontSizePx(
  text: string,
  bbox: BBox,
  pageSize: { width: number; height: number },
): number {
  const px = bboxToPixels(bbox, pageSize.width, pageSize.height);
  const compactLength = Math.max(
    1,
    [...text.replace(/\r/g, "").replace(/\n/g, " ")].length,
  );
  const approxCharsPerLine = Math.max(4, Math.floor(px.w / 20));
  const lineCount = Math.max(1, Math.ceil(compactLength / approxCharsPerLine));
  const heightLimited = Math.floor(px.h / (lineCount * 1.2));
  const widthLimited = Math.floor(
    px.w / Math.min(12, Math.max(4, compactLength)),
  );
  return clamp(Math.min(heightLimited, widthLimited, 40), 12, 72);
}

function offsetBbox(bbox: BBox, dx: number, dy: number): BBox {
  return clampBbox({
    ...bbox,
    x: bbox.x + dx,
    y: bbox.y + dy,
  });
}

function estimateReadableTextBoxSizePx(
  text: string,
  block: RenderBboxBlock,
  basePx: BBox,
): { width: number; height: number } {
  const compactLength = Math.max(
    1,
    [...text.replace(/\r/g, "").replace(/\n/g, " ")].length,
  );
  const fontSizePx = MIN_READABLE_FONT_SIZE_PX;
  const letterSpacingPx = (block.letterSpacing ?? 0) * fontSizePx;
  const lineHeightPx = fontSizePx * Math.max(1, block.lineHeight ?? 1.18);

  if (block.renderDirection === "vertical") {
    const verticalAdvancePx = Math.max(1, lineHeightPx + letterSpacingPx);
    const availableHeight = Math.max(1, basePx.h);
    const charsPerColumn = Math.max(
      1,
      Math.floor(availableHeight / verticalAdvancePx),
    );
    const columnCount = Math.min(
      READABLE_MAX_VERTICAL_COLUMNS,
      Math.max(1, Math.ceil(compactLength / charsPerColumn)),
    );
    return {
      width: columnCount * fontSizePx * READABLE_VERTICAL_COLUMN_WIDTH_RATIO,
      height: Math.min(compactLength, charsPerColumn) * verticalAdvancePx,
    };
  }

  const charAdvancePx = Math.max(
    1,
    fontSizePx * READABLE_AVERAGE_CHAR_WIDTH_RATIO + letterSpacingPx,
  );
  const availableWidth = Math.max(1, basePx.w);
  const naturalCharsPerLine =
    resolveNaturalHorizontalCharsPerLine(compactLength);
  const widthLimitedCharsPerLine = Math.max(
    1,
    Math.floor(availableWidth / charAdvancePx),
  );
  const charsPerLine = Math.max(
    Math.min(compactLength, naturalCharsPerLine),
    Math.min(compactLength, widthLimitedCharsPerLine),
  );
  const lineCount = Math.max(1, Math.ceil(compactLength / charsPerLine));
  return {
    width: charsPerLine * charAdvancePx,
    height: lineCount * lineHeightPx,
  };
}

function resolveNaturalHorizontalCharsPerLine(compactLength: number): number {
  if (compactLength <= 4) {
    return compactLength;
  }
  if (compactLength <= 10) {
    return Math.min(compactLength, 5);
  }
  return Math.min(
    compactLength,
    Math.max(6, Math.min(14, Math.ceil(Math.sqrt(compactLength * 5)))),
  );
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
