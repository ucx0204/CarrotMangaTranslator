import { COMIC_BUBBLE_DETECTOR_INPUT_SIZE } from "./constants";

export type PreparedComicDetectorImage = {
  imageWidth: number;
  imageHeight: number;
  rgbChw: Float32Array;
};

export function prepareComicDetectorImage(
  image: Electron.NativeImage,
  signal?: AbortSignal,
): PreparedComicDetectorImage {
  throwIfAborted(signal);
  const { width: imageWidth, height: imageHeight } = image.getSize();
  if (!imageWidth || !imageHeight) {
    throw new Error("말풍선 검출용 이미지 크기가 올바르지 않습니다.");
  }
  const resized = image.resize({
    width: COMIC_BUBBLE_DETECTOR_INPUT_SIZE,
    height: COMIC_BUBBLE_DETECTOR_INPUT_SIZE,
    quality: "best",
  });
  if (resized.isEmpty()) {
    throw new Error("말풍선 검출용 이미지 크기 조절에 실패했습니다.");
  }
  const resizedSize = resized.getSize();
  if (
    resizedSize.width !== COMIC_BUBBLE_DETECTOR_INPUT_SIZE ||
    resizedSize.height !== COMIC_BUBBLE_DETECTOR_INPUT_SIZE
  ) {
    throw new Error("말풍선 검출용 이미지 크기가 640x640이 아닙니다.");
  }
  const bitmap = resized.toBitmap();
  return {
    imageWidth,
    imageHeight,
    rgbChw: convertBgraBitmapToRgbChw(
      bitmap,
      resizedSize.width,
      resizedSize.height,
      signal,
    ),
  };
}

/**
 * Electron NativeImage bitmaps are BGRA. The model processor rescales by
 * 1/255, does not normalize, and expects planar RGB CHW.
 */
export function convertBgraBitmapToRgbChw(
  bitmap: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
): Float32Array {
  assertBitmapDimensions(bitmap, width, height);
  const pixelCount = width * height;
  const output = new Float32Array(pixelCount * 3);
  const greenOffset = pixelCount;
  const blueOffset = pixelCount * 2;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if ((pixel & 0x3fff) === 0) throwIfAborted(signal);
    const source = pixel * 4;
    output[pixel] = (bitmap[source + 2] ?? 0) / 255;
    output[greenOffset + pixel] = (bitmap[source + 1] ?? 0) / 255;
    output[blueOffset + pixel] = (bitmap[source] ?? 0) / 255;
  }
  throwIfAborted(signal);
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
    throw new Error("말풍선 검출용 비트맵 크기가 올바르지 않습니다.");
  }
  const expectedLength = width * height * 4;
  if (bitmap.length < expectedLength) {
    throw new Error(
      `말풍선 검출용 비트맵이 너무 짧습니다: ${bitmap.length}/${expectedLength}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
