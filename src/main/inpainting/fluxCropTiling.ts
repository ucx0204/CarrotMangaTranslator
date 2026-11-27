import {
  FLUX_INPAINT_MULTIPLE,
  FLUX_LIGHT_MAX_PIXELS,
  FLUX_METAL_TILE_SIZE_PX,
} from "./fluxEngineConstants";
import { buildLocalMask, maskBoundsInRect } from "./imageRaster";
import {
  alignRectToMultiple,
  expandRect,
  mergeMaskIntoPage,
  rectsTouchOrOverlap,
  rectHasMask,
  resolveContextTiles,
  resolveFluxProcessSize,
  unionRects,
  type PixelRect,
} from "./maskGeometry";

export type FluxCropStrategy =
  "resize" | "native" | "native-tiled" | "worker-resize";

export type FluxPreparedCrop = {
  localMask: Uint8Array;
  paddedBounds: PixelRect;
  processSize: { width: number; height: number };
  validationMask: Uint8Array;
  writeBounds: PixelRect;
};

export type FluxCropInput = Pick<
  FluxPreparedCrop,
  "localMask" | "paddedBounds" | "processSize"
> & { workerMaxPixels?: number };

export type FluxLightWindow = {
  crop: FluxPreparedCrop;
  model: PixelRect;
  protectedBounds: PixelRect;
  speechBubble: boolean;
};

export function protectedFluxLightBounds(
  modelInput: PixelRect,
  composite: PixelRect,
  constraint: PixelRect | undefined,
  page: { width: number; height: number },
  featherPx: number,
) {
  return unionRects(
    modelInput,
    constraint ?? expandRect(composite, page.width, page.height, featherPx),
  );
}

/** Consecutive owners may share a prediction only if every write area stays independent. */
export function canPackFluxLightWindow(
  peers: FluxLightWindow[],
  next: FluxLightWindow,
  page: { width: number; height: number },
  options: { contextPx: number; maskPaddingPx: number; maxPixels: number },
): boolean {
  if (
    peers.some(
      (peer) =>
        peer.speechBubble !== next.speechBubble ||
        rectsTouchOrOverlap(peer.protectedBounds, next.protectedBounds),
    )
  )
    return false;
  const members = [...peers, next];
  const model = members.map((m) => m.model).reduce(unionRects);
  const margin = 2 * (options.contextPx + options.maskPaddingPx);
  const maxSide = Math.sqrt(FLUX_LIGHT_MAX_PIXELS);
  if (model.w + margin > maxSide || model.h + margin > maxSide) return false;
  const bounds = packedCropBounds(members, page);
  // Background lettering can cross fine screentones. A shared field must
  // retain native detail there, even if the light budget has room to resize.
  const pixels = bounds.w * bounds.h;
  return (
    bounds.w <= maxSide &&
    bounds.h <= maxSide &&
    pixels <= options.maxPixels &&
    (next.speechBubble || pixels <= largestMemberPixels(members))
  );
}

function largestMemberPixels(members: FluxLightWindow[]): number {
  return Math.max(
    ...members.map(
      ({ crop }) => crop.processSize.width * crop.processSize.height,
    ),
  );
}

function packedCropBounds(
  members: FluxLightWindow[],
  page: { width: number; height: number },
) {
  return alignRectToMultiple(
    members.map((m) => m.crop.paddedBounds).reduce(unionRects),
    page.width,
    page.height,
    FLUX_INPAINT_MULTIPLE,
  );
}

export function packFluxLightInputs(
  members: FluxLightWindow[],
  page: { width: number; height: number },
): FluxCropInput {
  const bounds = packedCropBounds(members, page);
  const mask = new Uint8Array(bounds.w * bounds.h);
  for (const { crop } of members) {
    const rect = crop.paddedBounds;
    mergeMaskIntoPage(
      mask,
      bounds.w,
      { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y },
      crop.localMask,
    );
  }
  return {
    localMask: mask,
    paddedBounds: bounds,
    processSize: { width: bounds.w, height: bounds.h },
    // Share the page-space context without requesting a larger latent image
    // than the biggest single prediction this group replaces.
    workerMaxPixels: largestMemberPixels(members),
  };
}

