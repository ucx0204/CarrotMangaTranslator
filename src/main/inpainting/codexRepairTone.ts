import type { Raster } from "../pipeline/codexTypesettingPixelSampling";

type Sample = { value: number; delta: number };
type Knot = { value: number; corrected: number; samples: number };

/** Calibrate from preserved context, not from the glyphs being removed. */
export function matchCodexRepairTone(
  original: Raster,
  generated: Raster,
  excluded: Uint8Array,
) {
  const curves = [0, 1, 2].map((channel) =>
    channelCurve(original, generated, excluded, channel),
  );
  const output = { ...generated, data: Buffer.from(generated.data) };
  for (let at = 0; at < excluded.length; at++)
    for (let channel = 0; channel < 3; channel++)
      output.data[at * 4 + channel] = Math.round(
        correctTone(generated.data[at * 4 + channel], curves[channel]),
      );
  return { output, curves };
}

function channelCurve(
  original: Raster,
  generated: Raster,
  excluded: Uint8Array,
  channel: number,
): Knot[] {
  const bands: Sample[][] = [[], [], []];
  const stride = Math.max(1, Math.ceil(excluded.length / 12000));
  for (let at = 0; at < excluded.length; at += stride) {
    if (excluded[at]) continue;
    const value = generated.data[at * 4 + channel];
    const delta = original.data[at * 4 + channel] - value;
    // Large residuals are reconstruction or alignment errors, not a color cast.
    if (Math.abs(delta) > 24) continue;
    bands[Math.min(2, Math.floor(value / 85))].push({ value, delta });
  }
  const knots: Knot[] = [{ value: 0, corrected: 0, samples: 0 }];
  for (const samples of bands) {
    if (samples.length < 24) continue;
    const value = median(samples.map((sample) => sample.value));
    const delta = median(samples.map((sample) => sample.delta));
    if (value <= 0 || value >= 255) continue;
    knots.push({
      value,
      corrected: Math.max(0, Math.min(255, value + delta)),
      samples: samples.length,
    });
  }
  knots.push({ value: 255, corrected: 255, samples: 0 });
  return knots;
}

function median(values: number[]) {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function correctTone(value: number, knots: Knot[]) {
  const upper = knots.findIndex((knot) => knot.value >= value);
  if (upper <= 0) return value;
  const left = knots[upper - 1],
    right = knots[upper];
  const amount = (value - left.value) / (right.value - left.value);
  return left.corrected + (right.corrected - left.corrected) * amount;
}
