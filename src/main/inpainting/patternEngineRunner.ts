import { usesRegionInpainting } from "../../shared/inpaintingSettingsTypes";
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
import { isIllustratedTitleGroup } from "./qwenIllustratedPlate";

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
  const regionModel = usesRegionInpainting(options.engine.model);
  const codex = options.engine.model === "codex";
  const typographyComposite = options.maskContext.usesKoharuTypographyComposite;
  const composite = regionModel || typographyComposite;
  const owned = regionModel || codex;
  const constrained = constrainedFlux || typographyComposite;
  const bubbleOptions = regionModel
    ? { speechBubbleWindows: options.maskContext.inpaintSpeechBubbleWindows }
    : { bubbleMask: new Uint8Array(options.width * options.height) };
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
      ...bubbleOptions,
      ...illustratedTitleOptions(options.engine.model, options.maskContext),
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

function illustratedTitleOptions(
  model: InpaintingEngine["model"],
  context: PatternMaskContext,
) {
  if (model !== "qwen-image-2.1") return {};
  const windows = context.inpaintWindowGroupIds.map(isIllustratedTitleGroup);
  return {
    ...(windows.some(Boolean) ? { illustratedTitleWindows: windows } : {}),
    ...(context.windowProcessingOrder
      ? { windowProcessingOrder: context.windowProcessingOrder }
      : {}),
  };
}
