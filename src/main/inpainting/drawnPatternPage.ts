import { nativeImage } from "electron";
import { restoreHiddenPixels } from "../imageRedactionPixels";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InpaintingMaskStroke } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { removeArtifactAfterFailure } from "../artifactCleanup";
import { tMain } from "../i18n";
import { measureWindowMaskedRegionChange } from "./fluxChangeStats";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO";
import type { InpaintingEngine } from "./inpaintingEngine";
import type {
  ImageDecodeFallback,
  PatternPageInpaintingResult,
} from "./inpaintingTypes";
import { expandRect, type PixelRect, rectHasMask } from "./maskGeometry";
import { resolvePatternInpaintWindows } from "./patternWindowPolicy";
import {
  buildMaskFromStrokes,
  maskComponents,
  sanitizeMaskStrokes,
} from "./rasterMasks";
import {
  persistActualInpaintMask,
  buildMaskFromBitmapDifference,
} from "./inpaintMaskArtifact";

type DrawnPatternOptions = {
  strokes: InpaintingMaskStroke[];
  /** Trusted internal, reviewed binary mask. Not an IPC/file-upload contract. */
  preparedMask?: Uint8Array;
  signal?: AbortSignal;
  decodeFallback?: ImageDecodeFallback;
  inpaintingEngine?: InpaintingEngine;
  featherPx?: number;
};

type DrawnMaskComponent = {
  rect: PixelRect;
  data: Uint8Array;
  window: PixelRect;
};

type DrawnPatternInput = {
  assetPath: string;
  bitmap: Buffer;
  components: DrawnMaskComponent[];
  height: number;
  pageMask: Uint8Array;
  width: number;
};

export async function inpaintDrawnPatternPage(
  page: MangaPage,
  options: DrawnPatternOptions,
): Promise<PatternPageInpaintingResult> {
  const strokes = sanitizeMaskStrokes(options.strokes, page.width, page.height);
  if (strokes.length === 0 && !options.preparedMask)
    return { page, blocksErased: 0 };
  if (strokes.length && options.preparedMask)
    throw new Error("Choose native strokes or one prepared mask, not both.");

  const input = await loadDrawnPatternInput(page, strokes, options);
  if (input.components.length === 0) return { page, blocksErased: 0 };

  const engine = requireInpaintingEngine(options.inpaintingEngine);
  const beforeBitmap = Buffer.from(input.bitmap);
  const boundary = options.preparedMask
    ? Uint8Array.from(input.pageMask, (value) => (value ? 0 : 1))
    : undefined;
  await runDrawnPatternInpainting(input, engine, options, page.imagePath);
  // Padding/context may guide inference, but cannot authorize extra final pixels.
  restoreHiddenPixels(beforeBitmap, input.bitmap, boundary);
  const blocksErased = countChangedComponents(beforeBitmap, input);
  const blocksIncomplete = input.components.length - blocksErased;
  if (blocksErased === 0) {
    return { page, blocksErased: 0, blocksIncomplete };
  }
  if (engine.model === "codex")
    input.pageMask = buildMaskFromBitmapDifference(
      beforeBitmap,
      input.bitmap,
      input.width,
      input.height,
    );
  return writeDrawnInpaintingResult(
    page,
    input,
    blocksErased,
    blocksIncomplete,
    options.decodeFallback,
  );
}

async function loadDrawnPatternInput(
  page: MangaPage,
  strokes: InpaintingMaskStroke[],
  options: DrawnPatternOptions,
): Promise<DrawnPatternInput> {
  const assetPath = page.inpaintedImagePath ?? page.imagePath;
  const image = await loadPageImage(assetPath, options.decodeFallback);
  const { width, height } = image.getSize();
  if (!width || !height) {
    throw new Error(tMain("inpainting.errors.pageRead", { page: page.name }));
  }
  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < width * height * 4) {
    throw new Error(
      tMain("inpainting.errors.bitmapCreate", { page: page.name }),
    );
  }
  const pageMask = options.preparedMask
    ? checkedPreparedMask(options.preparedMask, page, width, height)
    : buildMaskFromStrokes(strokes, width, height);
  return {
    assetPath,
    bitmap,
    components: resolveDrawnMaskComponents(pageMask, width, height),
    height,
    pageMask,
    width,
  };
}

