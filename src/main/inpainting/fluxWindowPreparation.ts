import { clamp } from "../../shared/bboxNormalization";
import { throwIfAborted } from "./fluxAssets/errors";
import type {
  FluxInpaintRunnerArgs,
  FluxInpaintRunOptions,
  ResolvedFluxInpaintOptions,
  FluxWindowProcessArgs,
} from "./fluxEngineRunnerTypes";
import {
  prepareFluxWindowCrops,
  canPackFluxLightWindow,
  protectedFluxLightBounds,
  packFluxLightInputs,
  type FluxLightWindow,
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
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";

export function resolveFluxInpaintOptions(
  runOptions: FluxInpaintRunOptions,
): ResolvedFluxInpaintOptions {
  return {
    featherPx: clamp(
      Math.round(runOptions.featherPx ?? FLUX_INPAINT_FEATHER_PX),
      0,
      48,
    ),
    contextPx: clamp(
      Math.round(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX),
      16,
      256,
    ),
    maskPaddingPx: clamp(
      Math.round(runOptions.maskPaddingPx ?? FLUX_INPAINT_MASK_PADDING_PX),
      0,
      64,
    ),
    maxPixels: clamp(
      Math.round(runOptions.maxPixels ?? FLUX_INPAINT_MAX_PIXELS),
      256 * 256,
      1536 * 1536,
    ),
  };
}

export type PreparedFluxWindow = ReturnType<typeof prepareWindowForProcessing>;

function prepareWindowForProcessing(args: FluxWindowProcessArgs) {
  const {
    height,
    index,
    isolateWindowMasks,
    mask,
    options,
    runOptions,
    cropStrategy,
    width,
    window,
    windowMasks,
  } = args;
  const hint = runOptions.illustratedTitleWindows?.[index];
  const { crops, effectiveMask } = prepareFluxWindow({
    cropOptions:
      hint === "brush"
        ? { ...options, contextPx: Math.min(options.contextPx, 72) }
        : hint === "balloon-edge-reading"
          ? { ...options, contextPx: Math.max(512, options.contextPx) }
          : options,
    isolatedReference: String(hint).startsWith("jacket:"),
    height,
    isolateWindowMasks: isolateWindowMasks || !!runOptions.compositeConstraints,
    mask,
    cropStrategy,
    width,
    window,
    windowMask: windowMasks?.[index],
  });
  // With explicit composite cores the compositor ignores its fallback page mask.
  // Do not retain a full-page allocation for each member waiting in a group.
  return {
    args,
    crops,
    featherPx: resolveCompositeFeatherPx(args),
    effectiveMask: args.compositeMasks ? mask : effectiveMask,
  };
}

function lightWindowGeometry({
  args,
  crops,
  featherPx,
}: PreparedFluxWindow): FluxLightWindow | undefined {
  const { index, windowMasks, compositeMasks, runOptions } = args;
  const speechBubble = runOptions.speechBubbleWindows?.[index];
  const model = windowMasks?.[index];
  const composite = compositeMasks?.[index];
  if (crops.length !== 1 || !model || !composite || speechBubble === undefined)
    return;
  return {
    crop: crops[0],
    model: model.core.bounds,
    protectedBounds: protectedFluxLightBounds(
      model.input.bounds,
      composite.bounds,
      runOptions.compositeConstraints?.[index]?.bounds,
      args,
      featherPx,
    ),
    speechBubble,
  };
}

function resolveCompositeFeatherPx({
  runOptions,
  options,
  index,
}: FluxWindowProcessArgs): number {
  return clamp(
    Math.round(runOptions.compositeFeatherPx?.[index] ?? options.featherPx),
    0,
    48,
  );
}

export function* prepareFluxWindowGroups(
  page: Omit<FluxWindowProcessArgs, "index" | "window"> & {
    windows: PixelRect[];
  },
  order: readonly number[],
  packLightWindows: boolean,
) {
  let members: PreparedFluxWindow[] = [];
  let peers: FluxLightWindow[] = [];
  const group = () => ({
    members,
    input: peers.length > 1 ? packFluxLightInputs(peers, page) : undefined,
  });
  for (const index of order) {
    throwIfAborted(page.runOptions.signal);
    const member = prepareWindowForProcessing({
      ...page,
      index,
      window: page.windows[index],
    });
    const next = packLightWindows ? lightWindowGeometry(member) : undefined;
    if (
      members.length &&
      (!next || !canPackFluxLightWindow(peers, next, page, page.options))
    ) {
      yield group();
      members = [];
      peers = [];
    }
    if (next) {
      members.push(member);
      peers.push(next);
    } else {
      yield { members: [member], input: undefined };
    }
  }
  if (members.length) yield group();
}

function prepareFluxWindow(options: {
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
