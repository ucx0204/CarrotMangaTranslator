import type { PixelRect } from "./maskGeometry";
import {
  measureShadedPrintTone,
  measureWhiteShoulders,
  shortPublisherShoulders,
  smoothPrintTone,
} from "./qwenPrintTone";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import { median } from "./qwenSoundRim";

type Profile = (step: number, normal: number) => number;
const steps = Array.from({ length: 22 }, (_, j) => j - 7);
const left = [-6, -4, -3];
const right = [3, 4, 6];

/** A white press backing can bleach a drawn pen as it enters the title.
 * Measure the trough and both grey banks while they are still visible. */
function continueFadingPrintPen(
  gray: Uint8Array,
  bounds: PixelRect,
  distance: Float32Array,
) {
  const { w, h } = bounds;
  const fine = smoothPrintTone(
    Float32Array.from(gray),
    bounds,
    "fine-pen",
    0.62,
  );
  const added = new Uint8Array(gray.length);
  for (let y = 22; y < h - 22; y++) {
    for (let x = 22; x < w - 22; x++) {
      const i = y * w + x;
      if (gray[i] >= 152 || distance[i] < 2 || distance[i] >= 15) continue;
      const low = Math.min(
        ...[-w, 0, w].flatMap((row) =>
          [-1, 0, 1].map((col) => gray[i + row + col]),
        ),
      );
      if (gray[i] >= low + 28) continue;
      const angle = penNormal(fine, w, i);
      if (angle === undefined) continue;
      const nx = Math.cos(angle),
        ny = Math.sin(angle);
      for (const sign of [-1, 1]) {
        const at: Profile = (s, n) =>
          Math.round(y + sign * s * nx + n * ny) * w +
          Math.round(x - sign * s * ny + n * nx);
        continueAlongPen(
          (s, n) => gray[at(s, n)],
          (s, n) => distance[at(s, n)],
          at,
          added,
        );
      }
    }
  }
  return added;
}

