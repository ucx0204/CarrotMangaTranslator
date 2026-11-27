import type { FluxInpaintRunnerArgs } from "./fluxEngineRunnerTypes";
import {
  prepareFluxWindowCrops,
  type FluxPreparedCrop,
  type FluxCropStrategy,
} from "./fluxCropTiling";
import { isolateMaskToWindow } from "./imageRaster";
import {
  expandWindowMaskToPage,
  buildExclusivePaddedWindowMasks,
  containingTypographyOwners,
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
  cropStrategy: FluxCropStrategy;
  width: number;
  window: PixelRect;
  isolatedReference?: boolean;
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
      cropStrategy: options.cropStrategy,
      width: options.width,
      window: options.window,
      isolatedReference: options.isolatedReference,
    }),
  };
}

export function prepareFluxWindowMasks({
  width,
  height,
  isolateWindowMasks,
  modelMaskIsTypography,
  runOptions,
  maskPaddingPx,
}: Pick<
  FluxInpaintRunnerArgs,
  | "width"
  | "height"
  | "runOptions"
  | "isolateWindowMasks"
  | "modelMaskIsTypography"
> & { maskPaddingPx: number }) {
  // Qwen conditions on the narrow detected ink. Reserve that ink before
  // assigning wider composite shoulders to overlapping selected blocks.
  const priority = modelMaskIsTypography
    ? runOptions.windowMasks
    : runOptions.compositeMasks;
  const containingOwners = modelMaskIsTypography
    ? containingTypographyOwners(runOptions)
    : undefined;
  const windowMasks =
    (isolateWindowMasks || runOptions.compositeConstraints) &&
    runOptions.windowMasks
      ? buildExclusivePaddedWindowMasks(
          runOptions.windowMasks,
          width,
          height,
          maskPaddingPx,
          priority,
          containingOwners,
        )
      : undefined;
  const compositeMasks = runOptions.compositeMasks
    ? buildExclusivePaddedWindowMasks(
        runOptions.compositeMasks,
        width,
        height,
        0,
        modelMaskIsTypography ? runOptions.windowMasks : undefined,
        containingOwners,
      ).map((masks) => masks.core)
    : undefined;
  return { windowMasks, compositeMasks };
}
