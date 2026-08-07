import {
  assertDimensionBudget,
  checkedEnd,
  invalidImageHeaderError,
  isContainedRange,
  requestRead,
  type ImageHeaderMetadata,
  type ImageHeaderProbeLimits,
  type ImageHeaderProbeMachine,
  type ImageHeaderReadRequest,
} from "./imageHeaderProbeInternal";

const MAX_JPEG_MARKERS = 4096;
const MAX_JPEG_MARKER_FILL_BYTES = 65_536;
const MAX_EXIF_IFD_ENTRIES = 512;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type JpegState = {
  offset: number;
  markerCount: number;
  markerFillBytes: number;
  encodedWidth?: number;
  encodedHeight?: number;
  orientation: number;
};

type JpegSegment = {
  length: number;
  payloadOffset: number;
  payloadLength: number;
  end: number;
};

type JpegDimensions = {
  width: number;
  height: number;
};

export function* parseJpegMachine(
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderProbeMachine {
  yield* assertJpegSoi(size, label);
  const state: JpegState = {
    offset: 2,
    markerCount: 0,
    markerFillBytes: 0,
    orientation: 1,
  };

  while (state.offset < size) {
    const marker = yield* readJpegMarker(size, label, state);
    if (marker === 0xd9) {
      return buildJpegMetadata(state, size, label, limits);
    }
    if (isStandaloneMarker(marker)) {
      continue;
    }

    const segment = yield* readJpegSegment(size, label, state.offset);
    yield* applyJpegSegment(marker, segment, size, label, state);
    if (marker === 0xda) {
      return buildJpegMetadata(state, size, label, limits);
    }
    state.offset = segment.end;
  }

  throw invalidImageHeaderError(label);
}

function* assertJpegSoi(
  size: number,
  label: string,
): Generator<ImageHeaderReadRequest, void, Buffer> {
  const soi = yield requestRead(size, 0, 2, label);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) {
    throw invalidImageHeaderError(label);
  }
}

function* readJpegMarker(
  size: number,
  label: string,
  state: JpegState,
): Generator<ImageHeaderReadRequest, number, Buffer> {
  state.markerCount += 1;
  if (state.markerCount > MAX_JPEG_MARKERS) {
    throw invalidImageHeaderError(label);
  }
  const prefix = yield requestRead(size, state.offset, 1, label);
  state.offset += 1;
  if (prefix[0] !== 0xff) {
    throw invalidImageHeaderError(label);
  }

  const marker = yield* readMarkerAfterPrefix(size, label, state);
  if (marker === 0x00) {
    throw invalidImageHeaderError(label);
  }
  return marker;
}

function* readMarkerAfterPrefix(
  size: number,
  label: string,
  state: JpegState,
): Generator<ImageHeaderReadRequest, number, Buffer> {
  while (state.markerFillBytes <= MAX_JPEG_MARKER_FILL_BYTES) {
    const markerByte = yield requestRead(size, state.offset, 1, label);
    state.offset += 1;
    state.markerFillBytes += 1;
    if (state.markerFillBytes > MAX_JPEG_MARKER_FILL_BYTES) {
      throw invalidImageHeaderError(label);
    }
    const marker = markerByte[0] ?? -1;
    if (marker !== 0xff) {
      return marker;
    }
  }
  throw invalidImageHeaderError(label);
}

function isStandaloneMarker(marker: number): boolean {
  return (
    marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
  );
}

function* readJpegSegment(
  size: number,
  label: string,
  offset: number,
): Generator<ImageHeaderReadRequest, JpegSegment, Buffer> {
  const lengthBytes = yield requestRead(size, offset, 2, label);
  const length = lengthBytes.readUInt16BE(0);
  if (length < 2) {
    throw invalidImageHeaderError(label);
  }
  return {
    length,
    payloadOffset: offset + 2,
    payloadLength: length - 2,
    end: checkedEnd(offset, length, size, label),
  };
}

function* applyJpegSegment(
  marker: number,
  segment: JpegSegment,
  size: number,
  label: string,
  state: JpegState,
): Generator<ImageHeaderReadRequest, void, Buffer> {
  if (JPEG_SOF_MARKERS.has(marker)) {
    mergeSofDimensions(
      state,
      yield* readSofDimensions(size, label, segment),
      label,
    );
    return;
  }
  if (marker === 0xe1 && segment.payloadLength >= 6) {
    state.orientation = yield* readExifOrientation(
      size,
      label,
      segment,
      state.orientation,
    );
  }
}

function* readSofDimensions(
  size: number,
  label: string,
  segment: JpegSegment,
): Generator<ImageHeaderReadRequest, JpegDimensions, Buffer> {
  if (segment.payloadLength < 6) {
    throw invalidImageHeaderError(label);
  }
  const sof = yield requestRead(size, segment.payloadOffset, 6, label);
  const height = sof.readUInt16BE(1);
  const width = sof.readUInt16BE(3);
  const components = sof[5] ?? 0;
  if (components < 1 || segment.length !== 8 + 3 * components) {
    throw invalidImageHeaderError(label);
  }
  return { width, height };
}

