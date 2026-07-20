import {
  prepareFluxWindowCrops,
  type FluxPreparedCrop,
} from "./fluxCropTiling";
import { isolateMaskToWindow } from "./imageRaster";
import {
  expandWindowMaskToPage,
  type ExclusiveInpaintingWindowMasks,
} from "./inpaintingWindowMask";
import type { PixelRect } from "./maskGeometry";

export function prepareFluxWindow(options: {
  cropOptions: {
    contextPx: number;
    featherPx: number;
    maskPaddingPx: number;
    maxPixels: number;
  };
  height: number;
  isolateWindowMasks: boolean;
  mask: Uint8Array;
  tileLargeCrops: boolean;
  width: number;
  window: PixelRect;
  windowMask?: ExclusiveInpaintingWindowMasks;
}): { crops: FluxPreparedCrop[]; effectiveMask: Uint8Array } {
  let effectiveMask = options.mask;
  let inputMask: Uint8Array | undefined;
  if (options.isolateWindowMasks) {
    effectiveMask = options.windowMask
      ? expandWindowMaskToPage(
          options.windowMask.core,
          options.width,
          options.height,
        )
      : isolateMaskToWindow(options.mask, options.width, options.window);
    inputMask = options.windowMask
      ? expandWindowMaskToPage(
          options.windowMask.input,
          options.width,
          options.height,
        )
      : undefined;
  }
  return {
    effectiveMask,
    crops: prepareFluxWindowCrops({
      ...options.cropOptions,
      height: options.height,
      inputMask,
      inputMaskPaddingPx: inputMask ? 0 : undefined,
      mask: effectiveMask,
      tileLargeCrops: options.tileLargeCrops,
      width: options.width,
      window: options.window,
    }),
  };
}