function penNormal(level: Float32Array, width: number, center: number) {
  let xx = 0,
    yy = 0,
    xy = 0;
  for (let y = -6; y <= 6; y++) {
    for (let x = -6; x <= 6; x++) {
      const i = center + y * width + x;
      const dx = level[i + 1] - level[i - 1],
        dy = level[i + width] - level[i - width];
      const weight = Math.exp(-(x * x + y * y) / (2 * 2.15 ** 2));
      xx += weight * dx * dx;
      yy += weight * dy * dy;
      xy += weight * dx * dy;
    }
  }
  if (Math.hypot(xx - yy, 2 * xy) > 0.66 * (xx + yy))
    return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function stableBank(values: number[]) {
  const anchor = values.slice(0, 8);
  const center = median(anchor);
  const mean = anchor.reduce((sum, value) => sum + value, 0) / anchor.length;
  const variance =
    anchor.reduce((sum, value) => sum + (value - mean) ** 2, 0) / anchor.length;
  if (center >= 133 && center <= 231 && variance <= 23 ** 2) return center;
}

function penFadeEnd(read: Profile, distance: Profile) {
  const bank = (s: number, side: number[]) =>
    median(side.map((n) => read(s, n)));
  const a = steps.map((s) => bank(s, left)),
    b = steps.map((s) => bank(s, right));
  const grayA = stableBank(a),
    grayB = stableBank(b);
  if (grayA === undefined || grayB === undefined) return;
  const stroke = steps.map((s) =>
    Math.min(read(s, -1), read(s, 0), read(s, 1)),
  );
  if (stroke.slice(0, 8).filter((v) => v < 135).length < 5) return;
  if (median(stroke.slice(0, 8).map((v, j) => Math.min(a[j], b[j]) - v)) < 64)
    return;
  const pale = steps.map(
    (s, j) =>
      s >= 3 &&
      distance(s, 0) <= distance(0, 0) &&
      stroke[j] > 226 &&
      a[j] > 237 &&
      b[j] > 237,
  );
  const white = steps.filter((_, j) => pale[j]);
  if (white.length < 3) return;
  if (
    [...left, ...right].some(
      (n) => white.reduce((sum, s) => sum + read(s, n), 0) / white.length < 232,
    )
  )
    return;
  const first = white[0],
    end = Math.min(14, first + 3);
  const transition = steps.some(
    (s, j) => s >= -2 && s < first && stroke[j] > 73 && stroke[j] < 218,
  );
  const shoulder = steps.some(
    (s, j) =>
      s >= -2 &&
      s <= end &&
      ((a[j] > grayA + 8 && a[j] < 249) || (b[j] > grayB + 8 && b[j] < 249)),
  );
  if (transition && shoulder) return end;
}

function continueAlongPen(
  read: Profile,
  distance: Profile,
  at: Profile,
  result: Uint8Array,
) {
  if (![5, 8, 11, 14].some((s) => [-1, 0, 1].some((n) => distance(s, n) < 0.6)))
    return;
  if (
    [-7, -5, -3].reduce((sum, s) => sum + distance(s, 0), 0) / 3 <
    distance(0, 0) + 1.1
  )
    return;
  const end = penFadeEnd(read, distance);
  if (end === undefined) return;
  for (let n = -11; n <= 11; n++) {
    const background = median([-7, -6, -5, -4, -3, -2].map((s) => read(s, n)));
    for (let s = -2; s < end + 5; s++) {
      const level = read(s, n);
      if (
        level > background + 5 &&
        (level > 201 || Math.abs(n) < 2.1) &&
        distance(s, n) < 14.2
      )
        result[at(s, n)] = 1;
    }
  }
}

/** Follow the white imprint into an exposed shaded surface only when the
 * original scan contains a gradual falloff followed by stable background. */
export function continuePublisherGlow(
  gray: Uint8Array,
  mask: Uint8Array,
  bounds: PixelRect,
  printed?: Float32Array,
  detected?: Float32Array,
) {
  const { w, h } = bounds;
  const inner = distanceToMask(
    mask.map((v) => 1 - v),
    w,
    h,
  );
  const outer = distanceToMask(mask, w, h);
  const tone = smoothPrintTone(Float32Array.from(gray), bounds);
  const added = measureWhiteShoulders(gray, tone, mask, bounds, inner, outer);
  if (printed && detected) {
    const short = shortPublisherShoulders(
      gray,
      tone,
      mask,
      bounds,
      outer,
      printed,
      detected,
    );
    short.forEach((v, i) => {
      if (v) added[i] = 1;
    });
  }
  const shaded =
    printed &&
    detected &&
    measureShadedPrintEdge(gray, tone, mask, bounds, inner, outer);
  const pen =
    printed && detected && continueFadingPrintPen(gray, bounds, outer);
  if (!added.some(Boolean) && !shaded?.some(Boolean) && !pen?.some(Boolean))
    return mask;
  return mask.map((on, i) =>
    Number(
      on ||
        pen?.[i] ||
        shaded?.[i] ||
        (added[i] &&
          added[i - 1] + added[i + 1] + added[i - w] + added[i + w] >= 2 &&
          (!printed ||
            printed[i] < 16 ||
            (gray[i] > 210 && detected && detected[i] < 12))),
    ),
  );
}

function measureShadedPrintEdge(
  gray: Uint8Array,
  tone: Float32Array,
  mask: Uint8Array,
  bounds: PixelRect,
  inner: Float32Array,
  outer: Float32Array,
) {
  const { w, h } = bounds;
  const { eligible, taper } = measureShadedPrintTone(
    gray,
    tone,
    mask,
    bounds,
    inner,
    outer,
  );
  const connected = new Uint8Array(mask.length);
  for (const { rect, data } of maskComponents(eligible, w, h, 5)) {
    const index = (i: number) =>
      (rect.y + Math.floor(i / rect.w)) * w + rect.x + (i % rect.w);
    const white = data.some((on, i) => {
      const k = index(i);
      return on && mask[k] && inner[k] < 17 && tone[k] >= 237 && gray[k] >= 239;
    });
    if (white)
      data.forEach((on, i) => {
        if (on) connected[index(i)] = 1;
      });
  }
  const near = distanceToMask(
    taper.map((v, i) => v * connected[i]),
    w,
    h,
  );
  return connected.map((v, i) => Number(v && near[i] < 7.5));
}
