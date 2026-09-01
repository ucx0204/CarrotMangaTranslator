import type { MangaPage } from "../../../shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../../../shared/soundEffectReview";
import type { BBox } from "../../../shared/textTypes";

export type SoundEffectDraftRegion = SoundEffectReviewRegion & {
  originalBbox?: BBox;
  manual: boolean;
  newlyAdded: boolean;
  included: boolean;
  deleted: boolean;
};

export type SoundEffectDraftPage = {
  page: MangaPage;
  index: number;
  regions: SoundEffectDraftRegion[];
};

export type SelectedSoundEffectDraftRegion = {
  pageId: string;
  regionId: string;
} | null;

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const RESIZE_DIRECTIONS: ResizeDirection[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function updateAllDraftRegions(
  pages: SoundEffectDraftPage[],
  included: boolean,
): SoundEffectDraftPage[] {
  return pages.map((item) => ({
    ...item,
    regions: item.regions.map((region) =>
      region.deleted ? region : { ...region, included },
    ),
  }));
}

export function updateDraftPage(
  pages: SoundEffectDraftPage[],
  pageId: string,
  update: (regions: SoundEffectDraftRegion[]) => SoundEffectDraftRegion[],
): SoundEffectDraftPage[] {
  return pages.map((item) =>
    item.page.id === pageId ? { ...item, regions: update(item.regions) } : item,
  );
}

export function updateDraftRegion(
  pages: SoundEffectDraftPage[],
  pageId: string,
  regionId: string,
  update: (region: SoundEffectDraftRegion) => SoundEffectDraftRegion,
): SoundEffectDraftPage[] {
  return updateDraftPage(pages, pageId, (regions) =>
    regions.map((region) => (region.id === regionId ? update(region) : region)),
  );
}

export function resolvePagePoint(
  stage: HTMLElement | null,
  event: Pick<PointerEvent, "clientX" | "clientY">,
  visualSize: { width: number; height: number },
): { x: number; y: number } {
  const rect = stage?.getBoundingClientRect();
  const width = rect?.width || visualSize.width;
  const height = rect?.height || visualSize.height;
  return {
    x: clamp(((event.clientX - (rect?.left ?? 0)) / Math.max(1, width)) * 1000),
    y: clamp(((event.clientY - (rect?.top ?? 0)) / Math.max(1, height)) * 1000),
  };
}

export function moveBbox(bbox: BBox, dx: number, dy: number): BBox {
  return {
    ...bbox,
    x: clamp(bbox.x + dx, 0, 1000 - bbox.w),
    y: clamp(bbox.y + dy, 0, 1000 - bbox.h),
  };
}

export function resizeBbox(
  bbox: BBox,
  direction: ResizeDirection,
  dx: number,
  dy: number,
): BBox {
  let left = bbox.x;
  let top = bbox.y;
  let right = bbox.x + bbox.w;
  let bottom = bbox.y + bbox.h;
  if (direction.includes("w")) left = clamp(left + dx, 0, right - 2);
  if (direction.includes("e")) right = clamp(right + dx, left + 2, 1000);
  if (direction.includes("n")) top = clamp(top + dy, 0, bottom - 2);
  if (direction.includes("s")) bottom = clamp(bottom + dy, top + 2, 1000);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function normalizeDrawnBbox(
  start: { x: number; y: number },
  end: { x: number; y: number },
): BBox {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
}

export function bboxStyle(bbox: BBox): React.CSSProperties {
  return {
    left: `${bbox.x / 10}%`,
    top: `${bbox.y / 10}%`,
    width: `${bbox.w / 10}%`,
    height: `${bbox.h / 10}%`,
  };
}

function clamp(value: number, min = 0, max = 1000): number {
  return Math.min(max, Math.max(min, value));
}
