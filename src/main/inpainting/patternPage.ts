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
import { applyBubbleRenderLayouts } from "./bubbleRenderLayout";
import type { BubbleQualityRefiner } from "./bubbleQualityRefiner";
import {
  findBubbleRecoveryHints,
  mergeRecoveredBubbleMask,
} from "./bubbleQualityRecovery";
import type { InpaintingEngine } from "./inpaintingEngine";
import { hasUsableBbox } from "./maskGeometry";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import {
  resolveInpaintingBackendPolicy,
  resolvePatternInpaintWindows,
} from "./patternWindowPolicy";
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
    bubbleQualityRefiner?: BubbleQualityRefiner;
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
    bubbleQualityRefiner: options.bubbleQualityRefiner,
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
  const renderLayout = applyBubbleRenderLayouts(page, bubbleDetection.mask);
  if (renderLayout.expandedBlocks > 0) {
    logInpaintingRuntimeInfo("Bubble-aware render layouts applied", {
      page: page.name,
      expandedBlocks: renderLayout.expandedBlocks,
    });
  }

  const outputPath = await writePatternInpaintedImage(page, bitmap, size);
  return buildInpaintedPageResult(
    page,
    renderLayout.blocks,
    outputPath,
    maskContext.blocksErased,
  );
}

function buildInpaintedPageResult(
  page: MangaPage,
  blocks: MangaPage["blocks"],
  outputPath: string,
  blocksErased: number,
): PatternPageInpaintingResult {
  return {
    blocksErased,
    page: {
      ...page,
      blocks,
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
  const policy = resolveInpaintingBackendPolicy(options.engine);
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
      featherPx: policy.featherPx,
      contextPx: policy.contextPx,
      maskPaddingPx: policy.maskPaddingPx,
      maxPixels: policy.maxPixels,
      bubbleMask:
        policy.bubbleMaskStrategy === "omit"
          ? undefined
          : options.bubbleDetection.mask,
      windowMasks: options.maskContext.inpaintWindowMasks,
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
    backend: engine?.backend,
    blocks: mask.blocksErased,
    windows: mask.inpaintWindows.length,
    engineBlocks: mask.engineBlocks,
    otsuBlocks: mask.otsuBlocks,
    directFillBlocks: mask.directFillBlocks,
    lightweightFillBlocks: mask.lightweightFillBlocks,
    directFillRatio:
      mask.blocksErased > 0
        ? Number((mask.directFillBlocks / mask.blocksErased).toFixed(4))
        : 0,
    lightweightFillRatio:
      mask.blocksErased > 0
        ? Number((mask.lightweightFillBlocks / mask.blocksErased).toFixed(4))
        : 0,
    generationFreeRatio:
      mask.blocksErased > 0
        ? Number(
            (
              (mask.directFillBlocks + mask.lightweightFillBlocks) /
              mask.blocksErased
            ).toFixed(4),
          )
        : 0,
    bubbleDetectionMode: mode,
    bubbleRegions: bubbles.regions,
    bubbleMatchedBlocks: bubbles.matchedBlocks,
    bubbleSplitRegions: bubbles.splitRegions,
    bubbleRecoveryCandidates: bubbles.recoveryCandidates ?? 0,
    bubbleRecoveredBlocks: bubbles.recoveredBlocks ?? 0,
  });
}

async function detectPageBubbles(options: {
  bitmap: Buffer;
  bubbleDetectionMode: BubbleDetectionMode;
  bubbleQualityRefiner?: BubbleQualityRefiner;
  bubbleSegmentationEngine?: BubbleSegmentationEngine;
  page: MangaPage;
  signal?: AbortSignal;
}): Promise<BubbleMaskDetectionResult> {
  if (
    options.bubbleDetectionMode !== "auto" &&
    options.bubbleSegmentationEngine
  ) {
    const preciseMask = await options.bubbleSegmentationEngine.segment(
      options.bitmap,
      options.page.width,
      options.page.height,
      { signal: options.signal },
    );
    const precise = refinePreciseBubbleMask(
      preciseMask,
      options.bitmap,
      options.page,
    );
    if (
      options.bubbleDetectionMode === "precise" ||
      !options.bubbleQualityRefiner
    ) {
      return precise;
    }
    return recoverWeakBubbleMasks(options, precise);
  }
  return buildLightweightBubbleMask(options.bitmap, options.page);
}

async function recoverWeakBubbleMasks(
  options: {
    bitmap: Buffer;
    bubbleQualityRefiner?: BubbleQualityRefiner;
    page: MangaPage;
    signal?: AbortSignal;
  },
  precise: BubbleMaskDetectionResult,
): Promise<BubbleMaskDetectionResult> {
  const refiner = options.bubbleQualityRefiner;
  if (!refiner) return precise;
  const hints = findBubbleRecoveryHints(options.page, precise.mask);
  if (hints.length === 0) {
    return { ...precise, recoveryCandidates: 0, recoveredBlocks: 0 };
  }
  try {
    const recoveredMask = await refiner.refine(
      options.bitmap,
      options.page.width,
      options.page.height,
      hints,
      { signal: options.signal },
    );
    const recovered = mergeRecoveredBubbleMask(
      precise.mask,
      recoveredMask,
      options.page,
      hints,
    );
    return {
      ...precise,
      mask: recovered.mask,
      regions: countBubbleRegions(recovered.mask),
      recoveryCandidates: hints.length,
      recoveredBlocks: recovered.recoveredBlocks,
    };
  } catch (error) {
    logInpaintingRuntimeWarn(
      "Conditional RT-DETR + SAM bubble recovery failed; precise mask retained",
      {
        page: options.page.name,
        recoveryCandidates: hints.length,
        model: refiner.model,
        error,
      },
    );
    return {
      ...precise,
      recoveryCandidates: hints.length,
      recoveredBlocks: 0,
    };
  }
}

function countBubbleRegions(mask: Uint8Array): number {
  const ids = new Set(mask);
  return ids.size - (ids.has(0) ? 1 : 0);
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
