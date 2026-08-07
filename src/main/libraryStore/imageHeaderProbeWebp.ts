import {
  assertDimensionBudget,
  checkedEnd,
  invalidImageHeaderError,
  requestRead,
  type ImageHeaderMetadata,
  type ImageHeaderProbeLimits,
  type ImageHeaderProbeMachine,
  type ImageHeaderReadRequest,
} from "./imageHeaderProbeInternal";

const MAX_WEBP_CHUNKS = 10_000;

type WebpState = {
  canvasWidth?: number;
  canvasHeight?: number;
  imageWidth?: number;
  imageHeight?: number;
  sawAnimationFrame: boolean;
};

type WebpChunk = {
  fourcc: string;
  size: number;
  dataOffset: number;
  nextOffset: number;
};

type WebpChunkResult =
  | { kind: "canvas"; width: number; height: number }
  | { kind: "image"; width: number; height: number }
  | { kind: "animation-frame" }
  | { kind: "ignored" };

export function* parseWebpMachine(
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
  riffHeader: Buffer,
): ImageHeaderProbeMachine {
  const declaredEnd = resolveDeclaredEnd(size, label, riffHeader);
  const state: WebpState = { sawAnimationFrame: false };
  let offset = 12;
  let chunkCount = 0;

  while (offset < declaredEnd) {
    chunkCount += 1;
    if (chunkCount > MAX_WEBP_CHUNKS) {
      throw invalidImageHeaderError(label);
    }
    const chunk = yield* readWebpChunk(declaredEnd, offset, label);
    const result = yield* parseWebpChunk(
      chunk,
      declaredEnd,
      label,
      limits,
      state,
    );
    applyChunkResult(state, result, label);
    offset = chunk.nextOffset;
  }

  assertWebpEndState(offset, declaredEnd, state, label);
  return buildWebpMetadata(state, size, label, limits);
}

function resolveDeclaredEnd(
  size: number,
  label: string,
  header: Buffer,
): number {
  const declaredEnd = header.readUInt32LE(4) + 8;
  if (
    !Number.isSafeInteger(declaredEnd) ||
    declaredEnd < 12 ||
    declaredEnd > size
  ) {
    throw invalidImageHeaderError(label);
  }
  return declaredEnd;
}

function* readWebpChunk(
  declaredEnd: number,
  offset: number,
  label: string,
): Generator<ImageHeaderReadRequest, WebpChunk, Buffer> {
  const header = yield requestRead(declaredEnd, offset, 8, label);
  const size = header.readUInt32LE(4);
  const dataOffset = offset + 8;
  const dataEnd = checkedEnd(dataOffset, size, declaredEnd, label);
  return {
    fourcc: header.toString("ascii", 0, 4),
    size,
    dataOffset,
    nextOffset: checkedEnd(dataEnd, size & 1, declaredEnd, label),
  };
}

function* parseWebpChunk(
  chunk: WebpChunk,
  declaredEnd: number,
  label: string,
  limits: ImageHeaderProbeLimits,
  state: WebpState,
): Generator<ImageHeaderReadRequest, WebpChunkResult, Buffer> {
  switch (chunk.fourcc) {
    case "VP8X":
      return yield* readVp8xChunk(chunk, declaredEnd, label, limits);
    case "VP8L":
      return yield* readVp8lChunk(chunk, declaredEnd, label, limits);
    case "VP8 ":
      return yield* readVp8Chunk(chunk, declaredEnd, label, limits);
    case "ANMF":
      yield* validateAnmfChunk(chunk, declaredEnd, label, limits, state);
      return { kind: "animation-frame" };
    default:
      return { kind: "ignored" };
  }
}

function* readVp8xChunk(
  chunk: WebpChunk,
  declaredEnd: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): Generator<ImageHeaderReadRequest, WebpChunkResult, Buffer> {
  assertMinimumChunkSize(chunk, 10, label);
  const data = yield requestRead(declaredEnd, chunk.dataOffset, 10, label);
  const width = 1 + readUint24LE(data, 4);
  const height = 1 + readUint24LE(data, 7);
  assertDimensionBudget(width, height, label, limits);
  return { kind: "canvas", width, height };
}

function* readVp8lChunk(
  chunk: WebpChunk,
  declaredEnd: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): Generator<ImageHeaderReadRequest, WebpChunkResult, Buffer> {
  assertMinimumChunkSize(chunk, 5, label);
  const data = yield requestRead(declaredEnd, chunk.dataOffset, 5, label);
  if (data[0] !== 0x2f || (data[4] ?? 0) >> 5 !== 0) {
    throw invalidImageHeaderError(label);
  }
  const dimensions = decodeVp8lDimensions(data);
  assertDimensionBudget(dimensions.width, dimensions.height, label, limits);
  return { kind: "image", ...dimensions };
}

