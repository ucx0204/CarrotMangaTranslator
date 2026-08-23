import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { PointerRect } from "./workspacePointerGeometry";

export type ImagePoint = { x: number; y: number };
export type RetouchDrawTool = "brush" | "eraser" | "mask";
export type RetouchShapeTool = "rectangle" | "ellipse" | "eraser-rectangle";

export function isRetouchDrawTool(
  tool: InpaintingTool,
): tool is RetouchDrawTool {
  return tool === "brush" || tool === "eraser" || tool === "mask";
}

export function isRetouchShapeTool(
  tool: InpaintingTool,
): tool is RetouchShapeTool {
  return (
    tool === "rectangle" || tool === "ellipse" || tool === "eraser-rectangle"
  );
}

export function resolveImagePixelPoint(
  point: { clientX: number; clientY: number },
  rect: PointerRect,
  page: Pick<MangaPage, "width" | "height">,
): ImagePoint | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: clampPixel(
      ((point.clientX - rect.left) / rect.width) * page.width,
      page.width,
    ),
    y: clampPixel(
      ((point.clientY - rect.top) / rect.height) * page.height,
      page.height,
    ),
  };
}

export function appendMaskStroke(
  current: Record<string, InpaintingMaskStroke[]>,
  pageId: string,
  points: ImagePoint[],
  radiusPx: number,
): Record<string, InpaintingMaskStroke[]> {
  return {
    ...current,
    [pageId]: [...(current[pageId] ?? []), { points, radiusPx }].slice(-200),
  };
}

export function adjustMaskStrokeRadii(
  strokes: readonly InpaintingMaskStroke[],
  deltaPx: number,
): InpaintingMaskStroke[] {
  if (!Number.isFinite(deltaPx) || deltaPx === 0) return [...strokes];
  return strokes
    .map((stroke) => ({
      ...stroke,
      radiusPx: Math.max(0, stroke.radiusPx + deltaPx),
    }))
    .filter((stroke) => stroke.radiusPx > 0);
}

export function constrainStrokeToLine(
  points: readonly ImagePoint[],
): ImagePoint[] {
  if (points.length <= 2) return [...points];
  const first = points[0];
  const last = points.at(-1);
  return first && last ? [first, last] : [];
}

export function resolveDraggedBrushRadius(
  initialRadius: number,
  horizontalDelta: number,
  minRadius = 4,
  maxRadius = 90,
): number {
  const radius = Math.round(initialRadius + horizontalDelta / 2);
  return Math.max(minRadius, Math.min(maxRadius, radius));
}

function clampPixel(value: number, extent: number): number {
  return Math.max(0, Math.min(extent - 1, value));
}
