import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BubbleDetectionMode } from "../../shared/inpaintingSettingsTypes";
import {
  buildLightweightBubbleMask,
  refinePreciseBubbleMask,
  type BubbleMaskDetectionResult,
} from "./bubbleMaskDetection";
import type { BubbleSegmentationEngine } from "./bubbleSegmentationEngine";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngine";
import type { InpaintingEngine } from "./inpaintingEngine";
import { hasUsableBbox } from "./maskGeometry";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import { resolvePatternInpaintWindows } from "./patternWindowPolicy";
import {
  buildPatternPageMask,
  type PatternMaskContext,
} from "./patternPageMask";
import type {
  ImageDecodeFallback,
  PatternPageInpaintingResult,
} from "./inpaintingTypes";

export async function inpaintPatternPage(
  page: MangaPage,
  options: {
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    inpaintingEngine?: InpaintingEngine;
    bubbleDetectionMode?: BubbleDetectionMode;
    bubbleSegmentationEngine?: BubbleSegmentationEngine;
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

  const bubbleDetection = await detectPageBubbles({
    bitmap,
    bubbleDetectionMode: options.bubbleDetectionMode ?? "auto",
    bubbleSegmentationEngine: options.bubbleSegmentationEngine,
    page,
    signal: options.signal,
  });
  const maskContext = buildPatternPageMask({
    page,
    bitmap,
    width: size.width,
    height: size.height,
    signal: options.signal,
    bubbleMask: bubbleDetection.mask,
  });
  if (maskContext.blocksErased === 0) {
    return { page, blocksErased: 0 };
  }
  await runPatternInpaintingEngine({
    bitmap,
    bubbleDetection,
    engine: options.inpaintingEngine,
    height: size.height,
    maskContext,
    signal: options.signal,
    width: size.width,
  });
  logPatternInpaintingResult(
    maskContext,
    bubbleDetection,
    options.inpaintingEngine,
    options.bubbleDetectionMode ?? "auto",
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

async function runPatternInpaintingEngine(options: {
  bitmap: Buffer;
  bubbleDetection: BubbleMaskDetectionResult;
  engine?: InpaintingEngine;
  height: number;
  maskContext: PatternMaskContext;
  signal?: AbortSignal;
  width: number;
}): Promise<void> {
  if (options.maskContext.inpaintWindows.length === 0) return;
  if (!options.engine) {
    throw new Error("원문 지우기 엔진이 준비되지 않았습니다.");
  }
  await options.engine.inpaint(
    options.bitmap,
    options.width,
    options.height,
    options.maskContext.pageMask,
    resolvePatternInpaintWindows(
      options.maskContext.inpaintWindows,
      options.engine,
    ),
    {
      signal: options.signal,
      featherPx: FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      bubbleMask:
        options.engine.model === "flux-klein"
          ? undefined
          : options.bubbleDetection.mask,
      windowMasks:
        options.engine.model === "flux-klein" &&
        options.engine.backend === "metal-native"
          ? options.maskContext.inpaintWindowMasks
          : undefined,
    },
  );
}

function logPatternInpaintingResult(
  mask: PatternMaskContext,
  bubbles: BubbleMaskDetectionResult,
  engine: InpaintingEngine | undefined,
  mode: BubbleDetectionMode,
): void {
  logInpaintingRuntimeInfo("Selected inpainting model processing completed", {
    model: engine?.model,
    blocks: mask.blocksErased,
    engineBlocks: mask.engineBlocks,
    otsuBlocks: mask.otsuBlocks,
    directFillBlocks: mask.directFillBlocks,
    bubbleDetectionMode: mode,
    bubbleRegions: bubbles.regions,
    bubbleMatchedBlocks: bubbles.matchedBlocks,
    bubbleSplitRegions: bubbles.splitRegions,
  });
}

async function detectPageBubbles(options: {
  bitmap: Buffer;
  bubbleDetectionMode: BubbleDetectionMode;
  bubbleSegmentationEngine?: BubbleSegmentationEngine;
  page: MangaPage;
  signal?: AbortSignal;
}): Promise<BubbleMaskDetectionResult> {
  if (
    options.bubbleDetectionMode === "precise" &&
    options.bubbleSegmentationEngine
  ) {
    const preciseMask = await options.bubbleSegmentationEngine.segment(
      options.bitmap,
      options.page.width,
      options.page.height,
      { signal: options.signal },
    );
    return refinePreciseBubbleMask(preciseMask, options.bitmap, options.page);
  }
  return buildLightweightBubbleMask(options.bitmap, options.page);
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
