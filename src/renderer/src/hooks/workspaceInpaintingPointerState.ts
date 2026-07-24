import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { PointerRect } from "./workspacePointerGeometry";

export type ImagePoint = { x: number; y: number };
export type RetouchDrawTool = "brush" | "eraser" | "mask";

export function isRetouchDrawTool(
  tool: InpaintingTool,
): tool is RetouchDrawTool {
  return tool === "brush" || tool === "eraser" || tool === "mask";
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

function clampPixel(value: number, extent: number): number {
  return Math.max(0, Math.min(extent - 1, value));
}
