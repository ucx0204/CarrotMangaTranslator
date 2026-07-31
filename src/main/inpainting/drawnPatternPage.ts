import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InpaintingMaskStroke } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
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

type DrawnPatternOptions = {
  strokes: InpaintingMaskStroke[];
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
  if (strokes.length === 0) return { page, blocksErased: 0 };

  const input = await loadDrawnPatternInput(page, strokes, options);
  if (input.components.length === 0) return { page, blocksErased: 0 };

  const engine = requireInpaintingEngine(options.inpaintingEngine);
  const beforeBitmap = Buffer.from(input.bitmap);
  await runDrawnPatternInpainting(input, engine, options);
  if (!allComponentsChanged(beforeBitmap, input)) {
    return { page, blocksErased: 0 };
  }
  return writeDrawnInpaintingResult(page, input);
}

async function loadDrawnPatternInput(
  page: MangaPage,
  strokes: InpaintingMaskStroke[],
  options: DrawnPatternOptions,
): Promise<DrawnPatternInput> {
  const image = await loadPageImage(
    page.inpaintedImagePath ?? page.imagePath,
    options.decodeFallback,
  );
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
  const pageMask = buildMaskFromStrokes(strokes, width, height);
  return {
    bitmap,
    components: resolveDrawnMaskComponents(pageMask, width, height),
    height,
    pageMask,
    width,
  };
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

function allComponentsChanged(
  beforeBitmap: Buffer,
  input: DrawnPatternInput,
): boolean {
  return input.components.every(
    (component) =>
      measureWindowMaskedRegionChange(beforeBitmap, input.bitmap, input.width, {
        bounds: component.rect,
        data: component.data,
      }).changedPixels > 0,
  );
}

async function writeDrawnInpaintingResult(
  page: MangaPage,
  input: DrawnPatternInput,
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
  return {
    blocksErased: input.components.length,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString(),
    },
  };
}
