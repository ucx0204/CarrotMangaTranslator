import { describe, expect, it } from "vitest";
import {
  applyRetouchEllipse,
  applyRetouchRectangle,
  resolveRetouchShapeBounds,
} from "../src/main/inpainting/rasterMasks";

describe("inpainting retouch filled geometry", () => {
  it("normalizes reverse rectangle drags and clips them to the bitmap", () => {
    const width = 5;
    const height = 4;
    const bitmap = solidBitmap(width, height, { r: 0, g: 0, b: 0 });
    const original = Buffer.from(bitmap);
    const geometry = {
      kind: "rectangle" as const,
      start: { x: 20, y: 30 },
      end: { x: 1, y: 1 },
    };

    expect(resolveRetouchShapeBounds(geometry, width, height)).toEqual({
      bottom: 3,
      left: 1,
      right: 4,
      top: 1,
    });
    applyRetouchRectangle(bitmap, original, width, height, geometry, "paint", {
      r: 255,
      g: 204,
      b: 0,
    });

    expect(readPixel(bitmap, width, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(readPixel(bitmap, width, 1, 1)).toEqual({
      r: 255,
      g: 204,
      b: 0,
    });
    expect(readPixel(bitmap, width, 4, 3)).toEqual({
      r: 255,
      g: 204,
      b: 0,
    });
  });

  it("fills an ellipse by pixel centers without painting bounding-box corners", () => {
    const width = 7;
    const height = 5;
    const bitmap = solidBitmap(width, height, { r: 0, g: 0, b: 0 });
    const original = Buffer.from(bitmap);
    applyRetouchEllipse(
      bitmap,
      original,
      width,
      height,
      {
        kind: "ellipse",
        start: { x: 1, y: 0 },
        end: { x: 5, y: 4 },
      },
      "paint",
      { r: 255, g: 255, b: 255 },
    );

    expect(readPixel(bitmap, width, 3, 2)).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(readPixel(bitmap, width, 3, 0)).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(readPixel(bitmap, width, 1, 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(readPixel(bitmap, width, 5, 4)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("restores exact original pixels and treats a zero-size ellipse as one pixel", () => {
    const width = 3;
    const height = 3;
    const bitmap = solidBitmap(width, height, { r: 255, g: 255, b: 255 });
    const original = solidBitmap(width, height, { r: 12, g: 34, b: 56 });
    applyRetouchEllipse(
      bitmap,
      original,
      width,
      height,
      {
        kind: "ellipse",
        start: { x: 1, y: 1 },
        end: { x: 1, y: 1 },
      },
      "restore",
      null,
    );

    expect(readPixel(bitmap, width, 1, 1)).toEqual({
      r: 12,
      g: 34,
      b: 56,
    });
    expect(readPixel(bitmap, width, 0, 0)).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });
});

function solidBitmap(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = color.b;
    bitmap[offset + 1] = color.g;
    bitmap[offset + 2] = color.r;
    bitmap[offset + 3] = 255;
  }
  return bitmap;
}

function readPixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const offset = (y * width + x) * 4;
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0,
  };
}
