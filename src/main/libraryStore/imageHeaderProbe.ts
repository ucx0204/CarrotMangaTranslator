import { open } from "node:fs/promises";
import { MAX_IMAGE_DIMENSION } from "../../shared/ipcSchemaPrimitives";
import { throwIfAborted } from "../abortSignal";
import { MAX_IMPORT_IMAGE_PIXELS } from "./imageDecodeLimits";
import {
  assertDimensionBudget,
  assertProbeLimits,
  assertReadRange,
  imageReadError,
  invalidImageHeaderError,
  requestRead,
  type ImageHeaderProbeMachine,
} from "./imageHeaderProbeInternal";
import { parseJpegMachine } from "./imageHeaderProbeJpeg";
import { parseWebpMachine } from "./imageHeaderProbeWebp";

export type ImportImageFormat = "jpeg" | "png" | "webp";

export type ImageHeaderMetadata = {
  format: ImportImageFormat;
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

export const DEFAULT_IMPORT_IMAGE_HEADER_LIMITS: ImageHeaderProbeLimits = {
  maxWidth: MAX_IMAGE_DIMENSION,
  maxHeight: MAX_IMAGE_DIMENSION,
  maxPixels: MAX_IMPORT_IMAGE_PIXELS,
};

type SyncImageByteReader = {
  readonly size: number;
  readExact: (offset: number, length: number) => Buffer;
};

type ImageByteReader = {
  readonly size: number;
  readExact: (offset: number, length: number) => Promise<Buffer>;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function probeImageBuffer(
  bytes: Uint8Array,
  label: string,
  limits: ImageHeaderProbeLimits = DEFAULT_IMPORT_IMAGE_HEADER_LIMITS,
): ImageHeaderMetadata {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader: SyncImageByteReader = {
    size: buffer.byteLength,
    readExact: (offset, length) => {
      assertReadRange(offset, length, buffer.byteLength);
      return buffer.subarray(offset, offset + length);
    },
  };
  return runProbeSync(reader, label, limits);
}

export async function probeImageFile(
  filePath: string,
  label: string,
  limits: ImageHeaderProbeLimits = DEFAULT_IMPORT_IMAGE_HEADER_LIMITS,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
      throw imageReadError(label);
    }
    return await runProbeAsync(
      createFileReader(handle, info.size, label, signal),
      label,
      limits,
      signal,
    );
  } finally {
    await handle.close();
  }
}

export function assertImageDimensionsWithinBudget(
  metadata: Pick<ImageHeaderMetadata, "width" | "height">,
  label: string,
  limits: ImageHeaderProbeLimits = DEFAULT_IMPORT_IMAGE_HEADER_LIMITS,
): void {
  assertDimensionBudget(metadata.width, metadata.height, label, limits);
}

export function assertSameImageDimensions(
  left: Pick<ImageHeaderMetadata, "width" | "height">,
  right: Pick<ImageHeaderMetadata, "width" | "height">,
  message: string,
): void {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(message);
  }
}

function createFileReader(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  label: string,
  signal?: AbortSignal,
): ImageByteReader {
  return {
    size,
    readExact: async (offset, length) => {
      assertReadRange(offset, length, size);
      return readFileRange(handle, offset, length, label, signal);
    },
  };
}

async function readFileRange(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let cursor = 0;
  while (cursor < length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      output,
      cursor,
      length - cursor,
      offset + cursor,
    );
    if (bytesRead === 0) {
      throw invalidImageHeaderError(label);
    }
    cursor += bytesRead;
  }
  return output;
}

function runProbeSync(
  reader: SyncImageByteReader,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderMetadata {
  const machine = probeImageMachine(reader.size, label, limits);
  let step = machine.next();
  while (!step.done) {
    const request = step.value;
    step = machine.next(reader.readExact(request.offset, request.length));
  }
  return step.value;
}

async function runProbeAsync(
  reader: ImageByteReader,
  label: string,
  limits: ImageHeaderProbeLimits,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  const machine = probeImageMachine(reader.size, label, limits);
  let step = machine.next();
  while (!step.done) {
    throwIfAborted(signal);
    const request = step.value;
    step = machine.next(await reader.readExact(request.offset, request.length));
  }
  throwIfAborted(signal);
  return step.value;
}

function* probeImageMachine(
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderProbeMachine {
  assertProbeLimits(limits);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw invalidImageHeaderError(label);
  }
  const signature = yield requestRead(size, 0, 12, label);
  if (signature.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return yield* parsePngMachine(size, label, limits);
  }
  if (signature[0] === 0xff && signature[1] === 0xd8) {
    return yield* parseJpegMachine(size, label, limits);
  }
  if (isWebpSignature(signature)) {
    return yield* parseWebpMachine(size, label, limits, signature);
  }
  throw invalidImageHeaderError(label);
}

function* parsePngMachine(
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderProbeMachine {
  const header = yield requestRead(size, 0, 24, label);
  if (!hasValidPngHeader(header)) {
    throw invalidImageHeaderError(label);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const pixelCount = assertDimensionBudget(width, height, label, limits);
  return {
    format: "png",
    encodedWidth: width,
    encodedHeight: height,
    width,
    height,
    orientation: 1,
    pixelCount,
    byteLength: size,
  };
}

function hasValidPngHeader(header: Buffer): boolean {
  return (
    header.subarray(0, 8).equals(PNG_SIGNATURE) &&
    header.readUInt32BE(8) === 13 &&
    header.toString("ascii", 12, 16) === "IHDR"
  );
}

function isWebpSignature(signature: Buffer): boolean {
  return (
    signature.toString("ascii", 0, 4) === "RIFF" &&
    signature.toString("ascii", 8, 12) === "WEBP"
  );
}
