import { regionReviewSelectionSvg } from "./regionReviewSelection";
import type { BBox } from "../../../shared/textTypes";
import type { LetteringMaskStroke } from "../../../shared/generatedLetteringMaskTypes";
import type { RegionEditProtection } from "../../../shared/regionEditProtectionTypes";

/** Use the browser's existing lettering-mask rasterization for both stages. */
export async function prepareRegionReviewProtection(
  strokes: LetteringMaskStroke[],
  size: { w: number; h: number },
  regions: Array<{
    regionId?: string;
    sourceBbox: BBox;
    selectionStrokes?: LetteringMaskStroke[];
    exclusionStrokes?: LetteringMaskStroke[];
  }> = [],
): Promise<RegionEditProtection | undefined> {
  if (
    !strokes.length &&
    !regions.some(
      (region) =>
        region.selectionStrokes?.length || region.exclusionStrokes?.length,
    )
  )
    return undefined;
  const maskDataUrl = await rasterizeReviewMask(
    regionReviewSelectionSvg(regions, strokes),
    size,
  );
  const scoped: NonNullable<RegionEditProtection["regions"]> = [];
  for (const region of regions) {
    if (
      region.regionId &&
      (region.selectionStrokes?.length || region.exclusionStrokes?.length)
    )
      scoped.push({
        regionId: region.regionId,
        maskDataUrl: await rasterizeReviewMask(
          regionReviewSelectionSvg([region], []),
          size,
        ),
      });
  }
  return {
    strokes,
    maskDataUrl,
    ...(regions.length ? { regions: scoped } : {}),
  };
}

async function rasterizeReviewMask(
  svg: string,
  size: { w: number; h: number },
): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml,${encodeURIComponent(svg.replace("<svg ", `<svg width="${size.w}" height="${size.h}" `))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("제외 영역을 만들지 못했습니다.");
  context.drawImage(image, 0, 0, size.w, size.h);
  return canvas.toDataURL("image/png");
}
