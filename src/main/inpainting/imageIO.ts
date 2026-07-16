import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ImageDecodeFallback } from "./inpaintingTypes";

const INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH = 16;

export async function loadPageImage(
  filePath: string,
  decodeFallback?: ImageDecodeFallback,
): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(filePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const fallbackBuffer = decodeFallback ? await decodeFallback(filePath) : null;
  if (fallbackBuffer?.length) {
    const fallback = nativeImage.createFromBuffer(fallbackBuffer);
    if (!fallback.isEmpty()) {
      return fallback;
    }
  }

  throw new Error("인페인팅할 이미지를 읽지 못했습니다.");
}

export function resolveInpaintedImagePath(
  imagePath: string,
  suffix = "pattern",
): string {
  const imageDir = dirname(imagePath);
  const chapterDir = dirname(imageDir);
  const safeSuffix =
    suffix
      .replace(/[^a-z0-9_-]/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH) || "image";
  return join(chapterDir, "inpainted", `${safeSuffix}-${randomUUID()}.png`);
}
