import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { MangaPage } from "../../shared/libraryTypes";
import type { RegionAnalysisRequest } from "../../shared/analysisTypes";
import type { PixelRect } from "../../shared/region";
import {
  loadImageForRegionCrop,
  type ImageDecodeFallback,
} from "../regionCrop";
import { inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { getAppPaths } from "../appPaths";
import { getAppSettings } from "../settingsStore";

export async function prepareRegionArtwork(input: {
  source: MangaPage;
  crop: MangaPage;
  analyzed: MangaPage;
  rect: PixelRect;
  request: RegionAnalysisRequest;
  directory: string;
  decode: ImageDecodeFallback;
  signal: AbortSignal;
}): Promise<string | undefined> {
  if (!input.request.eraseOriginal) return undefined;
  input.signal.throwIfAborted();
  const erased = input.request.codexTypesetting
    ? input.analyzed
    : await eraseRegionWithConfiguredEngine(
        input.analyzed,
        input.decode,
        input.signal,
      );
  if (!erased.inpaintedImagePath) {
    if (!erased.blocks.length) return undefined;
    throw new Error("선택 영역의 원문을 지우지 못했습니다.");
  }
  const original = PNG.sync.read(
    (
      await loadImageForRegionCrop(
        input.crop.imagePath,
        input.decode,
        input.signal,
      )
    ).toPNG(),
  );
  const patch = PNG.sync.read(
    (
      await loadImageForRegionCrop(
        erased.inpaintedImagePath,
        input.decode,
        input.signal,
      )
    ).toPNG(),
  );
  const current = await loadImageForRegionCrop(
    input.source.inpaintedImagePath ?? input.source.imagePath,
    input.decode,
    input.signal,
  );
  const background = PNG.sync.read(current.toPNG());
  mergeRegionArtwork(background, original, patch, input.rect);
  input.signal.throwIfAborted();
  const path = join(
    input.directory,
    `region-background-${input.source.id}-${randomUUID()}.png`,
  );
  await writeFile(path, PNG.sync.write(background), { signal: input.signal });
  return path;
}

export function mergeRegionArtwork(
  background: PNG,
  original: PNG,
  patch: PNG,
  rect: PixelRect,
): void {
  if (
    original.width !== patch.width ||
    original.height !== patch.height ||
    patch.width !== rect.w ||
    patch.height !== rect.h
  )
    throw new Error("원문 제거 이미지의 크기가 선택 영역과 다릅니다.");
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > background.width ||
    rect.y + rect.h > background.height
  )
    throw new Error("선택 영역이 페이지 밖입니다.");
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const source = (y * rect.w + x) * 4;
      if (
        original.data
          .subarray(source, source + 4)
          .equals(patch.data.subarray(source, source + 4))
      )
        continue;
      const target = ((y + rect.y) * background.width + x + rect.x) * 4;
      patch.data.copy(background.data, target, source, source + 4);
    }
  }
}

async function eraseRegionWithConfiguredEngine(
  page: MangaPage,
  decodeFallback: ImageDecodeFallback,
  signal: AbortSignal,
) {
  const appPaths = getAppPaths();
  const settings = await getAppSettings(appPaths);
  const lease = await acquireInpaintingEngine({
    appPaths,
    model: settings.inpainting?.model ?? "flux-klein",
    fluxBackend: settings.inpainting?.fluxBackend,
    koharuBackend: settings.inpainting?.koharuBackend,
    computeGpuIndex: settings.hardware?.computeGpuIndex,
    allowUnsafeLowMemoryFlux:
      settings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    signal,
  });
  try {
    const result = await inpaintPatternPage(page, {
      blockIds: page.blocks.map((block) => block.id),
      signal,
      decodeFallback,
      inpaintingEngine: lease.engine,
      preserveExistingInpainting: true,
    });
    if (page.blocks.some((block) => !result.erasedBlockIds?.includes(block.id)))
      throw new Error("일부 원문을 지우지 못했습니다.");
    return result.page;
  } finally {
    await lease.release();
  }
}
