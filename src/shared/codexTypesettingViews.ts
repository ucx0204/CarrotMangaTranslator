import type { PixelRect } from "./region";
import type { CodexPageRegion } from "./codexTypesettingTypes";

export type CodexPageView = { bounds: PixelRect; ownership: PixelRect };

/** Native views overlap for context; their ownership rectangles partition the page. */
export function createCodexPageViews(page: {
  width: number;
  height: number;
}): CodexPageView[] {
  if (
    ![page.width, page.height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 100000,
    )
  )
    throw new Error("Invalid native page dimensions.");
  return axisViews(page.height).flatMap((y) =>
    axisViews(page.width).map((x) => ({
      bounds: { x: x.start, y: y.start, w: x.length, h: y.length },
      ownership: { x: x.core, y: y.core, w: x.coreLength, h: y.coreLength },
    })),
  );
}

function axisViews(length: number) {
  if (length <= 2048)
    return [{ start: 0, length, core: 0, coreLength: length }];
  const views = [];
  for (let core = 0; core < length; core += 1536) {
    const coreLength = Math.min(1536, length - core);
    const start = Math.max(0, core - 256);
    views.push({
      core,
      coreLength,
      start,
      length: Math.min(length, core + coreLength + 256) - start,
    });
  }
  return views;
}

export function rebaseCodexViewRegion(
  region: CodexPageRegion,
  view: CodexPageView,
  page: { width: number; height: number },
): CodexPageRegion | null {
  const { bounds, ownership } = view;
  const x =
    bounds.x +
    ((region.sourceBbox.x + region.sourceBbox.w / 2) * bounds.w) / 1000;
  const y =
    bounds.y +
    ((region.sourceBbox.y + region.sourceBbox.h / 2) * bounds.h) / 1000;
  if (
    x < ownership.x ||
    x >= ownership.x + ownership.w ||
    y < ownership.y ||
    y >= ownership.y + ownership.h
  )
    return null;
  const rebase = (box: CodexPageRegion["sourceBbox"]) => ({
    x: ((bounds.x + (box.x * bounds.w) / 1000) * 1000) / page.width,
    y: ((bounds.y + (box.y * bounds.h) / 1000) * 1000) / page.height,
    w: (box.w * bounds.w) / page.width,
    h: (box.h * bounds.h) / page.height,
  });
  return {
    ...region,
    ...(region.occlusionPolygons
      ? {
          occlusionPolygons: region.occlusionPolygons.map((polygon) =>
            polygon.map((point) => ({
              x: ((bounds.x + (point.x * bounds.w) / 1000) * 1000) / page.width,
              y:
                ((bounds.y + (point.y * bounds.h) / 1000) * 1000) / page.height,
            })),
          ),
        }
      : {}),
    sourceBbox: rebase(region.sourceBbox),
    renderBbox: rebase(region.renderBbox),
  };
}
