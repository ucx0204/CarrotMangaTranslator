import { resolveTransformedBlockBounds } from "../../../shared/editableRenderGeometry";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockRectPx } from "./overlayLayout";

export type WorkspaceZoomAnchorSpec =
  | { kind: "client"; point: { x: number; y: number } }
  | { kind: "selection"; pageX: number; pageY: number }
  | { kind: "viewport" };

export type PendingWorkspaceZoomAnchor = {
  imageXRatio: number;
  imageYRatio: number;
  pageId: string | null;
  target: "fixed" | "viewport-center";
  viewportX: number;
  viewportY: number;
};

export function resolveSelectedBlockCenter(
  page: MangaPage | null,
  selectedBlockId: string | null,
  selectedBlockIds: readonly string[],
): { x: number; y: number } | null {
  if (!page) return null;
  const requestedIds = new Set(selectedBlockIds);
  const selectedBlocks = page.blocks.filter((block) =>
    requestedIds.has(block.id),
  );
  const blocks =
    selectedBlocks.length > 0
      ? selectedBlocks
      : page.blocks.filter((block) => block.id === selectedBlockId);
  const bounds = blocks.map((block) => resolveZoomBlockBounds(block, page));
  const union = unionBboxes(bounds);
  return union ? { x: union.x + union.w / 2, y: union.y + union.h / 2 } : null;
}

function resolveZoomBlockBounds(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
): BBox {
  const text = block.translatedText || block.sourceText || "...";
  const rect = resolveBlockRectPx(block, page, NORMALIZED_STAGE_SIZE, text);
  return resolveTransformedBlockBounds(block, {
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height,
  });
}

const NORMALIZED_STAGE_SIZE = { width: 1000, height: 1000 } as const;

export function captureWorkspaceZoomAnchor({
  image,
  pageId,
  panel,
  spec,
}: {
  image: HTMLElement | null;
  pageId: string | null;
  panel: HTMLElement | null;
  spec: WorkspaceZoomAnchorSpec;
}): PendingWorkspaceZoomAnchor | null {
  if (!image || !panel) return null;
  const imageRect = image.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (imageRect.width <= 0 || imageRect.height <= 0) return null;
  const viewport = resolvePanelViewportSize(panel, panelRect);
  if (spec.kind === "selection") {
    const imageXRatio = spec.pageX / 1000;
    const imageYRatio = spec.pageY / 1000;
    return {
      imageXRatio,
      imageYRatio,
      pageId,
      target: "fixed",
      viewportX:
        imageRect.left + imageRect.width * imageXRatio - panelRect.left,
      viewportY: imageRect.top + imageRect.height * imageYRatio - panelRect.top,
    };
  }
  const point =
    spec.kind === "client"
      ? spec.point
      : {
          x: panelRect.left + viewport.width / 2,
          y: panelRect.top + viewport.height / 2,
        };
  return {
    imageXRatio: (point.x - imageRect.left) / imageRect.width,
    imageYRatio: (point.y - imageRect.top) / imageRect.height,
    pageId,
    target: spec.kind === "viewport" ? "viewport-center" : "fixed",
    viewportX: point.x - panelRect.left,
    viewportY: point.y - panelRect.top,
  };
}

export function restoreWorkspaceZoomAnchor({
  anchor,
  image,
  panel,
}: {
  anchor: PendingWorkspaceZoomAnchor;
  image: HTMLElement | null;
  panel: HTMLElement | null;
}): void {
  if (!image || !panel) return;
  const imageRect = image.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const viewport = resolvePanelViewportSize(panel, panelRect);
  const viewportX =
    anchor.target === "viewport-center" ? viewport.width / 2 : anchor.viewportX;
  const viewportY =
    anchor.target === "viewport-center"
      ? viewport.height / 2
      : anchor.viewportY;
  const currentX = imageRect.left + imageRect.width * anchor.imageXRatio;
  const currentY = imageRect.top + imageRect.height * anchor.imageYRatio;
  panel.scrollLeft += currentX - (panelRect.left + viewportX);
  panel.scrollTop += currentY - (panelRect.top + viewportY);
}

function resolvePanelViewportSize(
  panel: HTMLElement,
  rect: DOMRect,
): { width: number; height: number } {
  return {
    width: panel.clientWidth > 0 ? panel.clientWidth : rect.width,
    height: panel.clientHeight > 0 ? panel.clientHeight : rect.height,
  };
}

function unionBboxes(bounds: readonly BBox[]): BBox | null {
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map((bbox) => bbox.x));
  const top = Math.min(...bounds.map((bbox) => bbox.y));
  const right = Math.max(...bounds.map((bbox) => bbox.x + bbox.w));
  const bottom = Math.max(...bounds.map((bbox) => bbox.y + bbox.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
