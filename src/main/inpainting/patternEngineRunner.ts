import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
import type { InpaintingEngine } from "./inpaintingEngine";
import type { PatternMaskContext } from "./patternPageMask";
import { resolvePatternInpaintWindows } from "./patternWindowPolicy";

export async function runPatternInpaintingEngine(options: {
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
    options.engine.model === "flux-klein" &&
    options.maskContext.inpaintWindowConstraints.some(
      (constraint) => constraint !== null,
    );
  const flux = options.engine.model === "flux-klein";
  const typographyComposite = options.maskContext.usesKoharuTypographyComposite;
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
      { preserveBlockOwnership: flux },
    ),
    {
      signal: options.signal,
      featherPx: FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      bubbleMask: flux
        ? undefined
        : new Uint8Array(options.width * options.height),
      windowMasks: flux ? options.maskContext.inpaintWindowMasks : undefined,
      compositeMasks:
        flux || typographyComposite
          ? options.maskContext.inpaintCompositeMasks
          : undefined,
      compositeFeatherPx:
        flux || typographyComposite
          ? options.maskContext.inpaintCompositeFeatherPx
          : undefined,
      compositeConstraints:
        constrainedFlux || typographyComposite
          ? options.maskContext.inpaintWindowConstraints
          : undefined,
      requirePixelChange: true,
    },
  );
}
