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
