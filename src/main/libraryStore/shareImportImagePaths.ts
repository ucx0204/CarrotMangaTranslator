import { join } from "node:path";
import type { ImageHeaderMetadata } from "./imageHeaderProbe";

export function resolveSharedPageOutputPath(
  pagesDir: string,
  sourceExt: string,
  format: ImageHeaderMetadata["format"],
  pageId: string,
  index: number,
): string {
  return join(
    pagesDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}${resolveStoredImageExt(
      sourceExt,
      format,
    )}`,
  );
}

export function resolveSharedInpaintedOutputPath(
  inpaintedDir: string,
  sourceExt: string,
  format: ImageHeaderMetadata["format"],
  pageId: string,
  index: number,
): string {
  return join(
    inpaintedDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}-inpainted${resolveStoredImageExt(
      sourceExt,
      format,
    )}`,
  );
}

function resolveStoredImageExt(
  sourceExt: string,
  format: ImageHeaderMetadata["format"],
): string {
  if (format === "png" || format === "webp") {
    return ".png";
  }
  return sourceExt === ".jpeg" ? ".jpeg" : ".jpg";
}
