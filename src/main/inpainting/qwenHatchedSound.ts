import { hatchBankSampler } from "./qwenHatchBanks";
import { dominantHatchAngle, hatchOrientation } from "./qwenHatchDirection";
import { printMaskGrid } from "./qwenPrintedPigment";
import { soundStencilWindow } from "./qwenRuledPaper";
import { retainTerminalPanelRule } from "./qwenSoundRim";
import type { FluxWorkerRequest } from "./fluxWorkerTypes";
import { writeNativeCrop } from "./fluxCropIO";
import { nativeImage } from "electron";

type Crop = {
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
};
type Window = NonNullable<ReturnType<typeof soundStencilWindow>>;

function hasMonochromeBanks({ box, distance }: Window, crop: Crop) {
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] > 36) continue;
    const p =
      4 * ((box.y + Math.floor(i / box.w)) * crop.width + box.x + (i % box.w));
    const [b, g, r] = crop.original.subarray(p, p + 3);
    if (
      crop.original[p + 3] !== 255 ||
      Math.max(b, g, r) - Math.min(b, g, r) > 8
    )
      return false;
  }
  return true;
}

function registeredBrush(window: Window) {
  const { gray, box, local } = window;
  const core = local.map((selected, i) => Number(!!selected && gray[i] < 140));
  if (printMaskGrid(box.w, box.h).components(core, 75).length < 3) return;
  const retained = Uint8Array.from(local, (value) => Number(Boolean(value)));
  if (
    retainTerminalPanelRule(
      { tone: gray, width: box.w, height: box.h },
      core,
      retained,
      6,
    )
  )
    return retained;
}

/** A white-keylined brush effect can interrupt parallel printed speed lines.
 * Recover their visible continuation and keep Qwen's decoded value anywhere
 * neither bank supplies native print. Unselected pixels come from the input. */
export function registerHatchedSound(crop: Crop, decoded: Buffer) {
  const window = soundStencilWindow(
    crop.original,
    crop.stencil,
    crop,
    112,
    ({ w, h }) =>
      Math.min(w, h) >= 24 &&
      Math.max(w, h) <= 480 &&
      Math.max(w, h) >= 1.55 * Math.min(w, h),
  );
  if (!window || !hasMonochromeBanks(window, crop)) return;
  const selected = registeredBrush(window);
  if (!selected) return;
  const { gray, box, local, distance } = window;
  const orientation = hatchOrientation(gray, box);
  const angle = dominantHatchAngle(orientation, gray, distance);
  if (angle === undefined) return;
  // Solid foreground ink and contours across the measured pen direction
  // act as barriers even if the far side contains similarly coloured ink.
  const grid = printMaskGrid(box.w, box.h);
  const black = grid.distance(gray.map((value) => Number(value >= 84)));
  const border = grid.distance(Uint8Array.from(black, (d) => Number(d > 1.67)));
  const risk = gray.map((_, i) =>
    Number(
      border[i] < 3.35 ||
        (orientation.coherence[i] > 0.87 &&
          orientation.energy[i] > 460 &&
          Math.abs(Math.sin(orientation.angle[i] - angle)) > 0.4),
    ),
  );
  const clean = risk.map((value, i) => Number(!value && distance[i] > 1.05));
  const obstacle = risk.map((value, i) => Number(!!value && !local[i]));
  const sample = hatchBankSampler(
    { gray, clean, obstacle, width: box.w, height: box.h },
    angle,
  );
  const result = Buffer.from(crop.original);
  selected.forEach((value, i) => {
    if (!value) return;
    const x = i % box.w,
      y = Math.floor(i / box.w);
    const p = 4 * ((box.y + y) * crop.width + box.x + x);
    const level = sample(x, y);
    if (level === undefined) decoded.copy(result, p, p, p + 3);
    else result.fill(Math.max(0, Math.min(255, Math.round(level))), p, p + 3);
  });
  return result;
}

export async function writeHatchedSound(
  request: FluxWorkerRequest,
  crop: Crop,
  decoded: Buffer,
  signal: AbortSignal,
) {
  if (request.illustratedTitle !== "brush") return false;
  const result = registerHatchedSound(crop, decoded);
  if (!result) return false;
  await writeNativeCrop(
    request.output,
    nativeImage.createFromBitmap(result, crop),
    crop.original,
    signal,
  );
  return true;
}