function decodeVp8lDimensions(data: Buffer): { width: number; height: number } {
  const b1 = data[1] ?? 0;
  const b2 = data[2] ?? 0;
  const b3 = data[3] ?? 0;
  const b4 = data[4] ?? 0;
  return {
    width: 1 + b1 + ((b2 & 0x3f) << 8),
    height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
  };
}

function* readVp8Chunk(
  chunk: WebpChunk,
  declaredEnd: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): Generator<ImageHeaderReadRequest, WebpChunkResult, Buffer> {
  assertMinimumChunkSize(chunk, 10, label);
  const data = yield requestRead(declaredEnd, chunk.dataOffset, 10, label);
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
    throw invalidImageHeaderError(label);
  }
  const width = data.readUInt16LE(6) & 0x3fff;
  const height = data.readUInt16LE(8) & 0x3fff;
  assertDimensionBudget(width, height, label, limits);
  return { kind: "image", width, height };
}

function* validateAnmfChunk(
  chunk: WebpChunk,
  declaredEnd: number,
  label: string,
  limits: ImageHeaderProbeLimits,
  state: WebpState,
): Generator<ImageHeaderReadRequest, void, Buffer> {
  assertMinimumChunkSize(chunk, 16, label);
  const canvas = requireAnimationCanvas(state, label);
  const data = yield requestRead(declaredEnd, chunk.dataOffset, 16, label);
  const frame = {
    x: readUint24LE(data, 0) * 2,
    y: readUint24LE(data, 3) * 2,
    width: 1 + readUint24LE(data, 6),
    height: 1 + readUint24LE(data, 9),
  };
  assertDimensionBudget(frame.width, frame.height, label, limits);
  assertFrameWithinCanvas(frame, canvas, label);
}

function assertMinimumChunkSize(
  chunk: WebpChunk,
  minimum: number,
  label: string,
): void {
  if (chunk.size < minimum) {
    throw invalidImageHeaderError(label);
  }
}

function requireAnimationCanvas(
  state: WebpState,
  label: string,
): { width: number; height: number } {
  if (state.canvasWidth === undefined || state.canvasHeight === undefined) {
    throw invalidImageHeaderError(label);
  }
  return { width: state.canvasWidth, height: state.canvasHeight };
}

function assertFrameWithinCanvas(
  frame: { x: number; y: number; width: number; height: number },
  canvas: { width: number; height: number },
  label: string,
): void {
  if (
    frame.width > canvas.width ||
    frame.height > canvas.height ||
    frame.x > canvas.width - frame.width ||
    frame.y > canvas.height - frame.height
  ) {
    throw invalidImageHeaderError(label);
  }
}

function applyChunkResult(
  state: WebpState,
  result: WebpChunkResult,
  label: string,
): void {
  if (result.kind === "canvas") {
    applyCanvasDimensions(state, result, label);
  } else if (result.kind === "image" && state.imageWidth === undefined) {
    state.imageWidth = result.width;
    state.imageHeight = result.height;
  } else if (result.kind === "animation-frame") {
    state.sawAnimationFrame = true;
  }
}

function applyCanvasDimensions(
  state: WebpState,
  dimensions: { width: number; height: number },
  label: string,
): void {
  if (
    (state.canvasWidth !== undefined &&
      state.canvasWidth !== dimensions.width) ||
    (state.canvasHeight !== undefined &&
      state.canvasHeight !== dimensions.height)
  ) {
    throw invalidImageHeaderError(label);
  }
  state.canvasWidth = dimensions.width;
  state.canvasHeight = dimensions.height;
}

function assertWebpEndState(
  offset: number,
  declaredEnd: number,
  state: WebpState,
  label: string,
): void {
  if (
    offset !== declaredEnd ||
    (state.sawAnimationFrame && state.canvasWidth === undefined)
  ) {
    throw invalidImageHeaderError(label);
  }
}

function buildWebpMetadata(
  state: WebpState,
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderMetadata {
  const width = state.canvasWidth ?? state.imageWidth;
  const height = state.canvasHeight ?? state.imageHeight;
  if (width === undefined || height === undefined) {
    throw invalidImageHeaderError(label);
  }
  const pixelCount = assertDimensionBudget(width, height, label, limits);
  return {
    format: "webp",
    encodedWidth: width,
    encodedHeight: height,
    width,
    height,
    orientation: 1,
    pixelCount,
    byteLength: size,
  };
}

function readUint24LE(bytes: Buffer, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}
