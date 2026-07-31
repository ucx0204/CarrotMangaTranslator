import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
import type { InpaintingEngine } from "./inpaintingEngine";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import { measureWindowMaskedRegionChange } from "./fluxChangeStats";
import { isPatternInpaintingBlockEligible } from "./patternBlockEligibility";
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
    blockId?: string;
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    inpaintingEngine?: InpaintingEngine;
    /**
     * Accept bubble geometry only from the current job's zero-padding prepass.
     * Persisted automatic layouts may contain display padding and must not be
     * reused here. Existing manual geometry is explicitly allowlisted.
     */
    bubbleLayoutConstraintBlockIds?: readonly string[];
    sharedInpaintGroupIdsByBlock?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Promise<PatternPageInpaintingResult> {
  const patternBlocks = page.blocks.filter((block) =>
    isPatternInpaintingBlockEligible(block, options.blockId),
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
    blockId: options.blockId,
    page,
    bitmap,
    width: size.width,
    height: size.height,
    mode:
      options.inpaintingEngine?.model === "flux-klein"
        ? "flux-region"
        : "glyph",
    bubbleLayoutConstraintBlockIds: options.bubbleLayoutConstraintBlockIds,
    sharedInpaintGroupIdsByBlock: options.sharedInpaintGroupIdsByBlock,
    signal: options.signal,
  });
  if (maskContext.blocksErased === 0) {
    return { page, blocksErased: 0 };
  }
  const beforeBitmap = Buffer.from(bitmap);
  await runPatternInpaintingEngine({
    bitmap,
    engine: options.inpaintingEngine,
    height: size.height,
    maskContext,
    signal: options.signal,
    width: size.width,
  });
  if (
    !hasPatternPixelChanges(
      beforeBitmap,
      bitmap,
      maskContext,
      options.inpaintingEngine,
      size.width,
    )
  ) {
    return { page, blocksErased: 0 };
  }
  logPatternInpaintingResult(maskContext, options.inpaintingEngine);

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

function hasPatternPixelChanges(
  before: Buffer,
  after: Buffer,
  mask: PatternMaskContext,
  engine: InpaintingEngine | undefined,
  width: number,
): boolean {
  const stats = mask.validationWindowMasks.map((windowMask) =>
    measureWindowMaskedRegionChange(before, after, width, windowMask),
  );
  const unchangedTargets = stats.filter((item) => item.changedPixels <= 0);
  if (stats.length > 0 && unchangedTargets.length === 0) return true;
  logInpaintingRuntimeInfo(
    "Selected inpainting model left one or more target masks unchanged",
    {
      model: engine?.model,
      blocks: mask.blocksErased,
      targetMasks: stats.length,
      unchangedTargetMasks: unchangedTargets.length,
      unchangedStats: unchangedTargets,
    },
  );
  return false;
}

async function runPatternInpaintingEngine(options: {
  bitmap: Buffer;
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
  const hasBubbleConstraints =
    options.engine.model === "flux-klein" &&
    options.maskContext.inpaintWindowConstraints.some(
      (constraint) => constraint !== null,
    );
  await options.engine.inpaint(
    options.bitmap,
    options.width,
    options.height,
    options.maskContext.pageMask,
    resolvePatternInpaintWindows(
      options.maskContext.inpaintWindows,
      options.engine,
      { preserveBlockOwnership: hasBubbleConstraints },
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
          : new Uint8Array(options.width * options.height),
      windowMasks:
        options.engine.model === "flux-klein"
          ? options.maskContext.inpaintWindowMasks
          : undefined,
      compositeConstraints: hasBubbleConstraints
        ? options.maskContext.inpaintWindowConstraints
        : undefined,
      requirePixelChange: true,
    },
  );
}

function logPatternInpaintingResult(
  mask: PatternMaskContext,
  engine: InpaintingEngine | undefined,
): void {
  logInpaintingRuntimeInfo("Selected inpainting model processing completed", {
    model: engine?.model,
    blocks: mask.blocksErased,
    otsuBlocks: mask.otsuBlocks,
  });
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
