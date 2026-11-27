import { clamp } from "../../shared/bboxNormalization";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { printMaskGrid } from "./qwenPrintedPigment";
import { matchingDot, screenRepeatOffsets } from "./qwenDotPrint";
import { soundStencilWindow } from "./qwenRuledPaper";

type Crop = {
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
};
type Window = NonNullable<ReturnType<typeof soundStencilWindow>>;
type Donors = NonNullable<ReturnType<typeof gatherDotBank>>;
function gaussian(
  values: ArrayLike<number>,
  width: number,
  height: number,
  sigma: number,
) {
  const radius = Math.ceil(3 * sigma),
    weights = Array.from({ length: 2 * radius + 1 }, (_, n) =>
      Math.exp(-0.5 * ((n - radius) / sigma) ** 2),
    );
  const den = weights.reduce((a, b) => a + b),
    tmp = new Float32Array(values.length),
    out = new Float32Array(values.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum +=
          weights[k + radius] * values[y * width + clamp(x + k, 0, width - 1)];
      tmp[i] = sum / den;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum +=
          weights[k + radius] * tmp[clamp(y + k, 0, height - 1) * width + x];
      out[y * width + x] = sum / den;
    }
  return out;
}
function dotLevels(gray: Uint8Array, width: number, height: number) {
  const low = gaussian(gray, width, height, 2.8);
  const squared = Float32Array.from(low, (v, i) => (gray[i] - v) ** 2);
  const power = gaussian(squared, width, height, 3).map((v) => Math.sqrt(v));
  return { low, power };
}
function paleStock(level: number, power: number) {
  return level > 186 && level < 250 && power > 3 && power < 33;
}
function gatherDotBank(view: Window) {
  const { gray, box, distance } = view,
    { w, h } = box;
  const { low, power } = dotLevels(gray, w, h);
  const pen = printMaskGrid(w, h).distance(gray.map((v) => Number(v <= 155)));
  const bank = new Uint8Array(gray.length),
    train: number[] = [],
    held: number[] = [];
  for (let i = 0; i < gray.length; i++) {
    if (
      distance[i] <= 6 ||
      distance[i] > 90 ||
      pen[i] < 5 ||
      !paleStock(low[i], power[i])
    )
      continue;
    const x = i % w,
      y = Math.floor(i / w);
    if ((Math.floor(x / 9) + Math.floor(y / 12)) % 7 === 2) held.push(i);
    else {
      bank[i] = 1;
      train.push(i);
    }
  }
  if (train.length < 1200 || held.length < 200) return;
  const normalized = low.map((v, i) => (gray[i] - v) / Math.max(4, power[i]));
  const shifts = screenRepeatOffsets(
    { width: w, levels: normalized },
    bank,
    train,
    0,
  );
  if (shifts.length < 8) return;
  const scan = { width: w, gray };
  const donor = (i: number, level: number) =>
    matchingDot(
      scan,
      bank,
      shifts,
      i,
      (j) => 0.14 * Math.max(0, Math.abs(level - low[j]) - 5),
    );
  return { bank, held, low, power, donor };
}
function validatedBank(
  src: Buffer,
  offset: (i: number) => number,
  bank: Donors,
  gray: Uint8Array,
) {
  let n = 0,
    cross = 0,
    actualPower = 0,
    estimatedPower = 0;
  const error = [0, 0, 0];
  const stride = Math.max(1, Math.floor(bank.held.length / 1600));
  for (let k = 0; k < bank.held.length; k += stride) {
    const i = bank.held[k],
      j = bank.donor(i, bank.low[i]);
    if (j === undefined) continue;
    const p = offset(i),
      q = offset(j);
    for (let c = 0; c < 3; c++) error[c] += Math.abs(src[p + c] - src[q + c]);
    const a = gray[i] - bank.low[i],
      b = gray[j] - bank.low[j];
    cross += a * b;
    actualPower += a * a;
    estimatedPower += b * b;
    n++;
  }
  return (
    n >= 180 &&
    n >= 0.93 * Math.ceil(bank.held.length / stride) &&
    Math.max(...error) <= 4.5 * n &&
    cross >= 0.89 * Math.sqrt(actualPower * estimatedPower)
  );
}
const fraction = (v: number) => clamp(v, 0, 1);
function transferWeight(
  distance: number,
  pen: number,
  level: number,
  renderedPower: number,
  nativeLevel: number,
  nativePower: number,
) {
  return (
    fraction((pen - 1.4) / 2.6) *
    fraction((250 - level) / 4) *
    fraction((6.4 - distance) / 2.3) *
    fraction((13 - Math.abs(level - nativeLevel)) / 6) *
    fraction((nativePower - 3.2) / 3) *
    fraction((0.97 - renderedPower / Math.max(1, nativePower)) / 0.27)
  );
}
function lightPrintArea(distance: number, level: number, pen: number) {
  return distance < 6.4 && level > 190 && level < 250 && pen > 1.4;
}
function modulationAgreement() {
  let count = 0,
    sumDecoded = 0,
    sumSource = 0,
    decodedPower = 0,
    sourcePower = 0,
    cross = 0;
  return {
    add(decoded: number, source: number) {
      count++;
      sumDecoded += decoded;
      sumSource += source;
      decodedPower += decoded * decoded;
      sourcePower += source * source;
      cross += source * decoded;
    },
    weakened() {
      if (count < 240) return false;
      const a = decodedPower - (sumDecoded * sumDecoded) / count,
        b = sourcePower - (sumSource * sumSource) / count;
      return (
        b > 0 &&
        a > 0.08 * b &&
        a < 0.64 * b &&
        cross - (sumDecoded * sumSource) / count >= 0.7 * Math.sqrt(a * b)
      );
    },
  };
}
function patchWeakScreen(
  crop: Crop,
  view: Window,
  bank: Donors,
  offset: (i: number) => number,
  output: Buffer,
) {
  const { box, distance } = view,
    { w, h } = box;
  const decoded = nativeLuminance(output, crop.width, box),
    { low, power } = dotLevels(decoded, w, h);
  const pen = printMaskGrid(w, h).distance(
    decoded.map((v) => Number(v <= 153)),
  );
  const result = Buffer.from(output),
    agreement = modulationAgreement();
  let gained = 0,
    writes = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (!lightPrintArea(distance[i], low[i], pen[i])) continue;
    const j = bank.donor(i, low[i] + 2);
    if (j === undefined) continue;
    const weight = transferWeight(
      distance[i],
      pen[i],
      low[i],
      power[i],
      bank.low[j],
      bank.power[j],
    );
    if (weight <= 0) continue;
    const p = offset(i),
      q = offset(j);
    let diff = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(
        output[p + c] + weight * (crop.original[q + c] - output[p + c]),
      );
      diff = Math.max(diff, Math.abs(v - output[p + c]));
      result[p + c] = v;
    }
    if (weight > 0.65 && view.local[i]) {
      agreement.add(decoded[i] - low[i], view.gray[j] - bank.low[j]);
      gained += Number(diff >= 4);
    }
    if (diff) writes++;
  }
  if (writes >= 90 && gained >= 35 && agreement.weakened()) return result;
}
function hasOpaqueBrushFace(
  crop: Crop,
  view: Window,
  offset: (i: number) => number,
) {
  let dark = 0,
    selected = 0;
  for (let i = 0; i < view.gray.length; i++) {
    if (crop.original[offset(i) + 3] !== 255) return false;
    if (!view.local[i]) continue;
    selected++;
    dark += Number(view.gray[i] < 111);
  }
  return dark >= 120 && dark > 0.14 * selected;
}
/** A variable-density screen can lose its dots beside a stroke even when the
 * Qwen contour is intact. Predict intact held-out print first, then restore
 * only the weakened modulation around the lettering, protecting dark art. */
export function measuredDotModulation(crop: Crop) {
  const view = soundStencilWindow(
    crop.original,
    crop.stencil,
    crop,
    72,
    ({ w, h }) => {
      const short = Math.min(w, h),
        long = Math.max(w, h);
      return (
        short >= 22 &&
        short <= 180 &&
        long >= 90 &&
        long <= 500 &&
        long >= 1.6 * short
      );
    },
  );
  if (!view) return;
  const { box } = view;
  const offset = (i: number) =>
    4 * ((box.y + Math.floor(i / box.w)) * crop.width + box.x + (i % box.w));
  if (!hasOpaqueBrushFace(crop, view, offset)) return;
  const bank = gatherDotBank(view);
  if (!bank || !validatedBank(crop.original, offset, bank, view.gray)) return;
  for (const i of bank.held) bank.bank[i] = 1;
  return (out: Buffer) => patchWeakScreen(crop, view, bank, offset, out);
}
