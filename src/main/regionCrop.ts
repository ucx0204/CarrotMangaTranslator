import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { BBox, MangaPage, TranslationBlock } from "../shared/types";
import { isUsableRegionBbox, mapCropNormalizedBboxToPageBbox, normalizedRegionToPixelRect, type PixelRect } from "../shared/region";
import { logInfo } from "./logger";

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;

export async function createRegionCropPage(
  page: MangaPage,
  bbox: BBox,
  jobId: string,
  runDir: string,
  decodeFallback: ImageDecodeFallback
): Promise<{
  cropPage: MangaPage;
  cropRect: PixelRect;
}> {
  if (!isUsableRegionBbox(bbox)) {
    throw new Error("번역할 영역이 너무 작습니다.");
  }

  const source = await loadImageForRegionCrop(page.imagePath, decodeFallback);

  const cropRect = normalizedRegionToPixelRect(bbox, { width: page.width, height: page.height }, 8);
  const crop = source.crop({
    x: cropRect.x,
    y: cropRect.y,
    width: cropRect.w,
    height: cropRect.h
  });
  if (crop.isEmpty()) {
    throw new Error("선택 영역 이미지를 만들지 못했습니다.");
  }

  const cropDir = join(runDir, "region-crops");
  await mkdir(cropDir, { recursive: true });
  const cropPath = join(cropDir, `${page.id}-${jobId}.png`);
  await writeFile(cropPath, crop.toPNG());

  return {
    cropRect,
    cropPage: {
      ...page,
      id: `${page.id}-region-${jobId}`,
      name: `${page.name} 선택 영역`,
      imagePath: cropPath,
      dataUrl: "",
      width: cropRect.w,
      height: cropRect.h,
      blocks: [],
      analysisStatus: "idle",
      lastError: undefined
    }
  };
}

export function mapRegionBlocksToPageBlocks(blocks: TranslationBlock[], page: MangaPage, cropRect: PixelRect): TranslationBlock[] {
  const pageSize = { width: page.width, height: page.height };
  return blocks.map((block) => {
    const id = `${page.id}-region-block-${randomUUID()}`;
    return {
      ...block,
      id,
      bbox: mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.bbox),
      renderBbox: block.renderBbox ? mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.renderBbox) : undefined,
      bboxSpace: "normalized_1000",
      renderBboxSpace: block.renderBbox ? "normalized_1000" : undefined
    };
  });
}

async function loadImageForRegionCrop(imagePath: string, decodeFallback: ImageDecodeFallback): Promise<Electron.NativeImage> {
  if (extname(imagePath).toLowerCase() === ".webp") {
    const pngBuffer = await decodeFallback(imagePath);
    if (pngBuffer) {
      const converted = nativeImage.createFromBuffer(pngBuffer);
      if (!converted.isEmpty()) {
        logInfo("Region crop decoded webp through png conversion", { imagePath });
        return converted;
      }
    }
    throw new Error("WEBP 이미지를 PNG로 변환하지 못했습니다.");
  }

  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  throw new Error("선택한 페이지 이미지를 읽지 못했습니다.");
}
