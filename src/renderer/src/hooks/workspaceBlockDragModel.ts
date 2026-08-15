import {
  isValidPerspectiveTransform,
  isValidWarpTransform,
  normalizeCurveLayout,
  normalizePerspectiveTransform,
  validateQuadraticPath,
} from "../../../shared/blockTransforms";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { constrainEditableRenderBbox } from "../../../shared/editableRenderGeometry";
import rotateCursorUrl from "../assets/cursors/tabler-rotate-clockwise.svg";
import {
  applyEditableBlockBbox,
  applyMovedEditableBlockBbox,
  resolveSharedEditableBlockMoveDelta,
} from "../lib/blockFormatGeometry";
import {
  isPerspectiveVisibleOnPage,
  isWarpVisibleOnPage,
} from "../lib/transformEditorModel";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import {
  describeDragBbox,
  describeTransformPoint,
  isResizeDragMode,
  resolveDraggedBbox,
  resolveDraggedCurveLayout,
  resolveDraggedPerspective,
  resolveDraggedRotationWithSnap,
  type DragState,
  type PointerRect,
} from "./workspacePointerGeometry";
import {
  resolveDraggedWarpTransform,
  warpPointIndexesFromMode,
} from "./workspaceWarpPointerGeometry";

export type BlockDragResolution = {
  bbox?: BBox;
  patch?: Partial<TranslationBlock>;
  label: string;
  mode: DragMode;
  invalid?: boolean;
  invalidKind?: "perspective" | "curve" | "warp" | "outside";
  snapped?: boolean;
};

type DragPointer = {
  clientX: number;
  clientY: number;
  shiftKey?: boolean;
};

export function resolveBlockDrag(
  drag: DragState,
  event: DragPointer,
  rect: PointerRect,
  page: MangaPage,
): BlockDragResolution | null {
  if (drag.mode === "move" || isResizeDragMode(drag.mode)) {
    const requestedBbox = resolveDraggedBbox(drag, event, rect, page);
    const bbox =
      drag.mode === "move"
        ? constrainMovedBlockBbox(drag, requestedBbox, page)
        : constrainEditableRenderBbox(drag.startBlock, requestedBbox);
    return {
      bbox,
      label: describeDragBbox(drag.mode, bbox, page),
      mode: drag.mode,
    };
  }
  if (drag.mode === "rotate") {
    const result = resolveDraggedRotationWithSnap(drag, event, rect);
    const nextBlock = {
      ...drag.startBlock,
      rotationDeg: result.rotationDeg,
    };
    const bbox = constrainEditableRenderBbox(nextBlock, drag.startBbox);
    return {
      ...(areBboxesEqual(bbox, drag.startBbox) ? {} : { bbox }),
      patch: { rotationDeg: result.rotationDeg },
      label: `${result.rotationDeg}°`,
      mode: drag.mode,
      snapped: result.snapped,
    };
  }
  if (drag.mode.startsWith("perspective-")) {
    return resolvePerspectiveDrag(drag, event, rect, page);
  }
  if (drag.mode.startsWith("curve-")) {
    return resolveCurveDrag(drag, event, rect);
  }
  if (drag.mode.startsWith("warp-points-")) {
    return resolveWarpDrag(drag, event, rect, page);
  }
  return null;
}

function areBboxesEqual(left: BBox, right: BBox): boolean {
  return (
    Math.abs(left.x - right.x) < 0.0001 &&
    Math.abs(left.y - right.y) < 0.0001 &&
    Math.abs(left.w - right.w) < 0.0001 &&
    Math.abs(left.h - right.h) < 0.0001
  );
}

function constrainMovedBlockBbox(
  drag: DragState,
  requestedBbox: BBox,
  page: MangaPage,
): BBox {
  const delta = resolveSharedEditableBlockMoveDelta([drag.startBlock], page, {
    x: requestedBbox.x - drag.startBbox.x,
    y: requestedBbox.y - drag.startBbox.y,
  });
  return {
    ...drag.startBbox,
    x: drag.startBbox.x + delta.x,
    y: drag.startBbox.y + delta.y,
  };
}

export function applyResolvedBlockDrag(
  chapter: ChapterSnapshot,
  page: MangaPage,
  drag: DragState,
  resolution: BlockDragResolution,
): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((candidate) =>
      candidate.id === page.id
        ? applyResolutionToPage(candidate, page, drag, resolution)
        : candidate,
    ),
  };
}

export function resolveDragCursor(mode: DragMode): string {
  if (mode === "move") return "grabbing";
  if (mode === "rotate") {
    return `url("${rotateCursorUrl}") 12 12, crosshair`;
  }
  if (
    mode.startsWith("perspective-") ||
    mode.startsWith("curve-") ||
    mode.startsWith("warp-points-")
  ) {
    return "crosshair";
  }
  return RESIZE_CURSOR_BY_MODE[mode] ?? "nwse-resize";
}

