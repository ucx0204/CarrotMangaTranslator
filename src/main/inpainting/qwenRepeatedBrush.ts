import type { FluxPreparedCrop } from "./fluxCropTiling";
import type { FluxWindowProcessArgs } from "./fluxEngineRunnerTypes";

type Buffers = Pick<
  FluxWindowProcessArgs,
  "bitmap" | "contextBitmap" | "sourceBitmap" | "width"
>;
type Crop = Pick<
  FluxPreparedCrop,
  "paddedBounds" | "localMask" | "validationMask"
>;
type Levels = (i: number) => {
  source: number;
  present: number;
  opaque: boolean;
};
function scanLevels(args: Buffers, b: Crop["paddedBounds"]): Levels {
  return (i: number) => {
    const at = 4 * ((b.y + Math.floor(i / b.w)) * args.width + b.x + (i % b.w));
    const { sourceBitmap, bitmap, contextBitmap } = args;
    const source = Math.max(
      sourceBitmap[at],
      sourceBitmap[at + 1],
      sourceBitmap[at + 2],
    );
    const present = Math.min(
      bitmap[at],
      bitmap[at + 1],
      bitmap[at + 2],
      contextBitmap[at],
      contextBitmap[at + 1],
      contextBitmap[at + 2],
    );
    return {
      source,
      present,
      opaque:
        bitmap[at + 3] === 255 &&
        contextBitmap[at + 3] === 255 &&
        sourceBitmap[at + 3] === 255,
    };
  };
}
function wasPreviouslyPainted(dark: number, erased: number, owned: number) {
  return dark >= 150 && erased >= 0.96 * dark && owned <= 0.08 * dark;
}
function remainingOriginalInk(ink: Uint8Array, crop: Crop, level: Levels) {
  let dark = 0,
    erased = 0,
    owned = 0;
  const surviving: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    const inWrite = crop.localMask[i] || crop.validationMask[i];
    if (!ink[i] && !inWrite) continue;
    const { source, present, opaque } = level(i);
    if (!opaque) return;
    if (source >= 168) continue;
    if (ink[i]) {
      dark++;
      erased += Number(present >= 178);
      owned += Number(!!inWrite);
    }
    if (inWrite && present < 180) surviving.push(i);
  }
  if (wasPreviouslyPainted(dark, erased, owned)) return surviving;
}
function originalStrokeField(ink: Uint8Array, level: Levels) {
  const field = new Uint8Array(ink.length),
    frontier: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    const { source, present, opaque } = level(i);
    if (!opaque || source >= 190 || present >= 198) continue;
    if (ink[i]) field[i] = 1;
    else {
      field[i] = 2;
      frontier.push(i);
    }
  }
  return { field, frontier };
}
function hasSolidFace(i: number, remnants: Uint8Array, w: number, h: number) {
  const x = i % w,
    y = Math.floor(i / w);
  if (x < 2 || y < 2 || x + 2 >= w || y + 2 >= h) return true;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      if (!remnants[i + dy * w + dx]) return false;
  return true;
}
function extendStroke(
  i: number,
  field: Uint8Array,
  frontier: number[],
  w: number,
  h: number,
) {
  const x = i % w,
    y = Math.floor(i / w);
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const j = yy * w + xx;
      if (field[j] !== 1) continue;
      field[j] = 2;
      frontier.push(j);
    }
}
/** A grouped detector can select the same lettering as several individual
 * detections. Keep the earlier results only when both buffers have lost the
 * broad original faces and each surviving mark continues into exposed art. */
export function isRestoredBrushPrint(
  args: Buffers,
  crop: Crop,
  ink: Uint8Array,
) {
  const b = crop.paddedBounds;
  if (b.w * b.h > 1_500_000) return false;
  const level = scanLevels(args, b);
  const surviving = remainingOriginalInk(ink, crop, level);
  if (!surviving) return false;
  if (!surviving.length) return true;
  const remnants = new Uint8Array(ink.length);
  for (const i of surviving) remnants[i] = 1;
  if (surviving.some((i) => hasSolidFace(i, remnants, b.w, b.h))) return false;
  const { field, frontier } = originalStrokeField(ink, level);
  // Follow the actual dark stroke in both the scan and the current drawing.
  // A separate dot inside the selection can still be an unprocessed accent.
  let start = 0;
  for (let step = 0; step < 16 && start < frontier.length; step++) {
    const end = frontier.length;
    for (; start < end; start++)
      extendStroke(frontier[start], field, frontier, b.w, b.h);
  }
  return surviving.every((i) => field[i] === 2);
}
