import type { PixelRect } from "./maskGeometry";
import { smoothPrintTone } from "./qwenPrintTone";

/** The structure tensor averages squared gradients so the two edges of the
 * same pen line vote for one direction even when their contrast is reversed. */
export function hatchOrientation(gray: Uint8Array, box: PixelRect) {
  const soften = (plane: Float32Array, sigma: number) =>
    smoothPrintTone(plane, box, "fine-pen", sigma);
  const image = soften(Float32Array.from(gray), 0.72);
  const xx = new Float32Array(gray.length),
    xy = xx.slice(),
    yy = xx.slice();
  for (let y = 1; y < box.h - 1; y++) {
    for (let x = 1; x < box.w - 1; x++) {
      const i = y * box.w + x;
      const gx = (image[i + 1] - image[i - 1]) / 2;
      const gy = (image[i + box.w] - image[i - box.w]) / 2;
      xx[i] = gx * gx;
      xy[i] = gx * gy;
      yy[i] = gy * gy;
    }
  }
  const [a, b, c] = [xx, xy, yy].map((plane) =>
    soften(soften(plane, 1.8), 1.8),
  );
  const energy = a.map((v, i) => v + c[i]);
  const coherence = a.map(
    (v, i) => Math.hypot(v - c[i], 2 * b[i]) / Math.max(0.01, energy[i]),
  );
  const angle = a.map(
    (v, i) => (1.5 * Math.PI + 0.5 * Math.atan2(2 * b[i], v - c[i])) % Math.PI,
  );
  return { energy, coherence, angle };
}

/** Measure only exposed, well-oriented print outside the selected lettering. */
export function dominantHatchAngle(
  { energy, coherence, angle }: ReturnType<typeof hatchOrientation>,
  gray: Uint8Array,
  distance: Float32Array,
) {
  const votes = new Float64Array(360);
  const edges: number[] = [];
  for (let i = 0; i < gray.length; i++) {
    if (
      distance[i] <= 6 ||
      distance[i] >= 35 ||
      energy[i] < 19 ||
      coherence[i] < 0.8 ||
      gray[i] < 50 ||
      gray[i] > 250
    )
      continue;
    const bin = Math.round((angle[i] * votes.length) / Math.PI) % votes.length;
    votes[bin] += Math.min(1.5, Math.sqrt(energy[i]) / 23);
    edges.push(i);
  }
  if (edges.length < 380) return;
  const density = votes.map((_, i) => {
    let weight = 0;
    for (let k = -25; k <= 25; k++)
      weight +=
        Math.exp(-(k * k) / 62) * votes[(i + votes.length + k) % votes.length];
    return weight;
  });
  const peak = (density.indexOf(Math.max(...density)) * Math.PI) / votes.length;
  const aligned = edges.filter(
    (i) => Math.abs(Math.sin(angle[i] - peak)) < 0.115,
  );
  if (
    aligned.length < edges.length * 0.48 ||
    Math.abs(Math.sin(2 * peak)) < 0.4
  )
    return;
  const errors = aligned
    .map((i) => {
      const d = 2 * (angle[i] - peak);
      return 0.5 * Math.atan2(Math.sin(d), Math.cos(d));
    })
    .sort((a, b) => a - b);
  return peak + errors[Math.floor(errors.length / 2)];
}
