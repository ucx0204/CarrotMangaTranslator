import {
  isValidPerspectiveTransform,
  normalizeCurveLayout,
  normalizePerspectiveTransform,
  validateQuadraticPath,
} from "../../../shared/blockTransforms";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { applyEditableBlockBbox } from "../lib/blockFormatGeometry";
import { isPerspectiveVisibleOnPage } from "../lib/transformEditorModel";
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

export type BlockDragResolution = {
  bbox?: BBox;
  patch?: Partial<TranslationBlock>;
  label: string;
  invalid?: boolean;
  invalidKind?: "perspective" | "curve" | "outside";
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
    const bbox = resolveDraggedBbox(drag, event, rect, page);
    return { bbox, label: describeDragBbox(drag.mode, bbox, page) };
  }
  if (drag.mode === "rotate") {
    const result = resolveDraggedRotationWithSnap(drag, event, rect);
    return {
      patch: { rotationDeg: result.rotationDeg },
      label: `${result.rotationDeg}°`,
      snapped: result.snapped,
    };
  }
  if (drag.mode.startsWith("perspective-")) {
    return resolvePerspectiveDrag(drag, event, rect, page);
  }
  if (drag.mode.startsWith("curve-")) {
    return resolveCurveDrag(drag, event, rect);
  }
  return null;
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
  if (mode === "move" || mode === "rotate") return "grabbing";
  if (mode.startsWith("perspective-") || mode.startsWith("curve-")) {
    return "crosshair";
  }
  return "nwse-resize";
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
    return { label: "", invalid: true, invalidKind: "perspective" };
  }
  if (
    !isPerspectiveVisibleOnPage(drag.startBlock, perspectiveTransform, page)
  ) {
    return { label: "", invalid: true, invalidKind: "outside" };
  }
  return {
    patch: { perspectiveTransform },
    label: describeTransformPoint(point),
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
    ? { patch: { curveLayout }, label: describeTransformPoint(point) }
    : { label: "", invalid: true, invalidKind: "curve" };
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
  return resolution.bbox
    ? applyEditableBlockBbox(
        patched,
        resolution.bbox,
        { width: page.width, height: page.height },
        block.translatedText || block.sourceText || "...",
      )
    : patched;
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
