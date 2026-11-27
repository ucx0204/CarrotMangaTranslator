import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { smoothPrintTone } from "./qwenPrintTone";

const unit = (v: number) => Math.min(1, Math.max(0, v));
const pitch = 4;

function stockView(gray: Uint8Array, bounds: PixelRect) {
  const tone = smoothPrintTone(Float32Array.from(gray), bounds);
  const texture = smoothPrintTone(
    tone.map((v, i) => Math.abs(gray[i] - v)),
    bounds,
  );
  return { gray, tone, texture };
}

function exposedStock(
  source: ReturnType<typeof stockView>,
  edit: ReturnType<typeof stockView>,
  gap: Float32Array,
) {
  return Uint8Array.from(gap, (d, i) =>
    Number(
      d > 2.7 &&
        d < 23 &&
        source.tone[i] > 92 &&
        source.tone[i] < 230 &&
        edit.tone[i] > 83 &&
        edit.tone[i] < 237 &&
        Math.abs(source.tone[i] - edit.tone[i]) < 29 &&
        source.texture[i] < 4.8 &&
        edit.texture[i] < 5.5 &&
        Math.abs(source.gray[i] - source.tone[i]) < 9 &&
        Math.abs(edit.gray[i] - edit.tone[i]) < 10,
    ),
  );
}

type NativeBank = {
  width: number;
  height: number;
  use: Uint8Array;
  reference: Float32Array;
  delta: Float32Array;
};

function measuredOffset(bank: NativeBank, cx: number, cy: number) {
  const level = bank.reference[cy * bank.width + cx];
  const weight = [0, 0],
    sum = [0, 0],
    squares = [0, 0];
  for (
    let y = Math.max(0, cy - 14);
    y <= Math.min(bank.height - 1, cy + 14);
    y++
  ) {
    for (
      let x = Math.max(0, cx - 14);
      x <= Math.min(bank.width - 1, cx + 14);
      x++
    ) {
      const i = y * bank.width + x;
      if (!bank.use[i]) continue;
      const w = unit(1 - Math.abs(bank.reference[i] - level) / 25);
      const half = ((x >> 2) + (y >> 2)) % 2;
      weight[half] += w;
      sum[half] += w * bank.delta[i];
      squares[half] += w * bank.delta[i] ** 2;
    }
  }
  if (Math.min(...weight) < 5) return 0;
  const means = sum.map((v, i) => v / weight[i]);
  const spread = Math.sqrt(
    Math.max(0, ...squares.map((v, i) => v / weight[i] - means[i] ** 2)),
  );
  const confidence =
    unit(Math.min(...weight) / 12) *
    unit((5 - Math.abs(means[0] - means[1])) / 3) *
    unit((9.5 - spread) / 5);
  return confidence * Math.max(-20, Math.min(20, (means[0] + means[1]) / 2));
}

function sampleOffsets(
  bank: NativeBank,
  inner: Float32Array,
  gap: Float32Array,
) {
  const w = Math.ceil((bank.width - 1) / pitch) + 1;
  const h = Math.ceil((bank.height - 1) / pitch) + 1;
  const values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.min(bank.width - 1, x * pitch);
      const cy = Math.min(bank.height - 1, y * pitch);
      const i = cy * bank.width + cx;
      if (inner[i] < 25 && gap[i] < 10)
        values[y * w + x] = measuredOffset(bank, cx, cy);
    }
  }
  return { w, h, values: smoothPrintTone(values, { x: 0, y: 0, w, h }) };
}

/** Match the brightness of a decoded publisher plate to exposed stock at its
 * actual paste boundary. Separate sets of unprinted scan samples must agree. */
export function matchCoverStock(
  source: Buffer,
  stride: number,
  generated: Buffer,
  bounds: PixelRect,
  core: InpaintingWindowMask,
) {
  const { w, h } = bounds;
  if (w * h > 1_500_000 || Math.min(w, h) < 64) return;
  const mask = projectWindowMask(core, bounds);
  const native = stockView(nativeLuminance(source, stride, bounds), bounds);
  let dark = 0,
    white = 0,
    coloured = 0;
  mask.forEach((v, i) => {
    if (!v) return;
    dark += Number(native.gray[i] < 125);
    white += Number(native.gray[i] > 243);
    const p =
      4 * ((bounds.y + Math.floor(i / w)) * stride + bounds.x + (i % w));
    coloured += Number(
      Math.max(source[p], source[p + 1], source[p + 2]) -
        Math.min(source[p], source[p + 1], source[p + 2]) >
        12,
    );
  });
  if (dark < 160 || white < 500 || coloured > 0.015 * (dark + white)) return;
  const edit = stockView(
    nativeLuminance(generated, w, { ...bounds, x: 0, y: 0 }),
    bounds,
  );
  const gap = distanceToMask(mask, w, h);
  const inner = distanceToMask(
    mask.map((v) => 1 - v),
    w,
    h,
  );
  const bank = {
    width: w,
    height: h,
    use: exposedStock(native, edit, gap),
    reference: edit.tone,
    delta: native.tone.map((v, i) => v - edit.tone[i]),
  };
  const offsets = sampleOffsets(bank, inner, gap);
  mask.forEach((v, i) => {
    if (!v || inner[i] >= 19 || native.gray[i] === edit.gray[i]) return;
    const x = (i % w) / pitch,
      y = Math.floor(i / w) / pitch;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const value = (row: number) => {
      const at = Math.min(row, offsets.h - 1) * offsets.w;
      const left = offsets.values[at + x0];
      const right = offsets.values[at + Math.min(x0 + 1, offsets.w - 1)];
      return left + (right - left) * (x - x0);
    };
    const top = value(y0);
    const bias =
      (top + (value(y0 + 1) - top) * (y - y0)) * unit((19 - inner[i]) / 7);
    for (let channel = 0; channel < 3; channel++) {
      const at = 4 * i + channel;
      generated[at] = Math.max(
        0,
        Math.min(255, Math.round(generated[at] + bias)),
      );
    }
  });
}
