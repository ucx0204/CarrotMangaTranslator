import { tMain } from "./localization";

type InternalImportImageFormat = "jpeg" | "png" | "webp";

export type ImageHeaderMetadata = {
  format: InternalImportImageFormat;
  encodedWidth: number;
  encodedHeight: number;
  width: number;
  height: number;
  orientation: number;
  pixelCount: number;
  byteLength: number;
};

export type ImageHeaderProbeLimits = {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
};

export type ImageHeaderReadRequest = {
  offset: number;
  length: number;
};

export type ImageHeaderProbeMachine = Generator<
  ImageHeaderReadRequest,
  ImageHeaderMetadata,
  Buffer
>;

export class InvalidImageHeaderError extends Error {
  readonly code = "INVALID_IMAGE_HEADER";

  constructor(label: string) {
    super(tMain("import.errors.invalidImageHeader", { file: label }));
    this.name = "InvalidImageHeaderError";
  }
}

export function isInvalidImageHeaderError(
  error: unknown,
): error is InvalidImageHeaderError {
  return error instanceof InvalidImageHeaderError;
}

export function assertDimensionBudget(
  width: number,
  height: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): number {
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
    throw invalidImageHeaderError(label);
  }
  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw resolutionTooLargeError(label);
  }
  if (width > Math.floor(limits.maxPixels / height)) {
    throw resolutionTooLargeError(label);
  }
  return width * height;
}

export function assertProbeLimits(limits: ImageHeaderProbeLimits): void {
  if (
    !isPositiveSafeInteger(limits.maxWidth) ||
    !isPositiveSafeInteger(limits.maxHeight) ||
    !isPositiveSafeInteger(limits.maxPixels)
  ) {
    throw new TypeError(
      "Image header probe limits must be positive safe integers.",
    );
  }
}

export function requestRead(
  size: number,
  offset: number,
  length: number,
  label: string,
): ImageHeaderReadRequest {
  if (!isContainedRange(offset, length, size)) {
    throw invalidImageHeaderError(label);
  }
  return { offset, length };
}

export function checkedEnd(
  offset: number,
  length: number,
  size: number,
  label: string,
): number {
  if (!isContainedRange(offset, length, size)) {
    throw invalidImageHeaderError(label);
  }
  return offset + length;
}

export function isContainedRange(
  offset: number,
  length: number,
  size: number,
): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    Number.isSafeInteger(size) &&
    offset >= 0 &&
    length >= 0 &&
    size >= 0 &&
    offset <= size &&
    length <= size - offset
  );
}

export function assertReadRange(
  offset: number,
  length: number,
  size: number,
): void {
  if (!isContainedRange(offset, length, size)) {
    throw new RangeError("Image header read exceeds the source bounds.");
  }
}

export function invalidImageHeaderError(label: string): Error {
  return new InvalidImageHeaderError(label);
}

export function imageReadError(label: string): Error {
  return new Error(tMain("import.errors.imageRead", { file: label }));
}

function resolutionTooLargeError(label: string): Error {
  return new Error(tMain("import.errors.resolutionTooLarge", { file: label }));
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
