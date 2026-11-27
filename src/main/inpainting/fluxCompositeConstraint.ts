import type { PixelRect } from "./maskGeometry";
import type { FluxPreparedCrop } from "./fluxCropTiling";
import { compositeFluxOutput } from "./imageRaster";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  expandWindowMaskToPage,
  type ExclusiveInpaintingWindowMasks,
} from "./inpaintingWindowMask";

export function prepareFluxComposite(options: {
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeMasks?: InpaintingWindowMask[];
  coreWindowMasks?: InpaintingWindowMask[];
  effectiveMask: Uint8Array;
  useGeneratedAlpha?: boolean;
  featherPx: number;
  height: number;
  index: number;
  width: number;
  windowMask?: ExclusiveInpaintingWindowMasks;
}) {
  const masks = resolveFluxCompositeMasks(options);
  return (bitmap: Buffer, generated: Buffer, crop: FluxPreparedCrop) =>
    compositeFluxOutput(
      bitmap,
      generated,
      masks.core,
      options.width,
      crop.paddedBounds,
      options.featherPx,
      masks.bounds
        ? intersectFeatheredBounds(
            crop.writeBounds,
            masks.bounds,
            options.featherPx,
          )
        : crop.writeBounds,
      masks.constraint,
      options.useGeneratedAlpha,
    );
}

function intersectFeatheredBounds(
  write: PixelRect,
  core: PixelRect,
  feather: number,
): PixelRect {
  const x = Math.max(write.x, core.x - feather);
  const y = Math.max(write.y, core.y - feather);
  return {
    x,
    y,
    w: Math.max(0, Math.min(write.x + write.w, core.x + core.w + feather) - x),
    h: Math.max(0, Math.min(write.y + write.h, core.y + core.h + feather) - y),
  };
}

function resolveFluxCompositeMasks(options: {
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeMasks?: InpaintingWindowMask[];
  coreWindowMasks?: InpaintingWindowMask[];
  effectiveMask: Uint8Array;
  height: number;
  index: number;
  width: number;
  windowMask?: ExclusiveInpaintingWindowMasks;
}): {
  core: Uint8Array;
  constraint?: Uint8Array;
  bounds?: InpaintingWindowMask["bounds"];
} {
  const constraint = options.compositeConstraints?.[options.index] ?? null;
  if (!options.compositeConstraints && !options.compositeMasks) {
    return { core: options.effectiveMask };
  }
  const coreWindow =
    options.compositeMasks?.[options.index] ??
    options.windowMask?.core ??
    options.coreWindowMasks?.[options.index];
  if (!coreWindow) {
    throw new Error(
      "Flux composite constraint is missing its owned core mask.",
    );
  }
  return {
    bounds: coreWindow.bounds,
    core: expandWindowMaskToPage(coreWindow, options.width, options.height),
    ...(constraint
      ? {
          constraint: expandWindowMaskToPage(
            constraint,
            options.width,
            options.height,
          ),
        }
      : {}),
  };
}
