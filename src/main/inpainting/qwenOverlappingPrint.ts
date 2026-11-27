import type {
  FluxInpaintRunOptions,
  FluxWindowProcessArgs,
} from "./fluxEngineRunnerTypes";
import type { FluxPreparedCrop } from "./fluxCropTiling";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import {
  pointInRect,
  rectsTouchOrOverlap,
  type PixelRect,
} from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { flatSpotColour } from "./qwenSpotColour";

import { isRestoredBrushPrint } from "./qwenRepeatedBrush";

const masthead = (kind: unknown) =>
  typeof kind === "string" && kind.startsWith("masthead");
const edition = (kind: unknown) =>
  typeof kind === "string" && kind.startsWith("edition:");

function bothBuffersWhite(bitmap: Buffer, contextBitmap: Buffer, at: number) {
  return (
    bitmap[at + 3] === 255 &&
    contextBitmap[at + 3] === 255 &&
    Math.min(
      bitmap[at],
      bitmap[at + 1],
      bitmap[at + 2],
      contextBitmap[at],
      contextBitmap[at + 1],
      contextBitmap[at + 2],
    ) >= 253
  );
}

export function areWhitePrintCropsRestored(
  args: FluxWindowProcessArgs,
  crops: FluxPreparedCrop[],
) {
  if (args.cropStrategy !== "worker-resize") return false;
  const selection = args.runOptions.windowMasks?.[args.index];
  const brush =
    args.runOptions.illustratedTitleWindows?.[args.index] === "brush";
  return crops.every(
    (crop) =>
      isRestoredWhitePrint(args, crop, selection) ||
      (brush &&
        !!selection &&
        isRestoredBrushPrint(
          args,
          crop,
          projectWindowMask(selection, crop.paddedBounds),
        )),
  );
}

/** A second selection can cover ink already erased on white stock. Require
 * evidence of the ink in the original and of its removal in both page buffers. */
export function isRestoredWhitePrint(
  {
    width,
    bitmap,
    contextBitmap,
    sourceBitmap,
  }: Pick<
    FluxWindowProcessArgs,
    "width" | "bitmap" | "contextBitmap" | "sourceBitmap"
  >,
  {
    paddedBounds,
    localMask,
    validationMask,
  }: Pick<FluxPreparedCrop, "paddedBounds" | "localMask" | "validationMask">,
  originalSelection?: InpaintingWindowMask,
) {
  const originalMask =
    originalSelection && projectWindowMask(originalSelection, paddedBounds);
  let erased = 0;
  for (let i = 0; i < localMask.length; i++) {
    const remaining = localMask[i] || validationMask[i];
    if (!remaining && !originalMask?.[i]) continue;
    const at =
      4 *
      ((paddedBounds.y + Math.floor(i / paddedBounds.w)) * width +
        paddedBounds.x +
        (i % paddedBounds.w));
    if (!bothBuffersWhite(bitmap, contextBitmap, at)) {
      if (remaining) return false;
      continue;
    }
    if (
      sourceBitmap[at + 3] === 255 &&
      Math.max(sourceBitmap[at], sourceBitmap[at + 1], sourceBitmap[at + 2]) <
        172
    )
      erased++;
  }
  return erased >= 6;
}

/** The upper illustration can use the already cleaned issue as its reference. */
export function overlappingPrintOrder(
  options: FluxInpaintRunOptions,
  count: number,
) {
  const order =
    options.windowProcessingOrder ?? Array.from({ length: count }, (_, i) => i);
  const kinds = options.illustratedTitleWindows,
    masks = options.compositeMasks;
  if (!kinds || !masks || !kinds.some(masthead)) return order;
  const result = [...order];
  for (const id of order.filter((i) => masthead(kinds[i]))) {
    const before = result.indexOf(id);
    let last = before;
    for (const [position, peer] of result.entries())
      if (
        position > last &&
        edition(kinds[peer]) &&
        rectsTouchOrOverlap(masks[id].bounds, masks[peer].bounds)
      )
        last = position;
    if (before < last) {
      result.splice(before, 1);
      result.splice(last, 0, id);
    }
  }
  return result;
}

