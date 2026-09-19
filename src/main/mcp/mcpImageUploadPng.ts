import { PNG } from "pngjs";
import type { McpImageUploadBegin } from "../../shared/mcpImageUploads";
import { McpEditError } from "../application/mcpEditPolicy";

/** Bound dimensions before inflation; pngjs remains the decoder/CRC authority. */
export function decodeMcpUploadPng(
  bytes: Buffer,
  declared: Pick<McpImageUploadBegin, "width" | "height" | "purpose">,
) {
  validateContainer(bytes, declared);
  let png: ReturnType<typeof PNG.sync.read>;
  try {
    png = PNG.sync.read(bytes);
  } catch (cause) {
    throw new McpEditError(
      "invalid_edit",
      "The received PNG is corrupt or unsupported.",
      { cause },
    );
  }
  if (
    png.width !== declared.width ||
    png.height !== declared.height ||
    png.data.length !== declared.width * declared.height * 4
  )
    throw invalidPng();
  return { png, ...measurePixels(png.data, declared.purpose) };
}
function measurePixels(data: Buffer, purpose: McpImageUploadBegin["purpose"]) {
  let hasTransparency = false,
    selectedPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4);
    if (a !== 255) hasTransparency = true;
    if (purpose !== "mask") continue;
    if (a !== 255 || r !== g || r !== b || (r !== 0 && r !== 255))
      throw new McpEditError(
        "invalid_edit",
        "Masks must be opaque binary PNG: white selects, black preserves. No thresholding, alpha inference or rescaling is performed.",
      );
    if (r === 255) selectedPixels++;
  }
  return {
    hasTransparency,
    selectedPixels: purpose === "mask" ? selectedPixels : null,
  };
}

function validateContainer(
  bytes: Buffer,
  declared: Pick<McpImageUploadBegin, "width" | "height">,
) {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw invalidPng();
  let offset = 8,
    chunks = 0,
    imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString("ascii", offset + 4, offset + 8);
    if (++chunks > 4096 || offset + length + 12 > bytes.length)
      throw invalidPng();
    if (chunks === 1) validateHeader(bytes, declared, type, length);
    else if (type === "IHDR") throw invalidPng();
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw new McpEditError(
        "invalid_edit",
        "Animated PNG is not a single reviewed image.",
      );
    if (type === "IDAT") imageData = true;
    offset += length + 12;
    if (type === "IEND") {
      validateEnd(length, imageData, offset, bytes.length);
      return;
    }
  }
  throw invalidPng();
}
function invalidPng() {
  return new McpEditError(
    "invalid_edit",
    "Expected one complete 8-bit PNG with the declared dimensions, bounded chunks, and no trailing content. Nothing was applied.",
  );
}

function validateHeader(
  bytes: Buffer,
  declared: Pick<McpImageUploadBegin, "width" | "height">,
  type: string,
  length: number,
) {
  if (
    type !== "IHDR" ||
    length !== 13 ||
    bytes.readUInt32BE(16) !== declared.width ||
    bytes.readUInt32BE(20) !== declared.height ||
    bytes[24] !== 8 ||
    !Number.isSafeInteger(declared.width) ||
    !Number.isSafeInteger(declared.height) ||
    declared.width * declared.height > 16_000_000 ||
    declared.width < 1 ||
    declared.height < 1
  )
    throw invalidPng();
}

function validateEnd(
  length: number,
  hasImageData: boolean,
  offset: number,
  byteLength: number,
) {
  if (length || !hasImageData || offset !== byteLength) throw invalidPng();
}
