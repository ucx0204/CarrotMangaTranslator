/**
 * Workspace zoom helpers. Zoom is applied as an explicit (layout-affecting)
 * image size — not a CSS transform — so overlay coordinates and pointer hit
 * testing keep matching the rendered image and the workspace can scroll.
 */

export const MIN_WORKSPACE_ZOOM = 0.5;
export const MAX_WORKSPACE_ZOOM = 4;
export const WORKSPACE_ZOOM_STEP = 0.25;

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
export type WorkspaceOverscroll = { x: number; y: number };
export type WorkspaceScrollOrigin = { x: number; y: number };

/**
 * Give every page enough pasteboard to move an edge to the viewport centre.
 * This follows the viewport instead of reserving an arbitrary fixed gutter.
 */
export function computeWorkspaceOverscroll(
  container: ContainerSize,
): WorkspaceOverscroll {
  return {
    x: Math.max(0, Math.round(container.width / 2)),
    y: Math.max(0, Math.round(container.height / 2)),
  };
}

/** Centre fitted page pixels while retaining pasteboard before every edge. */
export function computeWorkspaceScrollOrigin(
  container: ContainerSize,
  image: ImageDisplaySize,
  overscroll: WorkspaceOverscroll,
): WorkspaceScrollOrigin {
  return {
    x: Math.max(
      0,
      Math.round(overscroll.x - Math.max(0, container.width - image.width) / 2),
    ),
    y: Math.max(
      0,
      Math.round(
        overscroll.y - Math.max(0, container.height - image.height) / 2,
      ),
    ),
  };
}

/** Native bars describe clipped page pixels, not invisible pasteboard space. */
export function doesWorkspacePageFit(
  image: ImageDisplaySize,
  container: ContainerSize,
): boolean {
  return image.width <= container.width && image.height <= container.height;
}

/**
 * Compute the explicit pixel size the page image should render at. The fit
 * mode establishes the zoom base and zoom scales from there. The pasteboard is
 * scrollable space outside the page and must not make a fitted page smaller.
 * Explicit sizing keeps the page image, overlays, and pointer geometry on the
 * same coordinate system while allowing small source images to fill the
 * workspace.
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
  const availWidth = Math.max(1, container.width);
  const availHeight = Math.max(1, container.height);
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