type PageBuffers = Pick<
  FluxWindowProcessArgs,
  "index" | "bitmap" | "sourceBitmap" | "width" | "runOptions" | "cropStrategy"
>;

/** The issue detector can claim part of the logo in its rectangular mask.
 * Blend the registered logo view only where the displayed issue still carries
 * original spot ink and both selected imprints allow the same write. */
export function reconcileOverlappingPrint(
  args: PageBuffers,
  crop: FluxPreparedCrop,
  generated: Buffer,
) {
  const { runOptions: options, index, width, bitmap, sourceBitmap } = args;
  const core = options.windowMasks?.[index];
  if (
    args.cropStrategy !== "worker-resize" ||
    !masthead(options.illustratedTitleWindows?.[index]) ||
    !core
  )
    return;
  const bounds = crop.paddedBounds,
    { w, h } = bounds;
  if (w * h > 1_500_000) return;
  const shared = sharedPrintArea(options, index, bounds);
  if (!shared) return;
  const originalInk = projectWindowMask(core, bounds);
  const pageOffset = (i: number) =>
    4 * ((bounds.y + Math.floor(i / w)) * width + bounds.x + (i % w));
  const colour = flatSpotColour(w, h, (x, y) => {
    const i = y * w + x,
      at = pageOffset(i);
    return originalInk[i]
      ? [sourceBitmap[at], sourceBitmap[at + 1], sourceBitmap[at + 2]]
      : [0, 0, 0];
  });
  if (!colour) return;
  const error = (pixels: Buffer, at: number) =>
    Math.hypot(
      pixels[at] - colour[0],
      pixels[at + 1] - colour[1],
      pixels[at + 2] - colour[2],
    );
  const spot = originalInk.map((on, i) =>
    Number(on && error(sourceBitmap, pageOffset(i)) < 90),
  );
  const toSpot = distanceToMask(spot, w, h);
  const remnant = shared.map((on, i) => {
    if (!on || toSpot[i] >= 9) return 0;
    const seen = error(bitmap, pageOffset(i));
    return Number(seen < 155 && error(generated, 4 * i) > seen + 65);
  });
  if (!remnant.some(Boolean)) return;
  const toRemnant = distanceToMask(remnant, w, h);
  const radius = Math.max(24, Math.min(80, 0.36 * core.bounds.h));
  const fade = (d: number) =>
    Math.min(1, Math.max(0, (radius - d) / (radius * 0.48)));
  shared.forEach((on, i) => {
    if (!on) return;
    const x = bounds.x + (i % w),
      y = bounds.y + Math.floor(i / w);
    if (!pointInRect({ x, y }, crop.writeBounds)) return;
    const weight = fade(toRemnant[i]) * fade(toSpot[i]);
    if (!weight) return;
    const at = pageOffset(i);
    for (let c = 0; c < 3; c++)
      bitmap[at + c] = Math.round(
        bitmap[at + c] * (1 - weight) + generated[i * 4 + c] * weight,
      );
  });
}

function sharedPrintArea(
  options: FluxInpaintRunOptions,
  index: number,
  bounds: PixelRect,
) {
  const masks = options.compositeMasks;
  if (!masks) return;
  const peers = masks
    .map((mask, i) =>
      edition(options.illustratedTitleWindows?.[i]) &&
      rectsTouchOrOverlap(bounds, mask.bounds)
        ? i
        : -1,
    )
    .filter((i) => i >= 0);
  if (!peers.length) return;
  const selected = (i: number) => {
    const ink = projectWindowMask(masks[i], bounds);
    const constraint = options.compositeConstraints?.[i];
    if (!constraint) return ink;
    const limit = projectWindowMask(constraint, bounds);
    return ink.map((on, p) => Number(on && limit[p]));
  };
  const allowed = selected(index);
  const shared = new Uint8Array(bounds.w * bounds.h);
  for (const peer of peers) {
    selected(peer).forEach((on, p) => {
      if (on && allowed[p]) shared[p] = 1;
    });
  }
  return shared.some(Boolean) ? shared : undefined;
}
