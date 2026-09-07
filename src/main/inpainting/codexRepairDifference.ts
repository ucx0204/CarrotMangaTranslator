import type { Raster } from "../pipeline/codexTypesettingPixelSampling";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import {
  horizontalMaskDistances,
  distanceToContour,
} from "../../shared/codexTypesettingBlend";

/** Compare tone at two scales, so resampling dots and JPEG noise are not repairs. */
export function codexRepairDifference(
  original: Raster,
  generated: Raster,
  permission: Uint8Array,
  paintedCore?: Uint8Array,
) {
  if (
    original.width !== generated.width ||
    original.height !== generated.height ||
    permission.length !== original.width * original.height
  )
    throw new Error("배경 차이 입력의 해상도가 다릅니다.");
  const fine = toneDifference(original, generated, 1);
  const coarse = toneDifference(original, generated, 3);
  const thresholds = {
    fine: noiseThreshold(fine, permission, 24),
    coarse: noiseThreshold(coarse, permission, 14),
  };
  const seed = new Uint8Array(permission.length);
  for (let at = 0; at < seed.length; at++)
    if (
      permission[at] &&
      fine[at] > thresholds.fine &&
      coarse[at] > thresholds.coarse
    )
      seed[at] = 1;
  if (paintedCore)
    for (let at = 0; at < seed.length; at++)
      if (paintedCore[at] && permission[at]) seed[at] = 1;
  return {
    seed,
    thresholds,
    ...featherChanges(
      seed,
      permission,
      original.width,
      original.height,
      paintedCore,
    ),
  };
}

function featherChanges(
  seed: Uint8Array,
  permission: Uint8Array,
  width: number,
  height: number,
  paintedCore?: Uint8Array,
) {
  const core = dilateBinaryMaskDisk(seed, width, height, 2);
  const bounds = { x: 0, y: 0, w: width, h: height };
  const radius = Math.max(
    4,
    Math.min(10, Math.round(Math.min(width, height) / 70)),
  );
  const distances = horizontalMaskDistances(
    { bounds, data: core },
    bounds,
    radius,
  );
  const outside = Uint8Array.from(permission, (value) => (value ? 0 : 1));
  const boundary = horizontalMaskDistances(
    { bounds, data: outside },
    bounds,
    radius,
  );
  const opacity = new Float64Array(seed.length);
  let changedPixels = 0;
  for (let at = 0; at < seed.length; at++) {
    if (!permission[at]) continue;
    const x = at % width,
      y = Math.floor(at / width);
    const distance = distanceToContour(distances, bounds, x, y, radius);
    const edge = distanceToContour(boundary, bounds, x, y, radius);
    opacity[at] = smoothStep(1 - distance / radius) * smoothStep(edge / radius);
    if (paintedCore?.[at]) opacity[at] = 1;
    if (opacity[at]) changedPixels++;
  }
  return { opacity, changedPixels };
}

function smoothStep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function noiseThreshold(
  values: Float32Array,
  permission: Uint8Array,
  floor: number,
) {
  const context: number[] = [];
  const stride = Math.max(1, Math.ceil(values.length / 12000));
  for (let at = 0; at < values.length; at += stride)
    if (!permission[at]) context.push(values[at]);
  // A crop that is entirely selected has no independent noise calibration.
  if (context.length < 32) return floor;
  context.sort((a, b) => a - b);
  const median = context[Math.floor(context.length / 2)];
  const upper = context[Math.floor(context.length * 0.75)];
  return Math.max(floor, median + 3 * (upper - median));
}

function toneDifference(left: Raster, right: Raster, radius: number) {
  const count = left.width * left.height;
  const difference = new Float32Array(count);
  for (let channel = 0; channel < 3; channel++) {
    const a = averageChannel(left, channel, radius);
    const b = averageChannel(right, channel, radius);
    for (let at = 0; at < count; at++)
      difference[at] = Math.max(difference[at], Math.abs(a[at] - b[at]));
  }
  return difference;
}

function averageChannel(image: Raster, channel: number, radius: number) {
  const { width, height } = image;
  const stride = width + 1;
  const summed = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += image.data[(y * width + x) * 4 + channel];
      summed[(y + 1) * stride + x + 1] = summed[y * stride + x + 1] + row;
    }
  }
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius),
      bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius),
        right = Math.min(width, x + radius + 1);
      values[y * width + x] =
        (summed[bottom * stride + right] -
          summed[top * stride + right] -
          summed[bottom * stride + left] +
          summed[top * stride + left]) /
        ((bottom - top) * (right - left));
    }
  }
  return values;
}
