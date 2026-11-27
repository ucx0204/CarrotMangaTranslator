import { soundPenProof } from "./qwenSoundPen";
import { agreesWithFadingPaper } from "./qwenFadingPaper";
import { marginCaptionPlate } from "./qwenMarginCaption";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import type { QwenControlCrop } from "./qwenControlCrop";
import type { readNativeCropInputs } from "./fluxCropIO";
import type { FluxWorkerRequest } from "./fluxWorkerTypes";
import { controlConditionMask } from "./qwenControlReferences";
import type { QwenSamplingCrop } from "./qwenControlSampling";

/** A native guide can resolve a small hole in paper or a stationary print
 * texture. Check the predicted interior and the transition across the original
 * mask before permitting it to replace diffusion. */
export function agreesWithPrintBanks(
  guide: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const values = [new Uint32Array(16), new Uint32Array(16)];
  const count = [0, 0],
    edge = [0, 0],
    energy = [0, 0];
  let seams = 0,
    jumps = 0;
  for (let y = 2; y < height - 2; y += 2)
    for (let x = 2; x < width - 2; x += 2) {
      const i = y * width + x,
        core = Number(stencil[i] > 0);
      if (!core && !nearMask(stencil, x, y, width, height)) continue;
      const v = gray(guide, i),
        dx = Math.abs(v - gray(guide, i + 1)),
        dy = Math.abs(v - gray(guide, i + width));
      values[core][Math.min(15, v >> 4)]++;
      count[core]++;
      energy[core] += Math.min(100, dx + dy);
      edge[core] += Number(dx + dy > 30);
      if (core && isMaskRim(stencil, i, width)) {
        seams++;
        jumps += Number(dx + dy > 65);
      }
    }
  return reliableBanks(values, count, edge, energy, seams, jumps);
}

function isMaskRim(mask: Uint8Array, i: number, w: number) {
  return !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];
}

function reliableBanks(
  values: Uint32Array[],
  count: number[],
  edge: number[],
  energy: number[],
  seams: number,
  jumps: number,
) {
  if (Math.min(...count) < 35) return false;
  let distance = 0;
  for (let i = 0; i < 16; i++)
    distance += Math.abs(values[0][i] / count[0] - values[1][i] / count[1]);
  const outer = edge[0] / count[0],
    inner = edge[1] / count[1];
  const contrast = energy[0] / count[0],
    predicted = energy[1] / count[1];
  return (
    distance < 0.64 &&
    inner + 0.025 >= 0.45 * outer &&
    predicted + 2 >= 0.44 * contrast &&
    inner < outer * 2 + 0.08 &&
    jumps < Math.max(4, seams * (outer + 0.15))
  );
}

function gray(data: Buffer, i: number) {
  const at = i * 4;
  return (data[at] + 2 * data[at + 1] + data[at + 2]) >> 2;
}

function nearMask(
  mask: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const reach = 9;
  return !!(
    mask[y * w + Math.max(0, x - reach)] ||
    mask[y * w + Math.min(w - 1, x + reach)] ||
    mask[Math.max(0, y - reach) * w + x] ||
    mask[Math.min(h - 1, y + reach) * w + x]
  );
}

function canUseMeasuredGuide(crop: QwenSamplingCrop) {
  if (crop.pairedWindow || crop.titleSource || crop.registered) return false;
  if (!crop.referenceEdit) return !crop.sourceReference;
  return [
    "lettering",
    "caption",
    "drawnCloth",
    "paperEdgeCaption",
    "screenedMolding",
  ].includes(crop.referenceEdit);
}

function isUnregisteredReading(
  crop: QwenSamplingCrop,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
) {
  return (
    !crop.referenceEdit &&
    !crop.material &&
    !crop.sourceReference &&
    shortGrayReading(inputs)
  );
}

function measuredFade(
  crop: QwenSamplingCrop,
  request: FluxWorkerRequest,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
  pixels: Buffer,
) {
  return (
    (crop.referenceEdit === "lettering" || !!request.speechBubble) &&
    agreesWithFadingPaper(inputs, pixels)
  );
}
function crossesDrawnLine(
  crop: QwenSamplingCrop,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
) {
  return (
    crop.referenceEdit === "lettering" &&
    hasLongInkBanks(
      inputs.original,
      inputs.stencil,
      inputs.width,
      inputs.height,
    )
  );
}

