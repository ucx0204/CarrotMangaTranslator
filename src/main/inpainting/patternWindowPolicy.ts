import type { InpaintingEngine } from "./inpaintingEngine";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  FLUX_METAL_INPAINT_CONTEXT_PX,
  FLUX_METAL_TILE_SIZE_PX,
} from "./fluxEngineConstants";
import { mergeRects, type PixelRect } from "./maskGeometry";

export type InpaintingBackendPolicy = Readonly<{
  enginePath: "flux" | "koharu";
  windowStrategy: "merge" | "preserve";
  maskStrategy: "owned" | "page";
  bubbleMaskStrategy: "omit" | "forward";
  contextPx: number;
  maxContextPx: number | null;
  featherPx: number;
  maskPaddingPx: number;
  maxPixels: number;
  cropStrategy: "scaled-to-budget" | "tiled-native" | "whole-page";
  maxCropSizePx: number | null;
}>;

export function resolveInpaintingBackendPolicy(
  engine: Pick<InpaintingEngine, "model" | "backend">,
): InpaintingBackendPolicy {
  if (engine.model !== "flux-klein") {
    return {
      enginePath: "koharu",
      windowStrategy: "merge",
      maskStrategy: "owned",
      bubbleMaskStrategy: "forward",
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maxContextPx: null,
      featherPx: FLUX_INPAINT_FEATHER_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      cropStrategy: "whole-page",
      maxCropSizePx: null,
    };
  }

  const metal = engine.backend === "metal-native";
  return {
    enginePath: "flux",
    windowStrategy: "preserve",
    maskStrategy: "owned",
    bubbleMaskStrategy: "omit",
    contextPx: metal ? FLUX_METAL_INPAINT_CONTEXT_PX : FLUX_INPAINT_CONTEXT_PX,
    maxContextPx: metal ? FLUX_METAL_INPAINT_CONTEXT_PX : null,
    featherPx: FLUX_INPAINT_FEATHER_PX,
    maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
    maxPixels: FLUX_INPAINT_MAX_PIXELS,
    cropStrategy: metal ? "tiled-native" : "scaled-to-budget",
    maxCropSizePx: metal ? FLUX_METAL_TILE_SIZE_PX : null,
  };
}

export function resolvePatternInpaintWindows(
  windows: PixelRect[],
  engine: Pick<InpaintingEngine, "model" | "backend">,
): PixelRect[] {
  if (resolveInpaintingBackendPolicy(engine).windowStrategy === "preserve") {
    return windows.map((window) => ({ ...window }));
  }
  return mergeRects(windows);
}
