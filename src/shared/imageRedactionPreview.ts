import { z } from "zod";

export const redactionPreviewRegionSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
  })
  .strict();
export type RedactionPreviewRegion = z.infer<
  typeof redactionPreviewRegionSchema
>;

/** Overview and native crops must never share a cache entry. */
export function redactionPreviewVariantKey(
  maxEdge: number,
  region?: RedactionPreviewRegion,
): string {
  return region
    ? `${maxEdge}:native:${region.x}:${region.y}:${region.width}:${region.height}`
    : `${maxEdge}:overview`;
}

export function assertRedactionPreviewRegion(
  region: RedactionPreviewRegion | undefined,
  source: { width: number; height: number },
): void {
  if (
    region &&
    (region.x + region.width > source.width ||
      region.y + region.height > source.height)
  )
    throw new Error("The requested preview region is outside the source image");
}
