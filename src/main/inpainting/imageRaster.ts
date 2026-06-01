import { nativeImage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { clamp } from "../../shared/geometry";
import type { PixelRect } from "./maskGeometry";

export function cropBitmapFromPage(bitmap: Buffer, pageWidth: number, rect: PixelRect): Buffer {
  const output = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y += 1) {
    const sourceStart = ((rect.y + y) * pageWidth + rect.x) * 4;
    const sourceEnd = sourceStart + rect.w * 4;
    bitmap.copy(output, y * rect.w * 4, sourceStart, sourceEnd);
  }
  return output;
}

export async function writePngFromBitmap(
  filePath: string,
  bitmap: Buffer,
  width: number,
  height: number,
  processSize: { width: number; height: number }
): Promise<void> {
  let image = nativeImage.createFromBitmap(bitmap, { width, height });
  if (processSize.width !== width || processSize.height !== height) {
    image = image.resize({ width: processSize.width, height: processSize.height, quality: "best" });
  }
  if (image.isEmpty()) {
    throw new Error("Flux 입력 crop 이미지를 만들지 못했습니다.");
  }
  await writeFile(filePath, image.toPNG());
}

export async function writePngFromMask(
  filePath: string,
  mask: Uint8Array,
  width: number,
  height: number,
  processSize: { width: number; height: number }
): Promise<void> {
  const bitmap = Buffer.alloc(processSize.width * processSize.height * 4);
  for (let y = 0; y < processSize.height; y += 1) {
    const sourceY = clamp(Math.floor(((y + 0.5) * height) / processSize.height), 0, height - 1);
    for (let x = 0; x < processSize.width; x += 1) {
      const sourceX = clamp(Math.floor(((x + 0.5) * width) / processSize.width), 0, width - 1);
      const value = mask[sourceY * width + sourceX] ? 255 : 0;
      const offset = (y * processSize.width + x) * 4;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: processSize.width, height: processSize.height });
  if (image.isEmpty()) {
    throw new Error("Flux 마스크 이미지를 만들지 못했습니다.");
  }
  await writeFile(filePath, image.toPNG());
}

export async function readGeneratedBitmap(filePath: string, targetWidth: number, targetHeight: number): Promise<Buffer> {
  const buffer = await readFile(filePath);
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(filePath);
  }
  if (image.isEmpty()) {
    throw new Error("Flux 결과 이미지를 읽지 못했습니다.");
  }
  const size = image.getSize();
  if (size.width !== targetWidth || size.height !== targetHeight) {
    image = image.resize({ width: targetWidth, height: targetHeight, quality: "best" });
  }
  return Buffer.from(image.toBitmap());
}

export function compositeFluxOutput(bitmap: Buffer, generated: Buffer, pageMask: Uint8Array, pageWidth: number, rect: PixelRect, featherPx: number): void {
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const pageX = rect.x + x;
      const pageY = rect.y + y;
      const alpha = maskSoftAlphaAt(pageMask, pageWidth, pageX, pageY, featherPx);
      if (alpha <= 0) {
        continue;
      }
      const targetOffset = (pageY * pageWidth + pageX) * 4;
      const sourceOffset = (y * rect.w + x) * 4;
      bitmap[targetOffset] = blendByte(bitmap[targetOffset] ?? 0, generated[sourceOffset] ?? 0, alpha);
      bitmap[targetOffset + 1] = blendByte(bitmap[targetOffset + 1] ?? 0, generated[sourceOffset + 1] ?? 0, alpha);
      bitmap[targetOffset + 2] = blendByte(bitmap[targetOffset + 2] ?? 0, generated[sourceOffset + 2] ?? 0, alpha);
      bitmap[targetOffset + 3] = 255;
    }
  }
}

export function maskBoundsInRect(mask: Uint8Array, pageWidth: number, rect: PixelRect): PixelRect | null {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = -1;
  let y2 = -1;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (!mask[y * pageWidth + x]) {
        continue;
      }
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
    }
  }
  if (!Number.isFinite(x1) || x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function buildLocalMask(pageMask: Uint8Array, pageWidth: number, rect: PixelRect, paddingPx: number): Uint8Array {
  const output = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (pageMask[(rect.y + y) * pageWidth + rect.x + x]) {
        output[y * rect.w + x] = 1;
      }
    }
  }
  return paddingPx > 0 ? dilateMaskSquare(output, rect.w, rect.h, paddingPx) : output;
}

function blendByte(base: number, next: number, alpha: number): number {
  return clamp(Math.round(base * (1 - alpha) + next * alpha), 0, 255);
}

function maskSoftAlphaAt(mask: Uint8Array, width: number, x: number, y: number, featherPx: number): number {
  if (mask[y * width + x]) {
    return 1;
  }
  if (featherPx <= 0) {
    return 0;
  }
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  const radius = Math.max(1, featherPx);
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radius * radius || distanceSq >= bestDistanceSq) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) {
        continue;
      }
      const index = ny * width + nx;
      if (index >= 0 && index < mask.length && mask[index]) {
        bestDistanceSq = distanceSq;
      }
    }
  }
  if (!Number.isFinite(bestDistanceSq)) {
    return 0;
  }
  return clamp(1 - Math.sqrt(bestDistanceSq) / Math.max(1, featherPx), 0, 1);
}

function dilateMaskSquare(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = -radius; x <= radius; x += 1) {
      if (x >= 0 && x < width && mask[y * width + x]) {
        count += 1;
      }
    }
    for (let x = 0; x < width; x += 1) {
      if (count > 0) {
        horizontal[y * width + x] = 1;
      }
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0 && removeX < width && mask[y * width + removeX]) {
        count -= 1;
      }
      if (addX >= 0 && addX < width && mask[y * width + addX]) {
        count += 1;
      }
    }
  }
  const output = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = -radius; y <= radius; y += 1) {
      if (y >= 0 && y < height && horizontal[y * width + x]) {
        count += 1;
      }
    }
    for (let y = 0; y < height; y += 1) {
      if (count > 0) {
        output[y * width + x] = 1;
      }
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0 && removeY < height && horizontal[removeY * width + x]) {
        count -= 1;
      }
      if (addY >= 0 && addY < height && horizontal[addY * width + x]) {
        count += 1;
      }
    }
  }
  return output;
}
