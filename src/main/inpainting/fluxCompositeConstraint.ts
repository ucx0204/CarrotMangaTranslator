import type { FluxPreparedCrop } from "./fluxCropTiling";
import { compositeFluxOutput } from "./imageRaster";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  expandWindowMaskToPage,
  type ExclusiveInpaintingWindowMasks,
} from "./inpaintingWindowMask";

export function compositeConstrainedFluxOutput(options: {
  bitmap: Buffer;
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeMasks?: InpaintingWindowMask[];
  coreWindowMasks?: InpaintingWindowMask[];
  crop: FluxPreparedCrop;
  effectiveMask: Uint8Array;
  featherPx: number;
  generated: Buffer;
  height: number;
  index: number;
  width: number;
  windowMask?: ExclusiveInpaintingWindowMasks;
}): void {
  const masks = resolveFluxCompositeMasks(options);
  compositeFluxOutput(
    options.bitmap,
    options.generated,
    masks.core,
    options.width,
    options.crop.paddedBounds,
    options.featherPx,
    options.crop.writeBounds,
    masks.constraint,
  );
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
}): { core: Uint8Array; constraint?: Uint8Array } {
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
