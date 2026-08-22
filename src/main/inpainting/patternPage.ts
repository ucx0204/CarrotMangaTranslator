import { nativeImage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import type { InpaintingEngine } from "./inpaintingEngine";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import { measureWindowMaskedRegionChange } from "./fluxChangeStats";
import {
  resolveEligiblePatternBlocks,
  shouldUseOriginalPatternImage,
} from "./patternBlockEligibility";
import { runPatternInpaintingEngine } from "./patternEngineRunner";
import {
  buildPatternPageMask,
  type PatternMaskContext,
} from "./patternPageMask";
import {
  attachRequiredPatternSourceDiagnostics,
  cleanupStrictDiagnosticOutput,
} from "./patternPageSourceDiagnostics";
import type {
  ImageDecodeFallback,
  PatternPageInpaintingResult,
} from "./inpaintingTypes";
import {
  createPatternBitmapBaseline,
  type PatternBitmapBaseline,
} from "./sourceGlyphEvidenceReceipt";

type PatternPageInpaintingOptions = {
  blockId?: string;
  signal?: AbortSignal;
  decodeFallback?: ImageDecodeFallback;
  inpaintingEngine?: InpaintingEngine;
  /** Accept only current zero-padding prepass or allowlisted manual geometry. */
  bubbleLayoutConstraintBlockIds?: readonly string[];
  /** Block ids already committed by an earlier partial page run. */
  excludedBlockIds?: readonly string[];
  sharedInpaintGroupIdsByBlock?: Readonly<Record<string, readonly string[]>>;
  typographySegmentation?: KoharuTypographySegmentation;
  /** Production stays disabled; sealed QA/offline evidence opts in. */
  sourceEvidenceMode?: "disabled" | "required";
};

export async function inpaintPatternPage(
  page: MangaPage,
  options: PatternPageInpaintingOptions = {},
): Promise<PatternPageInpaintingResult> {
  const patternBlockIds = resolvePatternBlockIds(page, options);
  if (patternBlockIds.length === 0) return { page, blocksErased: 0 };
  const working = await loadPatternWorkingBitmap(
    page,
    options.decodeFallback,
    options.sourceEvidenceMode === "required",
  );
  const size = { width: working.width, height: working.height };
  const bitmap = Buffer.from(working.bitmap);

  const maskContext = createPatternMaskContext(page, bitmap, size, options);
  if (maskContext.blocksErased === 0) return { page, blocksErased: 0 };
  const beforeBitmap = working.bitmap;
  await runPatternInpaintingEngine({
    bitmap,
    engine: options.inpaintingEngine,
    height: size.height,
    maskContext,
    signal: options.signal,
    width: size.width,
  });
  const changes = resolvePatternPixelChanges(
    beforeBitmap,
    bitmap,
    maskContext,
    options.inpaintingEngine,
    size.width,
  );
  if (changes.erasedBlockIds.length === 0) {
    const unchangedResult: PatternPageInpaintingResult = {
      page,
      blocksErased: 0,
      blocksIncomplete: changes.incompleteBlockIds.length,
      erasedBlockIds: [],
      incompleteBlockIds: changes.incompleteBlockIds,
    };
    if (options.sourceEvidenceMode !== "required") return unchangedResult;
    return attachRequiredSourceDiagnostics(unchangedResult, {
      afterBitmap: bitmap,
      maskContext,
      options,
      page,
      patternBlockIds,
      working,
    });
  }
  logPatternInpaintingResult(maskContext, options.inpaintingEngine, changes);

  const output = await writePatternInpaintedImage(page, bitmap, size);
  const completedResult: PatternPageInpaintingResult = {
    blocksErased: changes.erasedBlockIds.length,
    blocksIncomplete: changes.incompleteBlockIds.length,
    erasedBlockIds: changes.erasedBlockIds,
    incompleteBlockIds: changes.incompleteBlockIds,
    page: {
      ...page,
      inpaintedImagePath: output.path,
      updatedAt: new Date().toISOString(),
    },
  };
  if (options.sourceEvidenceMode !== "required") return completedResult;
  return attachRequiredSourceDiagnostics(completedResult, {
    afterBitmap: bitmap,
    maskContext,
    options,
    output,
    page,
    patternBlockIds,
    working,
  });
}

function resolvePatternBlockIds(
  page: MangaPage,
  options: PatternPageInpaintingOptions,
): string[] {
  return resolveEligiblePatternBlocks(
    page,
    options.blockId,
    options.excludedBlockIds,
  ).map((block) => block.id);
}

function createPatternMaskContext(
  page: MangaPage,
  bitmap: Buffer,
  size: { height: number; width: number },
  options: PatternPageInpaintingOptions,
): PatternMaskContext {
  return buildPatternPageMask({
    blockId: options.blockId,
    page,
    bitmap,
    collectSourceGlyphEvidence: false,
    width: size.width,
    height: size.height,
    mode:
      options.inpaintingEngine?.model === "flux-klein" ||
      options.typographySegmentation
        ? "flux-region"
        : "glyph",
    bubbleLayoutConstraintBlockIds: options.bubbleLayoutConstraintBlockIds,
    excludedBlockIds: options.excludedBlockIds,
    sharedInpaintGroupIdsByBlock: options.sharedInpaintGroupIdsByBlock,
    typographySegmentation: options.typographySegmentation,
    signal: options.signal,
  });
}

type PatternWorkingBitmap = {
  assetPath: string;
  bitmap: Buffer;
  height: number;
  strictBaseline?: PatternBitmapBaseline;
  width: number;
};

async function loadPatternWorkingBitmap(
  page: MangaPage,
  decodeFallback: ImageDecodeFallback | undefined,
  strictEvidence: boolean,
): Promise<PatternWorkingBitmap> {
  const beforePath = shouldUseOriginalPatternImage(page)
    ? page.imagePath
    : (page.inpaintedImagePath ?? page.imagePath);
  if (strictEvidence) {
    const strictBaseline = await loadPatternBitmapBaseline(
      page,
      beforePath,
      decodeFallback,
    );
    return { ...strictBaseline, strictBaseline };
  }
  const image = await loadPageImage(beforePath, decodeFallback);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }
  const bitmap = image.toBitmap();
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }
  return {
    assetPath: beforePath,
    bitmap,
    height: size.height,
    width: size.width,
  };
}

