import type {
  CodexPageReading,
  CodexPageRegion,
} from "../../shared/codexTypesettingTypes";
import type { BBox } from "../../shared/textTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { resolveTransformedBlockBounds } from "../../shared/editableRenderGeometry";
import type { TypesettingPageImage } from "./codexTypesettingContracts";
import { codexBackgroundSupportRect } from "../../shared/codexTypesettingBlend";

function intersects(a: BBox, b: BBox): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** Keep pixels are protected by masks; layout must also avoid their source area. */
export function preservedReadingConflicts(
  reading: CodexPageReading,
  page: MangaPage,
  blockId: (id: string) => string,
  preview: TypesettingPageImage[] = [],
) {
  const keep = reading.regions.filter((region) => region.action === "keep");
  return reading.regions
    .filter((region) => {
      if (region.action === "keep") return false;
      const painted = renderedRegionBounds(region, page, blockId, preview);
      return keep.some(
        (protectedRegion) =>
          painted !== null && intersects(painted, protectedRegion.sourceBbox),
      );
    })
    .map((region) => ({
      regionId: region.id,
      kind: "text" as const,
      reason:
        "번역 영역이 보존해야 할 원문 영역과 겹칩니다. 원문을 덮거나 지우지 않도록 배치하세요.",
    }));
}

/** Restoring source pixels must also retire any translation that overlaps them. */
export function failedRegionClosure(
  reading: CodexPageReading,
  page: MangaPage,
  failedIds: string[],
  blockId: (id: string) => string,
  preview: TypesettingPageImage[] = [],
  sourceOnly = false,
): string[] {
  const regions = reading.regions.filter((region) => region.action !== "keep");
  const failed = new Set(failedIds);
  if (failedIds.some((id) => !regions.some((region) => region.id === id))) {
    throw new Error("검수 결과가 존재하지 않는 영역을 참조했습니다.");
  }
  let changed = true;
  while (changed) {
    changed = false;
    const restored = regions.filter((region) => failed.has(region.id));
    for (const region of regions) {
      if (failed.has(region.id)) continue;
      const painted = sourceOnly
        ? null
        : renderedRegionBounds(region, page, blockId, preview);
      const overlaps = restored.some(
        (item) =>
          intersects(
            restorationBbox(item, page),
            restorationBbox(region, page),
          ) ||
          (painted !== null &&
            intersects(restorationBbox(item, page), painted)),
      );
      if (!overlaps) continue;
      failed.add(region.id);
      changed = true;
    }
  }
  return [...failed];
}

function restorationBbox(region: CodexPageRegion, page: MangaPage): BBox {
  if (region.background !== "artwork" || region.action === "keep")
    return region.sourceBbox;
  const rect = codexBackgroundSupportRect(region, page);
  return {
    x: (rect.x / page.width) * 1000,
    y: (rect.y / page.height) * 1000,
    w: (rect.w / page.width) * 1000,
    h: (rect.h / page.height) * 1000,
  };
}

function renderedRegionBounds(
  region: CodexPageRegion,
  page: MangaPage,
  blockId: (id: string) => string,
  preview: TypesettingPageImage[],
): BBox | null {
  const measured = preview
    .flatMap((image) => image.measurements ?? [])
    .find((item) => item.regionId === region.id)?.paintedBounds;
  if (measured !== undefined) return measured;
  const block = page.blocks.find((item) => item.id === blockId(region.id));
  const bbox = block?.renderBbox ?? region.renderBbox;
  if (!block) return bbox;
  // Transform in pixel space; normalized axes have unequal scales on non-square pages.
  const pixels = resolveTransformedBlockBounds(block, {
    x: (bbox.x / 1000) * page.width,
    y: (bbox.y / 1000) * page.height,
    w: (bbox.w / 1000) * page.width,
    h: (bbox.h / 1000) * page.height,
  });
  return {
    x: (pixels.x / page.width) * 1000,
    y: (pixels.y / page.height) * 1000,
    w: (pixels.w / page.width) * 1000,
    h: (pixels.h / page.height) * 1000,
  };
}

export function markFailedRegions(
  page: MangaPage,
  failedIds: string[],
  blockId: (id: string) => string,
  reason: string,
): MangaPage {
  const failed = new Set(failedIds.map(blockId));
  return {
    ...page,
    blocks: page.blocks.map((block) =>
      failed.has(block.id)
        ? {
            ...block,
            reviewStatus: "needs_review",
            reviewNote: [block.reviewNote, reason]
              .filter(Boolean)
              .join("\n")
              .slice(0, 4000),
          }
        : block,
    ),
  };
}
