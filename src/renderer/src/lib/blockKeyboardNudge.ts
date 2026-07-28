import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  applyEditableBlockBbox,
  clamp,
  resolveEditableBlockBbox,
} from "./blockFormatGeometry";

export type BlockNudgeDirection = "left" | "right" | "up" | "down";

const NUDGE_MIN_PIXELS = 1;
const NUDGE_MAX_PIXELS = 8;
const NUDGE_ACCELERATION_DELAY_MS = 300;
const NUDGE_ACCELERATION_DURATION_MS = 2_700;

export function resolveBlockNudgeDirection(
  key: string,
): BlockNudgeDirection | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

/**
 * Native key repeat supplies the cadence while this function progressively
 * increases the image-pixel distance. Shift keeps the familiar editor
 * convention of a fixed 10 px nudge.
 */
export function resolveBlockNudgeDistancePx(
  heldForMs: number,
  shiftKey = false,
): number {
  if (shiftKey) {
    return 10;
  }
  const elapsed = Math.max(0, heldForMs);
  const progress = clamp(
    (elapsed - NUDGE_ACCELERATION_DELAY_MS) / NUDGE_ACCELERATION_DURATION_MS,
    0,
    1,
  );
  // Smoothstep has no velocity jump at either end, avoiding the visible
  // 1 → 2 → 4 → 8 px changes from the previous stepped acceleration.
  const easedProgress = progress * progress * (3 - 2 * progress);
  return (
    NUDGE_MIN_PIXELS + (NUDGE_MAX_PIXELS - NUDGE_MIN_PIXELS) * easedProgress
  );
}

/**
 * Combines simultaneously held arrows into one movement vector. Diagonals are
 * normalized so they have the same overall speed as a single-axis move.
 * Opposing keys cancel only their shared axis.
 */
export function resolveHeldBlockNudgeDelta(
  keys: Iterable<string>,
  distancePx: number,
): { x: number; y: number } | null {
  const directions = new Set<BlockNudgeDirection>();
  for (const key of keys) {
    const direction = resolveBlockNudgeDirection(key);
    if (direction) directions.add(direction);
  }
  const horizontal =
    Number(directions.has("right")) - Number(directions.has("left"));
  const vertical =
    Number(directions.has("down")) - Number(directions.has("up"));
  if (horizontal === 0 && vertical === 0) {
    return null;
  }
  const scale = horizontal !== 0 && vertical !== 0 ? Math.SQRT1_2 : 1;
  return {
    x: horizontal * distancePx * scale,
    y: vertical * distancePx * scale,
  };
}

/**
 * Moves the same editable box used by pointer dragging. The requested distance
 * is expressed in natural image pixels, then converted to normalized page
 * coordinates while preserving the box size at page boundaries.
 */
export function nudgeBlockByImagePixels(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
  deltaPx: { x: number; y: number },
): TranslationBlock {
  const pageSize = {
    width: Math.max(1, page.width),
    height: Math.max(1, page.height),
  };
  const displayText = block.translatedText || block.sourceText || "...";
  const target = resolveEditableBlockBbox(block, pageSize, displayText);
  const deltaX = (deltaPx.x / pageSize.width) * 1000;
  const deltaY = (deltaPx.y / pageSize.height) * 1000;
  const nextBbox = {
    ...target.bbox,
    x: clamp(target.bbox.x + deltaX, 0, 1000 - target.bbox.w),
    y: clamp(target.bbox.y + deltaY, 0, 1000 - target.bbox.h),
  };
  if (nextBbox.x === target.bbox.x && nextBbox.y === target.bbox.y) {
    return block;
  }
  return applyEditableBlockBbox(block, nextBbox, pageSize, displayText);
}

/**
 * Clamps a multi-block move as one group so blocks keep their relative
 * positions when any selected block reaches a page edge.
 */
export function resolveSharedBlockNudgeDeltaPx(
  blocks: readonly TranslationBlock[],
  page: Pick<MangaPage, "width" | "height">,
  requestedDeltaPx: { x: number; y: number },
): { x: number; y: number } {
  if (blocks.length === 0) {
    return { x: 0, y: 0 };
  }
  const pageSize = {
    width: Math.max(1, page.width),
    height: Math.max(1, page.height),
  };
  const bboxes = blocks.map(
    (block) =>
      resolveEditableBlockBbox(
        block,
        pageSize,
        block.translatedText || block.sourceText || "...",
      ).bbox,
  );
  const requestedX = (requestedDeltaPx.x / pageSize.width) * 1000;
  const requestedY = (requestedDeltaPx.y / pageSize.height) * 1000;
  const minimumX = Math.max(...bboxes.map((bbox) => -bbox.x));
  const maximumX = Math.min(...bboxes.map((bbox) => 1000 - bbox.x - bbox.w));
  const minimumY = Math.max(...bboxes.map((bbox) => -bbox.y));
  const maximumY = Math.min(...bboxes.map((bbox) => 1000 - bbox.y - bbox.h));
  return {
    x: (clamp(requestedX, minimumX, maximumX) / 1000) * pageSize.width,
    y: (clamp(requestedY, minimumY, maximumY) / 1000) * pageSize.height,
  };
}
