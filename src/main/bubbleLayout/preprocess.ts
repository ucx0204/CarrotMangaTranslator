import { KOHARU_LAYOUT_INPUT_SIZE, KOHARU_LAYOUT_MASK_SIZE } from "./constants";

export type PreparedComicDetectorImage = {
  geometryRaster: {
    luminance: Uint8Array;
    width: number;
    height: number;
  };
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
  const resized = image.resize({
    width: KOHARU_LAYOUT_INPUT_SIZE,
    height: KOHARU_LAYOUT_INPUT_SIZE,
    quality: "best",
  });
  if (resized.isEmpty()) {
    throw new Error("KoharuLayout 입력 이미지 크기 조절에 실패했습니다.");
  }
  const resizedSize = resized.getSize();
  if (
    resizedSize.width !== KOHARU_LAYOUT_INPUT_SIZE ||
    resizedSize.height !== KOHARU_LAYOUT_INPUT_SIZE
  ) {
    throw new Error("KoharuLayout 입력 이미지 크기가 1152x1152가 아닙니다.");
  }
  return {
    geometryRaster: prepareComicDetectorGeometryRaster(image, signal),
    imageWidth,
    imageHeight,
    rgbChw: convertBgraBitmapToRgbChw(
      resized.toBitmap(),
      resizedSize.width,
      resizedSize.height,
      signal,
    ),
  };
}

function prepareComicDetectorGeometryRaster(
  image: Electron.NativeImage,
  signal?: AbortSignal,
): PreparedComicDetectorImage["geometryRaster"] {
  throwIfAborted(signal);
  const resized = image.resize({
    width: KOHARU_LAYOUT_MASK_SIZE,
    height: KOHARU_LAYOUT_MASK_SIZE,
    quality: "best",
  });
  if (resized.isEmpty()) {
    throw new Error("KoharuLayout 기하 래스터 크기 조절에 실패했습니다.");
  }
  const { width, height } = resized.getSize();
  if (width !== KOHARU_LAYOUT_MASK_SIZE || height !== KOHARU_LAYOUT_MASK_SIZE) {
    throw new Error("KoharuLayout 기하 래스터가 288x288이 아닙니다.");
  }
  const bitmap = resized.toBitmap();
  assertBitmapDimensions(bitmap, width, height);
  const luminance = new Uint8Array(width * height);
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    if ((pixel & 0x3fff) === 0) throwIfAborted(signal);
    const source = pixel * 4;
    luminance[pixel] = Math.round(
      (bitmap[source + 2] ?? 0) * 0.299 +
        (bitmap[source + 1] ?? 0) * 0.587 +
        (bitmap[source] ?? 0) * 0.114,
    );
  }
  return { luminance, width, height };
}

/** Electron BGRA -> ImageNet-normalized planar RGB CHW. */
export function convertBgraBitmapToRgbChw(
  bitmap: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
): Float32Array {
  assertBitmapDimensions(bitmap, width, height);
  const pixelCount = width * height;
  const output = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if ((pixel & 0x3fff) === 0) throwIfAborted(signal);
    const source = pixel * 4;
    const rgb = [
      (bitmap[source + 2] ?? 0) / 255,
      (bitmap[source + 1] ?? 0) / 255,
      (bitmap[source] ?? 0) / 255,
    ];
    for (let channel = 0; channel < 3; channel += 1) {
      output[channel * pixelCount + pixel] =
        ((rgb[channel] ?? 0) - (IMAGENET_MEAN[channel] ?? 0)) /
        (IMAGENET_STD[channel] ?? 1);
    }
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
