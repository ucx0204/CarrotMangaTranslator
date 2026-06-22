import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MangaPage } from "../../shared/types";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  type FluxInpaintingEngine,
} from "./fluxEngine";
import {
  bboxToPixelRect,
  expandRect,
  hasUsableBbox,
  mergeFilledRectIntoPage,
  mergeMaskIntoPage,
  mergeRects,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  type PixelRect,
} from "./maskGeometry";
import { buildPatternTextMask } from "./patternTextMask";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import type {
  ImageDecodeFallback,
  PatternPageInpaintingResult,
} from "./inpaintingTypes";

export async function inpaintPatternPage(
  page: MangaPage,
  options: {
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    fluxEngine?: FluxInpaintingEngine;
  } = {},
): Promise<PatternPageInpaintingResult> {
  const patternBlocks = page.blocks.filter(
    (block) => hasUsableBbox(block.bbox) && !block.inpaintExcluded,
  );
  if (patternBlocks.length === 0) {
    return { page, blocksErased: 0 };
  }

  const image = await loadPageImage(
    page.inpaintedImagePath ?? page.imagePath,
    options.decodeFallback,
  );
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }

  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }

  const maskContext = buildPatternPageMask({
    page,
    bitmap,
    width: size.width,
    height: size.height,
    signal: options.signal,
  });
  if (maskContext.blocksErased === 0) {
    return { page, blocksErased: 0 };
  }

  if (!options.fluxEngine) {
    throw new Error("Flux 원문 지우기 엔진이 준비되지 않았습니다.");
  }

  await options.fluxEngine.inpaint(
    bitmap,
    size.width,
    size.height,
    maskContext.pageMask,
    mergeRects(maskContext.inpaintWindows),
    {
      signal: options.signal,
      featherPx: FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
    },
  );

  const outputPath = await writePatternInpaintedImage(page, bitmap, size);
  return {
    blocksErased: maskContext.blocksErased,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString(),
    },
  };
}

function buildPatternPageMask({
  page,
  bitmap,
  width,
  height,
  signal,
}: {
  page: MangaPage;
  bitmap: Buffer;
  width: number;
  height: number;
  signal?: AbortSignal;
}): {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  blocksErased: number;
} {
  const pageMask = new Uint8Array(width * height);
  const inpaintWindows: PixelRect[] = [];
  let blocksErased = 0;

  for (const block of page.blocks) {
    if (!hasUsableBbox(block.bbox) || block.inpaintExcluded) {
      continue;
    }
    throwIfAborted(signal);
    const sourceRect = bboxToPixelRect(block.bbox, page);
    const supportRect = expandRect(
      sourceRect,
      width,
      height,
      resolvePatternRegionPaddingPx(block, page),
    );
    mergePatternDetectionMask({
      page,
      block,
      bitmap,
      width,
      height,
      sourceRect,
      supportRect,
      pageMask,
    });
    inpaintWindows.push(
      expandRect(
        supportRect,
        width,
        height,
        resolvePatternWindowMarginPx(block, page),
      ),
    );
    blocksErased += 1;
  }

  return { pageMask, inpaintWindows, blocksErased };
}

function mergePatternDetectionMask({
  page,
  block,
  bitmap,
  width,
  height,
  sourceRect,
  supportRect,
  pageMask,
}: {
  page: MangaPage;
  block: MangaPage["blocks"][number];
  bitmap: Buffer;
  width: number;
  height: number;
  sourceRect: PixelRect;
  supportRect: PixelRect;
  pageMask: Uint8Array;
}): void {
  const detectRect = expandRect(
    sourceRect,
    width,
    height,
    resolvePatternBlockMarginPx(block, page),
  );
  const detectedMask = buildPatternTextMask(
    bitmap,
    width,
    height,
    detectRect,
    resolvePatternDilationRadius(block),
  );

  mergeFilledRectIntoPage(pageMask, width, supportRect);
  if (detectedMask.count > 0) {
    mergeMaskIntoPage(pageMask, width, detectRect, detectedMask.mask);
  }
}

async function writePatternInpaintedImage(
  page: MangaPage,
  bitmap: Buffer,
  size: { width: number; height: number },
): Promise<string> {
  const outputImage = nativeImage.createFromBitmap(bitmap, size);
  if (outputImage.isEmpty()) {
    throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());
  return outputPath;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