async function loadPatternBitmapBaseline(
  page: MangaPage,
  assetPath: string,
  decodeFallback: ImageDecodeFallback | undefined,
): Promise<PatternBitmapBaseline> {
  const assetBytesBeforeDecode = await tryReadFile(assetPath);
  const image = await loadPageImage(assetPath, decodeFallback);
  const assetBytesAfterDecode = await tryReadFile(assetPath);
  if (
    assetBytesBeforeDecode &&
    assetBytesAfterDecode &&
    !assetBytesBeforeDecode.equals(assetBytesAfterDecode)
  ) {
    throw new Error(`이미지 파일이 디코딩 중 변경되었습니다: ${page.name}`);
  }
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }
  const bitmap = image.toBitmap();
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }
  return createPatternBitmapBaseline({
    assetPath,
    assetBytes: assetBytesAfterDecode ?? assetBytesBeforeDecode,
    bitmap,
    height: size.height,
    width: size.width,
  });
}

type PatternPixelChanges = {
  erasedBlockIds: string[];
  incompleteBlockIds: string[];
};

type PatternInpaintedOutput = { bytes: Buffer; path: string };

async function attachRequiredSourceDiagnostics(
  result: PatternPageInpaintingResult,
  context: {
    afterBitmap: Buffer;
    maskContext: PatternMaskContext;
    options: PatternPageInpaintingOptions;
    output?: PatternInpaintedOutput;
    page: MangaPage;
    patternBlockIds: readonly string[];
    working: PatternWorkingBitmap;
  },
): Promise<PatternPageInpaintingResult> {
  try {
    return await attachRequiredPatternSourceDiagnostics(result, {
      afterBitmap: context.afterBitmap,
      before: context.working.strictBaseline,
      engine: context.options.inpaintingEngine,
      loadImmutableSource: async () => {
        if (
          context.working.assetPath === context.page.imagePath &&
          context.working.strictBaseline
        ) {
          return context.working.strictBaseline;
        }
        return loadPatternBitmapBaseline(
          context.page,
          context.page.imagePath,
          context.options.decodeFallback,
        );
      },
      maskContext: context.maskContext,
      output: context.output,
      page: context.page,
      patternBlockIds: context.patternBlockIds,
      required: true,
    });
  } catch (error) {
    if (!context.output) throw error;
    return cleanupStrictDiagnosticOutput(context.output.path, error);
  }
}

function resolvePatternPixelChanges(
  before: Buffer,
  after: Buffer,
  mask: PatternMaskContext,
  engine: InpaintingEngine | undefined,
  width: number,
): PatternPixelChanges {
  const stats = mask.validationWindowMasks.map((windowMask, index) => {
    const blockId = mask.validationBlockIds[index];
    if (!blockId) {
      throw new Error("Pattern validation block binding is incomplete.");
    }
    return {
      blockId,
      ...measureWindowMaskedRegionChange(before, after, width, windowMask),
    };
  });
  const unchangedTargets = stats.filter((item) => item.changedPixels <= 0);
  const incompleteBlockIds = stats
    .filter((item) => item.changedPixels <= 0)
    .map((item) => item.blockId);
  if (unchangedTargets.length > 0) {
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
  }
  return {
    erasedBlockIds: stats
      .filter((item) => item.changedPixels > 0)
      .map((item) => item.blockId),
    incompleteBlockIds,
  };
}

function logPatternInpaintingResult(
  mask: PatternMaskContext,
  engine: InpaintingEngine | undefined,
  changes: PatternPixelChanges,
): void {
  logInpaintingRuntimeInfo("Selected inpainting model processing completed", {
    model: engine?.model,
    blocks: mask.blocksErased,
    blocksErased: changes.erasedBlockIds.length,
    blocksIncomplete: changes.incompleteBlockIds.length,
    otsuBlocks: mask.otsuBlocks,
  });
}

async function writePatternInpaintedImage(
  page: MangaPage,
  bitmap: Buffer,
  size: { width: number; height: number },
): Promise<PatternInpaintedOutput> {
  const outputImage = nativeImage.createFromBitmap(bitmap, size);
  if (outputImage.isEmpty()) {
    throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern");
  const png = outputImage.toPNG();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, png, { flag: "wx" });
  return { bytes: png, path: outputPath };
}

async function tryReadFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
