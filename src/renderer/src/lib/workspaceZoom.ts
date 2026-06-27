/**
 * Workspace zoom helpers. Zoom is applied as an explicit (layout-affecting)
 * image size — not a CSS transform — so overlay coordinates and pointer hit
 * testing keep matching the rendered image and the workspace can scroll.
 */

export const MIN_WORKSPACE_ZOOM = 0.5;
export const MAX_WORKSPACE_ZOOM = 4;
export const WORKSPACE_ZOOM_STEP = 0.25;

/** Matches the `.workspace` padding and `.page-image` max-width in styles.css. */
const WORKSPACE_PADDING_PX = 24;
const BASE_MAX_IMAGE_WIDTH_PX = 1040;

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
 * Compute the explicit pixel size the page image should render at for a given
 * zoom. Returns null at zoom 1 (or without measurements) so the default CSS
 * fit is used and behavior is unchanged.
 */
export function computeWorkspaceImageSize(
  zoom: number,
  page: PageAspect | null,
  container: ContainerSize | null,
): ImageDisplaySize | null {
  if (
    zoom === 1 ||
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
  const aspect = page.width / page.height;
  let fitWidth = Math.min(availWidth, BASE_MAX_IMAGE_WIDTH_PX);
  let fitHeight = fitWidth / aspect;
  if (fitHeight > availHeight) {
    fitHeight = availHeight;
    fitWidth = fitHeight * aspect;
  }
  return {
    width: Math.round(fitWidth * zoom),
    height: Math.round(fitHeight * zoom),
  };
}
