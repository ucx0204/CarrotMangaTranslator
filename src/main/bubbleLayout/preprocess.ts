import { KOHARU_LAYOUT_INPUT_SIZE } from "./constants";

export type PreparedComicDetectorImage = {
  imageWidth: number;
  imageHeight: number;
  rgbChw: Float32Array;
};

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export function prepareComicDetectorImage(
  image: Electron.NativeImage,
  signal?: AbortSignal,
): PreparedComicDetectorImage {
  throwIfAborted(signal);
  const { width: imageWidth, height: imageHeight } = image.getSize();
  if (!imageWidth || !imageHeight) {
    throw new Error("KoharuLayout 입력 이미지 크기가 올바르지 않습니다.");
  }
  return {
    imageWidth,
    imageHeight,
    rgbChw: convertBgraBitmapToRgbChw(
      image.toBitmap(),
      imageWidth,
      imageHeight,
      signal,
      KOHARU_LAYOUT_INPUT_SIZE,
    ),
  };
}

// Each row describes the source pixels contributing to one destination pixel.
// Downsampling integrates pixel area; upsampling interpolates pixel centres.
function resizeWeights(input: number, output: number) {
  const scale = input / output;
  return Array.from({ length: output }, (_, destination) => {
    if (scale <= 1) {
      const point = Math.max(
        0,
        Math.min(input - 1, (destination + 0.5) * scale - 0.5),
      );
      const first = Math.floor(point);
      const fraction = point - first;
      return { first, weights: fraction ? [1 - fraction, fraction] : [1] };
    }
    const start = destination * scale;
    const end = Math.min(input, (destination + 1) * scale);
    const first = Math.floor(start);
    const weights = Array.from(
      { length: Math.ceil(end) - first },
      (_, offset) =>
        (Math.min(end, first + offset + 1) - Math.max(start, first + offset)) /
        scale,
    );
    return { first, weights };
  });
}

function roundEven(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}

function weightedSample(
  pixels: Uint8Array | Float32Array,
  offset: number,
  stride: number,
  weights: readonly number[],
): number {
  let value = 0;
  for (let i = 0; i < weights.length; i++)
    value += weights[i] * pixels[offset + i * stride];
  return value;
}

/** BGRA to ImageNet RGB, letterboxed at the top left of a white canvas. */
export function convertBgraBitmapToRgbChw(
  bitmap: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
  canvasSide?: number,
): Float32Array {
  assertBitmapDimensions(bitmap, width, height);
  throwIfAborted(signal);
  const scale = canvasSide ? canvasSide / Math.max(width, height) : 1;
  const resizedWidth = Math.max(1, roundEven(width * scale));
  const resizedHeight = Math.max(1, roundEven(height * scale));
  const stride = canvasSide ?? width;
  const plane = stride * (canvasSide ?? height);
  const output = new Float32Array(plane * 3);
  const columns = resizeWeights(width, resizedWidth);
  const rows = resizeWeights(height, resizedHeight);
  const horizontal = new Float32Array(resizedWidth * height);
  for (let channel = 0; channel < 3; channel++) {
    const mean = IMAGENET_MEAN[channel];
    const std = IMAGENET_STD[channel];
    const offset = channel * plane;
    output.fill((1 - mean) / std, offset, offset + plane);
    for (let y = 0; y < height; y++) {
      if ((y & 63) === 0) throwIfAborted(signal);
      for (let x = 0; x < resizedWidth; x++) {
        const { first, weights } = columns[x];
        horizontal[y * resizedWidth + x] = weightedSample(
          bitmap,
          (y * width + first) * 4 + 2 - channel,
          4,
          weights,
        );
      }
    }
    for (let y = 0; y < resizedHeight; y++) {
      if ((y & 63) === 0) throwIfAborted(signal);
      const { first, weights } = rows[y];
      for (let x = 0; x < resizedWidth; x++) {
        const value = weightedSample(
          horizontal,
          first * resizedWidth + x,
          resizedWidth,
          weights,
        );
        output[offset + y * stride + x] = (roundEven(value) / 255 - mean) / std;
      }
    }
  }
  return output;
}

function assertBitmapDimensions(
  bitmap: Uint8Array,
  width: number,
  height: number,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("KoharuLayout 입력 비트맵 크기가 올바르지 않습니다.");
  }
  const expectedLength = width * height * 4;
  if (bitmap.length < expectedLength) {
    throw new Error(
      `KoharuLayout 입력 비트맵이 너무 짧습니다: ${bitmap.length}/${expectedLength}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
