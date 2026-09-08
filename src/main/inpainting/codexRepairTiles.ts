import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import type { InpaintingEngine } from "./inpaintingEngine";
import type { CodexErasureTarget } from "../application/codexTypesettingContracts";
import { bboxOverlapRatio } from "../../shared/geometry";
import {
  expandRect,
  rectHasMask,
  resolveContextTiles,
  type ContextTile,
  type PixelRect,
} from "./maskGeometry";

/** GPT Image 2 accepts at most 3:1. Split native context BEFORE generation. */
export function planCodexRepairTiles(
  window: PixelRect,
  width: number,
  height: number,
  mask: Uint8Array,
): ContextTile[] {
  const crop = expandRect(
    window,
    width,
    height,
    Math.max(48, Math.ceil(Math.max(window.w, window.h) * 0.35)),
  );
  const short = Math.min(crop.w, crop.h);
  if (Math.max(crop.w, crop.h) <= short * 3)
    return [{ cropBounds: crop, writeBounds: crop }];
  // Existing native context tiling; no synthetic padding or output reframing.
  // 2:1 leaves room for overlap even when the page clips the short axis.
  return resolveContextTiles(
    crop,
    width,
    height,
    short * 2,
    Math.floor(short * 0.15),
    1,
  ).filter(({ writeBounds }) => rectHasMask(mask, width, writeBounds));
}

export function prepareCodexRepairMask(
  mask: Uint8Array,
  width: number,
  height: number,
  options: Parameters<InpaintingEngine["inpaint"]>[5],
) {
  const mode = options?.codexMaskMode ?? "paint";
  const feather = Math.max(
    0,
    Math.min(24, Math.round(options?.featherPx ?? 8)),
  );
  return {
    mode,
    feather,
    paintedCore: mode === "paint" ? mask : undefined,
    mask:
      mode === "paint"
        ? dilateBinaryMaskDisk(mask, width, height, feather)
        : mask,
  };
}

/** A neighboring reading crossing the window is context, not another erase target. */
export function prepareCodexErasureTargets(
  targets: CodexErasureTarget[] | undefined,
  cropBounds: PixelRect,
  window: PixelRect,
): CodexErasureTarget[] | undefined {
  return targets
    ?.filter(
      (target) =>
        bboxOverlapRatio(target.bounds, window) === 1 &&
        bboxOverlapRatio(target.bounds, cropBounds) > 0,
    )
    .map((target) => ({
      ...target,
      bounds: {
        ...target.bounds,
        x: target.bounds.x - cropBounds.x,
        y: target.bounds.y - cropBounds.y,
      },
    }));
}