function registeredPaper(
  crop: QwenSamplingCrop,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
) {
  if (crop.referenceEdit === "caption") return marginCaptionPlate(inputs);
  if (crop.referenceEdit !== "effect") return;
  const pen = soundPenProof(inputs);
  if (pen) return (pixels: Buffer) => (pen(pixels) ? pixels : undefined);
}

export async function measuredGuide(
  control: QwenControlCrop | undefined,
  crop: Awaited<ReturnType<QwenControlCrop["prepare"]>> | undefined,
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
  request: FluxWorkerRequest,
  signal: AbortSignal,
) {
  if (!control || !crop) return;
  const nativeMask = () =>
    controlConditionMask(inputs.stencil, inputs.source.getSize(), false);
  const loadPrior = async () =>
    (
      await control.substrate.restoreStencil(
        inputs.source,
        nativeMask(),
        request.input,
        signal,
      )
    ).toBitmap();
  const special = registeredPaper(crop, inputs);
  if (special) {
    const restored = special(await loadPrior());
    if (restored) return restored;
  }
  if (!canUseMeasuredGuide(crop)) return;
  const { source, stencil } = inputs;

  const pixels = crop.sourceReference
    ? await loadPrior()
    : crop.prior.toBitmap();
  if (measuredFade(crop, request, inputs, pixels)) return pixels;
  if (crossesDrawnLine(crop, inputs)) return;
  if (agreesWithPrintBanks(pixels, stencil, inputs.width, inputs.height))
    return pixels;
  if (isUnregisteredReading(crop, inputs)) {
    const mask = nativeMask(),
      wide = dilateBinaryMaskDisk(mask, inputs.width, inputs.height, 4);
    const second = await control.substrate.restoreStencil(
      source,
      wide,
      request.input,
      signal,
    );
    if (predictsHeldOutPaper(inputs.original, second.toBitmap(), mask, wide))
      return pixels;
  }
}

// Lines entering the stencil are independently observed drawing. Histograms
// alone cannot distinguish a bent contour from the original straight edge.
function hasLongInkBanks(
  original: Buffer,
  mask: Uint8Array,
  w: number,
  h: number,
) {
  let evidence = 0;
  for (let y = 12; y < h - 12; y += 2)
    for (let x = 12; x < w - 12; x += 2) {
      const i = y * w + x;
      if (mask[i] || !nearMask(mask, x, y, w, h)) continue;
      const value = gray(original, i);
      if (value > 190) continue;
      if (followsPen(original, i, w)) evidence++;
      if (evidence >= 5) return true;
    }
  return false;
}

function followsPen(bytes: Buffer, i: number, w: number) {
  for (const [dx, dy] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 1],
    [2, 1],
    [-2, 1],
    [1, 2],
    [-1, 2],
  ]) {
    const step = dx + dy * w,
      side = dy - dx * w;
    if (
      [-4, -2, 0, 2, 4].every((t) => {
        const p = i + t * step,
          mid = gray(bytes, p);
        return (
          Math.max(gray(bytes, p - 2 * side), gray(bytes, p + 2 * side)) - mid >
          35
        );
      })
    )
      return true;
  }
  return false;
}

function shortGrayReading(
  inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
) {
  const { original, stencil, inkBounds: box } = inputs;
  if (!box || box.h < 2.4 * box.w || box.h > 190 || box.w > 68 || box.w < 12)
    return false;
  let dark = 0,
    neutral = 0,
    total = 0;
  for (let i = 0; i < stencil.length; i += 2) {
    if (!stencil[i]) continue;
    const at = 4 * i,
      g = original[at + 1],
      r = original[at + 2],
      b = original[at];
    dark += Number(g < 150);
    neutral += Number(Math.max(r, g, b) - Math.min(r, g, b) <= 3);
    total++;
  }
  return total > 100 && neutral > 0.99 * total && dark > 0.2 * total;
}

export function predictsHeldOutPaper(
  source: Buffer,
  prediction: Buffer,
  mask: Uint8Array,
  wide: Uint8Array,
) {
  let count = 0,
    total = 0,
    bad = 0,
    edge = 0,
    edgeMiss = 0;
  for (let i = 0; i < wide.length; i++) {
    if (!wide[i] || mask[i]) continue;
    const v = gray(source, i),
      e = Math.abs(v - gray(prediction, i));
    count++;
    total += e;
    bad += Number(e > 48);
    if (v < 151) {
      edge++;
      edgeMiss += Number(e > 72);
    }
  }
  return (
    count > 150 &&
    total < 14 * count &&
    bad < 0.057 * count &&
    edge >= 10 &&
    edgeMiss < 0.22 * edge
  );
}
