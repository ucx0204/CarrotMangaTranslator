import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import { bboxOverlapRatio } from "../../shared/geometry";
import {
  normalizedRegionToPixelRect,
  type PageSize,
} from "../../shared/region";
import type { TypesettingPageImage } from "./codexTypesettingContracts";

export function partitionCodexReading(
  reading: CodexPageReading,
  limit: number,
): CodexPageReading[] {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid typesetting batch size.");
  const active = reading.regions.filter((region) => region.action !== "keep");
  const batches: CodexPageReading[] = [];
  for (let offset = 0; offset < active.length; offset += limit) {
    const ids = new Set(
      active.slice(offset, offset + limit).map((item) => item.id),
    );
    batches.push({
      ...reading,
      regions: reading.regions.filter(
        (region) => region.action === "keep" || ids.has(region.id),
      ),
    });
  }
  return batches;
}

export function codexBatchStage(
  stage: string,
  index: number,
  count: number,
): string {
  return count === 1 ? stage : `${stage}-batch-${index + 1}`;
}

export function codexBatchImages(
  images: TypesettingPageImage[],
  reading: CodexPageReading,
): TypesettingPageImage[] {
  const ids = new Set(reading.regions.map((region) => region.id));
  return images.map((image) =>
    image.measurements === undefined
      ? image
      : {
          ...image,
          label:
            image.label +
            "; actual production text layout for requested regions: " +
            JSON.stringify(
              image.measurements.filter((measurement) =>
                ids.has(measurement.regionId),
              ),
            ),
        },
  );
}

/** Every native view is inspected, including gaps with no detected lettering. */
export function assignCodexBatchViews(
  page: PageSize,
  batches: CodexPageReading[],
  images: TypesettingPageImage[],
): TypesettingPageImage[][] {
  if (!batches.length || !images.length)
    throw new Error("Batch inspection requires regions and native views.");
  const boxes = batches.map((batch) =>
    batch.regions
      .filter((region) => region.action !== "keep")
      .flatMap((region) => [region.sourceBbox, region.renderBbox])
      .map((box) => normalizedRegionToPixelRect(box, page, 1)),
  );
  const assigned: TypesettingPageImage[][] = batches.map(() => []);
  for (const image of images) {
    const bounds = image.view.bounds;
    const matches = boxes.flatMap((group, index) =>
      group.some((box) => bboxOverlapRatio(box, bounds) > 0) ? [index] : [],
    );
    if (!matches.length) {
      const distances = boxes.map((group) =>
        Math.min(
          ...group.map((box) =>
            Math.hypot(
              box.x + box.w / 2 - bounds.x - bounds.w / 2,
              box.y + box.h / 2 - bounds.y - bounds.h / 2,
            ),
          ),
        ),
      );
      matches.push(distances.indexOf(Math.min(...distances)));
    }
    for (const index of matches) assigned[index].push(image);
  }
  if (assigned.some((batch) => !batch.length))
    throw new Error("Native views do not cover every typesetting batch.");
  return assigned;
}