const RESIZE_CURSOR_BY_MODE: Partial<Record<DragMode, string>> = {
  "resize-n": "ns-resize",
  "resize-s": "ns-resize",
  "resize-e": "ew-resize",
  "resize-w": "ew-resize",
  "resize-ne": "nesw-resize",
  "resize-sw": "nesw-resize",
  "resize-nw": "nwse-resize",
  "resize-se": "nwse-resize",
};

function resolveWarpDrag(
  drag: DragState,
  event: DragPointer,
  rect: PointerRect,
  page: MangaPage,
): BlockDragResolution | null {
  const start = drag.startBlock.warpTransform;
  if (!start) return null;
  const warpTransform = resolveDraggedWarpTransform(drag, event, start, rect);
  const indexes = warpPointIndexesFromMode(
    drag.mode,
    warpTransform.points.length,
  );
  if (!isValidWarpTransform(warpTransform)) {
    return {
      label: "",
      mode: drag.mode,
      invalid: true,
      invalidKind: "warp",
    };
  }
  if (!isWarpVisibleOnPage(drag.startBlock, warpTransform, page)) {
    return {
      label: "",
      mode: drag.mode,
      invalid: true,
      invalidKind: "outside",
    };
  }
  return {
    patch: { warpTransform },
    label: describeTransformPoint(
      averagePoints(indexes.map((index) => warpTransform.points[index])),
    ),
    mode: drag.mode,
  };
}

function resolvePerspectiveDrag(
  drag: DragState,
  event: DragPointer,
  rect: PointerRect,
  page: MangaPage,
): BlockDragResolution {
  const start = normalizePerspectiveTransform(
    drag.startBlock.perspectiveTransform,
  );
  const perspectiveTransform = resolveDraggedPerspective(
    drag,
    event,
    start,
    rect,
  );
  const point = resolvePerspectiveHudPoint(drag.mode, perspectiveTransform);
  if (!isValidPerspectiveTransform(perspectiveTransform)) {
    return {
      label: "",
      mode: drag.mode,
      invalid: true,
      invalidKind: "perspective",
    };
  }
  if (
    !isPerspectiveVisibleOnPage(drag.startBlock, perspectiveTransform, page)
  ) {
    return {
      label: "",
      mode: drag.mode,
      invalid: true,
      invalidKind: "outside",
    };
  }
  return {
    patch: { perspectiveTransform },
    label: describeTransformPoint(point),
    mode: drag.mode,
  };
}

function resolveCurveDrag(
  drag: DragState,
  event: DragPointer,
  rect: PointerRect,
): BlockDragResolution | null {
  if (!drag.startBlock.curveLayout) return null;
  const start = normalizeCurveLayout(drag.startBlock.curveLayout);
  const curveLayout = resolveDraggedCurveLayout(drag, event, start, rect);
  const point = resolveCurveHudPoint(drag.mode, curveLayout);
  return validateQuadraticPath(curveLayout.path).valid
    ? {
        patch: { curveLayout },
        label: describeTransformPoint(point),
        mode: drag.mode,
      }
    : {
        label: "",
        mode: drag.mode,
        invalid: true,
        invalidKind: "curve",
      };
}

function applyResolutionToPage(
  candidate: MangaPage,
  page: MangaPage,
  drag: DragState,
  resolution: BlockDragResolution,
): MangaPage {
  return {
    ...candidate,
    updatedAt: new Date().toISOString(),
    blocks: candidate.blocks.map((block) =>
      block.id === drag.blockId
        ? applyBlockDragResolution(block, page, resolution)
        : block,
    ),
  };
}

export function applyBlockDragResolution(
  block: TranslationBlock,
  page: MangaPage,
  resolution: BlockDragResolution,
): TranslationBlock {
  const patched = resolution.patch ? { ...block, ...resolution.patch } : block;
  if (!resolution.bbox) return patched;
  const pageSize = { width: page.width, height: page.height };
  const displayText = patched.translatedText || patched.sourceText || "...";
  return resolution.mode === "move"
    ? applyMovedEditableBlockBbox(
        patched,
        resolution.bbox,
        pageSize,
        displayText,
      )
    : applyEditableBlockBbox(patched, resolution.bbox, pageSize, displayText);
}

function resolvePerspectiveHudPoint(
  mode: DragMode,
  transform: NonNullable<TranslationBlock["perspectiveTransform"]>,
): { x: number; y: number } {
  const indexesByHandle: Record<string, number[]> = {
    tl: [0],
    top: [0, 1],
    tr: [1],
    right: [1, 2],
    br: [2],
    bottom: [2, 3],
    bl: [3],
    left: [3, 0],
  };
  const indexes = indexesByHandle[mode.slice(12)] ?? [0];
  return averagePoints(indexes.map((index) => transform.corners[index]));
}

function resolveCurveHudPoint(
  mode: DragMode,
  layout: NonNullable<TranslationBlock["curveLayout"]>,
): { x: number; y: number } {
  const key = mode.slice(6) as "start" | "control" | "end";
  return layout.path[key];
}

function averagePoints(points: Array<{ x: number; y: number }>): {
  x: number;
  y: number;
} {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}
