import { PNG } from "pngjs";
import type { RegionEditProtection } from "../shared/regionEditProtectionTypes";
import type { CodexPageReading } from "../shared/codexTypesettingTypes";
import { normalizedRegionToPixelRect } from "../shared/region";

export function readingEditProtection(
  reading: CodexPageReading,
  page: { width: number; height: number },
  regionId?: string,
): Uint8Array | undefined {
  const protection = reading.editProtection;
  const scoped =
    regionId && protection?.regions
      ? protection.regions.find((entry) => entry.regionId === regionId)
      : protection;
  let mask = decodeRegionEditProtection(
    scoped ? { strokes: [], maskDataUrl: scoped.maskDataUrl } : undefined,
    page,
  );
  for (const region of reading.regions) {
    if (region.action !== "keep") continue;
    mask ??= new Uint8Array(page.width * page.height);
    const box = normalizedRegionToPixelRect(region.sourceBbox, page);
    for (let y = box.y; y < box.y + box.h; y++)
      mask.fill(255, y * page.width + box.x, y * page.width + box.x + box.w);
  }
  return mask;
}

/** The preview's white pixels permit edits; every partially covered edge is protected. */
export function decodeRegionEditProtection(
  protection: RegionEditProtection | undefined,
  page: { width: number; height: number },
): Uint8Array | undefined {
  if (!protection) return undefined;
  const bytes = Buffer.from(protection.maskDataUrl.split(",")[1], "base64");
  if (
    bytes.length < 24 ||
    bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) !== page.width ||
    bytes.readUInt32BE(20) !== page.height
  )
    throw new Error(
      "제외 영역의 이미지 크기가 다릅니다. 영역을 다시 확인해 주세요.",
    );
  const png = PNG.sync.read(bytes);
  const mask = new Uint8Array(page.width * page.height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 4;
    mask[pixel] =
      png.data[offset] < 255 ||
      png.data[offset + 1] < 255 ||
      png.data[offset + 2] < 255 ||
      png.data[offset + 3] !== 255
        ? 255
        : 0;
  }
  return mask;
}