export function prepareFluxWindowCrops(options: {
  contextPx: number;
  featherPx: number;
  height: number;
  inputMask?: Uint8Array;
  inputMaskPaddingPx?: number;
  mask: Uint8Array;
  maskPaddingPx: number;
  maxPixels: number;
  cropStrategy: FluxCropStrategy;
  width: number;
  window: PixelRect;
  isolatedReference?: boolean;
}): FluxPreparedCrop[] {
  if (!rectHasMask(options.mask, options.width, options.window)) {
    return [];
  }
  const maskBounds = maskBoundsInRect(
    options.mask,
    options.width,
    options.window,
  );
  if (!maskBounds) {
    return [];
  }
  const paddedBounds = options.isolatedReference
    ? options.window
    : alignRectToMultiple(
        expandRect(
          maskBounds,
          options.width,
          options.height,
          options.contextPx + options.maskPaddingPx,
        ),
        options.width,
        options.height,
        FLUX_INPAINT_MULTIPLE,
      );
  const tiles = resolveCropTiles(options, maskBounds, paddedBounds);
  return tiles.flatMap(({ cropBounds, writeBounds }) => {
    const localMask = buildLocalMask(
      options.inputMask ?? options.mask,
      options.width,
      cropBounds,
      options.inputMaskPaddingPx ?? options.maskPaddingPx,
    );
    if (!localMask.some((value) => value > 0)) {
      return [];
    }
    return [
      {
        localMask,
        paddedBounds: cropBounds,
        processSize:
          options.cropStrategy !== "resize"
            ? { width: cropBounds.w, height: cropBounds.h }
            : resolveFluxProcessSize(
                cropBounds.w,
                cropBounds.h,
                options.maxPixels,
                FLUX_INPAINT_MULTIPLE,
              ),
        validationMask: buildValidationMask(
          options.mask,
          options.width,
          cropBounds,
          writeBounds,
        ),
        writeBounds,
      },
    ];
  });
}

function resolveCropTiles(
  options: Parameters<typeof prepareFluxWindowCrops>[0],
  maskBounds: PixelRect,
  paddedBounds: PixelRect,
) {
  if (
    options.cropStrategy !== "native-tiled" ||
    (paddedBounds.w <= FLUX_METAL_TILE_SIZE_PX &&
      paddedBounds.h <= FLUX_METAL_TILE_SIZE_PX)
  ) {
    return [{ cropBounds: paddedBounds, writeBounds: paddedBounds }];
  }
  return resolveContextTiles(
    expandRect(maskBounds, options.width, options.height, options.featherPx),
    options.width,
    options.height,
    FLUX_METAL_TILE_SIZE_PX,
    options.contextPx + options.maskPaddingPx,
    FLUX_INPAINT_MULTIPLE,
  );
}

function buildValidationMask(
  mask: Uint8Array,
  pageWidth: number,
  cropBounds: PixelRect,
  writeBounds: PixelRect,
): Uint8Array {
  const validationMask = buildLocalMask(mask, pageWidth, cropBounds, 0);
  const startX = Math.max(0, writeBounds.x - cropBounds.x);
  const startY = Math.max(0, writeBounds.y - cropBounds.y);
  const endX = Math.min(cropBounds.w, startX + writeBounds.w);
  const endY = Math.min(cropBounds.h, startY + writeBounds.h);
  for (let y = 0; y < cropBounds.h; y += 1) {
    for (let x = 0; x < cropBounds.w; x += 1) {
      if (x < startX || x >= endX || y < startY || y >= endY) {
        validationMask[y * cropBounds.w + x] = 0;
      }
    }
  }
  return validationMask;
}