function mergeSofDimensions(
  state: JpegState,
  dimensions: JpegDimensions,
  label: string,
): void {
  if (hasDifferentSofDimensions(state, dimensions)) {
    throw invalidImageHeaderError(label);
  }
  state.encodedWidth = dimensions.width;
  state.encodedHeight = dimensions.height;
}

function hasDifferentSofDimensions(
  state: JpegState,
  dimensions: JpegDimensions,
): boolean {
  return (
    (state.encodedWidth !== undefined &&
      state.encodedWidth !== dimensions.width) ||
    (state.encodedHeight !== undefined &&
      state.encodedHeight !== dimensions.height)
  );
}

function* readExifOrientation(
  size: number,
  label: string,
  segment: JpegSegment,
  fallback: number,
): Generator<ImageHeaderReadRequest, number, Buffer> {
  const prefix = yield requestRead(size, segment.payloadOffset, 6, label);
  if (!prefix.equals(Buffer.from("Exif\0\0", "binary"))) {
    return fallback;
  }
  const payload = yield requestRead(
    size,
    segment.payloadOffset,
    segment.payloadLength,
    label,
  );
  return parseExifOrientation(payload, fallback);
}

function buildJpegMetadata(
  state: JpegState,
  size: number,
  label: string,
  limits: ImageHeaderProbeLimits,
): ImageHeaderMetadata {
  const encodedWidth = state.encodedWidth;
  const encodedHeight = state.encodedHeight;
  if (encodedWidth === undefined || encodedHeight === undefined) {
    throw invalidImageHeaderError(label);
  }
  const swapsAxes = state.orientation >= 5 && state.orientation <= 8;
  const width = swapsAxes ? encodedHeight : encodedWidth;
  const height = swapsAxes ? encodedWidth : encodedHeight;
  const pixelCount = assertDimensionBudget(width, height, label, limits);
  return {
    format: "jpeg",
    encodedWidth,
    encodedHeight,
    width,
    height,
    orientation: state.orientation,
    pixelCount,
    byteLength: size,
  };
}

function parseExifOrientation(payload: Buffer, fallback: number): number {
  try {
    return parseExifOrientationUnsafe(payload) ?? fallback;
  } catch (error) {
    void error;
    return fallback;
  }
}

function parseExifOrientationUnsafe(payload: Buffer): number | undefined {
  const reader = createExifReader(payload);
  if (!reader) {
    return undefined;
  }
  const ifdOffset = reader.tiffOffset + reader.readU32(reader.tiffOffset + 4);
  if (!isContainedRange(ifdOffset, 2, payload.length)) {
    return undefined;
  }
  const entryCount = reader.readU16(ifdOffset);
  if (entryCount > MAX_EXIF_IFD_ENTRIES) {
    return undefined;
  }
  const entriesOffset = ifdOffset + 2;
  if (!isContainedRange(entriesOffset, entryCount * 12, payload.length)) {
    return undefined;
  }
  return findOrientationEntry(reader, entriesOffset, entryCount);
}

type ExifReader = {
  tiffOffset: number;
  readU16: (offset: number) => number;
  readU32: (offset: number) => number;
};

function createExifReader(payload: Buffer): ExifReader | undefined {
  if (payload.length < 14 || payload.toString("binary", 0, 6) !== "Exif\0\0") {
    return undefined;
  }
  const tiffOffset = 6;
  const byteOrder = payload.toString("ascii", tiffOffset, tiffOffset + 2);
  if (byteOrder !== "II" && byteOrder !== "MM") {
    return undefined;
  }
  const littleEndian = byteOrder === "II";
  const readU16 = (offset: number): number =>
    littleEndian ? payload.readUInt16LE(offset) : payload.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    littleEndian ? payload.readUInt32LE(offset) : payload.readUInt32BE(offset);
  if (readU16(tiffOffset + 2) !== 42) {
    return undefined;
  }
  return { tiffOffset, readU16, readU32 };
}

function findOrientationEntry(
  reader: ExifReader,
  entriesOffset: number,
  entryCount: number,
): number | undefined {
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    if (reader.readU16(entryOffset) === 0x0112) {
      return readOrientationValue(reader, entryOffset);
    }
  }
  return undefined;
}

function readOrientationValue(
  reader: ExifReader,
  entryOffset: number,
): number | undefined {
  if (reader.readU16(entryOffset + 2) !== 3) {
    return undefined;
  }
  if (reader.readU32(entryOffset + 4) !== 1) {
    return undefined;
  }
  const value = reader.readU16(entryOffset + 8);
  return value >= 1 && value <= 8 ? value : undefined;
}
