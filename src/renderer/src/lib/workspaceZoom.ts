/**
 * Workspace zoom helpers. Zoom is applied as an explicit (layout-affecting)
 * image size — not a CSS transform — so overlay coordinates and pointer hit
 * testing keep matching the rendered image and the workspace can scroll.
 */

export const MIN_WORKSPACE_ZOOM = 0.5;
export const MAX_WORKSPACE_ZOOM = 4;
export const WORKSPACE_ZOOM_STEP = 0.25;

/** Matches the `.workspace` padding in styles.css. */
const WORKSPACE_PADDING_PX = 24;

export type WorkspaceFitMode = "contain" | "width" | "height" | "actual";

export function clampWorkspaceZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const stepped = Math.round(value / WORKSPACE_ZOOM_STEP) * WORKSPACE_ZOOM_STEP;
  return Math.min(
    MAX_WORKSPACE_ZOOM,
    Math.max(MIN_WORKSPACE_ZOOM, Number(stepped.toFixed(2))),
  );
}

export type PageAspect = { width: number; height: number };
export type ContainerSize = { width: number; height: number };
export type ImageDisplaySize = { width: number; height: number };

/**
 * Compute the explicit pixel size the page image should render at. The fit
 * mode establishes the 100% base and zoom scales from there. Explicit sizing
 * keeps the page image, overlays, and pointer geometry on the same coordinate
 * system while allowing small source images to fill the workspace.
 */
export function computeWorkspaceImageSize(
  zoom: number,
  fitMode: WorkspaceFitMode,
  page: PageAspect | null,
  container: ContainerSize | null,
): ImageDisplaySize | null {
  if (
    !page ||
    !container ||
    container.width <= 0 ||
    container.height <= 0 ||
    page.width <= 0 ||
    page.height <= 0
  ) {
    return null;
  }
  const availWidth = Math.max(1, container.width - WORKSPACE_PADDING_PX * 2);
  const availHeight = Math.max(1, container.height - WORKSPACE_PADDING_PX * 2);
  const widthScale = availWidth / page.width;
  const heightScale = availHeight / page.height;
  const fitScale = resolveFitScale(fitMode, widthScale, heightScale);
  const scale = fitScale * zoom;
  return {
    width: Math.max(1, Math.round(page.width * scale)),
    height: Math.max(1, Math.round(page.height * scale)),
  };
}

function resolveFitScale(
  fitMode: WorkspaceFitMode,
  widthScale: number,
  heightScale: number,
): number {
  switch (fitMode) {
    case "width":
      return widthScale;
    case "height":
      return heightScale;
    case "actual":
      return 1;
    default:
      return Math.min(widthScale, heightScale);
  }
}
