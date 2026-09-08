import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
import type { InpaintingEngine } from "./inpaintingEngine";
import type { ImageDecodeFallback } from "./inpaintingTypes";
import type { PatternMaskContext } from "./patternPageMask";
import { resolvePatternInpaintWindows } from "./patternWindowPolicy";

export async function runPatternInpaintingEngine(options: {
  sourceImagePath?: string;
  inputImagePath?: string;
  decodeFallback?: ImageDecodeFallback;
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
  const constrainedFlux =
    options.maskContext.inpaintWindowConstraints.some(Boolean);
  const flux = options.engine.model === "flux-klein";
  const codex = options.engine.model === "codex";
  const typographyComposite = options.maskContext.usesKoharuTypographyComposite;
  const composite = flux || typographyComposite;
  const owned = flux || codex;
  const constrained = constrainedFlux || typographyComposite;
  await options.engine.inpaint(
    options.bitmap,
    options.width,
    options.height,
    options.maskContext.pageMask,
    resolvePatternInpaintWindows(
      options.maskContext.inpaintWindows,
      options.engine,
      // Flux composites are indexed one-to-one with their processing windows.
      // Merging only the windows would leave the parallel mask inventories
      // misaligned, even when every optional hard constraint is null.
      { preserveBlockOwnership: owned },
    ),
    {
      signal: options.signal,
      sourceImagePath: options.sourceImagePath,
      inputImagePath: options.inputImagePath,
      decodeFallback: options.decodeFallback,
      codexMaskMode: codex ? "region" : undefined,
      featherPx: FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      bubbleMask: flux
        ? undefined
        : new Uint8Array(options.width * options.height),
      windowMasks: owned ? options.maskContext.inpaintWindowMasks : undefined,
      compositeMasks: composite
        ? options.maskContext.inpaintCompositeMasks
        : undefined,
      compositeFeatherPx: composite
        ? options.maskContext.inpaintCompositeFeatherPx
        : undefined,
      compositeConstraints: constrained
        ? options.maskContext.inpaintWindowConstraints
        : undefined,
      // The page owns per-block change accounting and can return incomplete targets.
      requirePixelChange: false,
    },
  );
}