function checkedPreparedMask(
  mask: Uint8Array,
  page: MangaPage,
  width: number,
  height: number,
): Uint8Array {
  if (
    width !== page.width ||
    height !== page.height ||
    mask.length !== width * height ||
    mask.some((value) => value !== 0 && value !== 1)
  )
    throw new Error(
      "Prepared mask must match the exact page dimensions and contain only binary pixels.",
    );
  return new Uint8Array(mask);
}

function resolveDrawnMaskComponents(
  pageMask: Uint8Array,
  width: number,
  height: number,
): DrawnMaskComponent[] {
  return maskComponents(pageMask, width, height, 12)
    .map((component) => ({
      data: component.data,
      rect: component.rect,
      window: expandRect(
        component.rect,
        width,
        height,
        FLUX_INPAINT_CONTEXT_PX,
      ),
    }))
    .filter((component) => rectHasMask(pageMask, width, component.window));
}

function requireInpaintingEngine(
  engine: InpaintingEngine | undefined,
): InpaintingEngine {
  if (!engine) throw new Error(tMain("inpainting.errors.engineNotReady"));
  return engine;
}

async function runDrawnPatternInpainting(
  input: DrawnPatternInput,
  engine: InpaintingEngine,
  options: DrawnPatternOptions,
  sourceImagePath: string,
): Promise<void> {
  await engine.inpaint(
    input.bitmap,
    input.width,
    input.height,
    input.pageMask,
    resolvePatternInpaintWindows(
      input.components.map((component) => component.window),
      engine,
    ),
    {
      signal: options.signal,
      sourceImagePath,
      inputImagePath: input.assetPath,
      decodeFallback: options.decodeFallback,
      featherPx: options.featherPx ?? FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      bubbleMask:
        engine.model === "flux-klein"
          ? undefined
          : new Uint8Array(input.width * input.height),
      windowMasks: resolveOwnedWindowMasks(engine, input.components),
      requirePixelChange: true,
    },
  );
}

function resolveOwnedWindowMasks(
  engine: InpaintingEngine,
  components: DrawnMaskComponent[],
): Array<{ bounds: PixelRect; data: Uint8Array }> | undefined {
  if (engine.model !== "flux-klein" || engine.backend !== "metal-native") {
    return undefined;
  }
  return components.map((component) => ({
    bounds: component.rect,
    data: component.data,
  }));
}

function countChangedComponents(
  beforeBitmap: Buffer,
  input: DrawnPatternInput,
): number {
  return input.components.filter(
    (component) =>
      measureWindowMaskedRegionChange(beforeBitmap, input.bitmap, input.width, {
        bounds: component.rect,
        data: component.data,
      }).changedPixels > 0,
  ).length;
}

async function writeDrawnInpaintingResult(
  page: MangaPage,
  input: DrawnPatternInput,
  blocksErased: number,
  blocksIncomplete: number,
  decodeFallback: ImageDecodeFallback | undefined,
): Promise<PatternPageInpaintingResult> {
  const outputImage = nativeImage.createFromBitmap(input.bitmap, {
    width: input.width,
    height: input.height,
  });
  if (outputImage.isEmpty()) {
    throw new Error(
      tMain("inpainting.errors.resultCreate", { page: page.name }),
    );
  }
  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern-drawn");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());
  let persistedMask: Awaited<ReturnType<typeof persistActualInpaintMask>>;
  try {
    persistedMask = await persistActualInpaintMask({
      page,
      mask: input.pageMask,
      width: input.width,
      height: input.height,
      suffix: "pattern-drawn",
      decodeFallback,
    });
  } catch (error) {
    return removeArtifactAfterFailure(outputPath, error);
  }
  return {
    blocksErased,
    blocksIncomplete,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      inpaintMaskPath: persistedMask.path,
      maskProvenance: persistedMask.provenance,
      updatedAt: new Date().toISOString(),
    },
  };
}
