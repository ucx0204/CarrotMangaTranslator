import { describe, expect, it } from "vitest";
import { compositeFluxOutput } from "../src/main/inpainting/imageRaster";

describe("Flux bubble composite constraints", () => {
  it("clips both the core and its feather at the green-region boundary", () => {
    const width = 9;
    const height = 9;
    const bitmap = createBitmap(width, height, 10);
    const generated = createBitmap(width, height, 240);
    const core = new Uint8Array(width * height);
    const constraint = new Uint8Array(width * height);
    core[4 * width + 4] = 1;
    constraint[4 * width + 4] = 1;

    compositeFluxOutput(
      bitmap,
      generated,
      core,
      width,
      { x: 0, y: 0, w: width, h: height },
      3,
      undefined,
      constraint,
    );

    expect(readValue(bitmap, width, 4, 4)).toBe(240);
    expect(readValue(bitmap, width, 5, 4)).toBe(10);
    expect(readValue(bitmap, width, 4, 5)).toBe(10);
  });

  it("preserves the legacy outward feather when no green constraint exists", () => {
    const width = 9;
    const height = 9;
    const bitmap = createBitmap(width, height, 10);
    const generated = createBitmap(width, height, 240);
    const core = new Uint8Array(width * height);
    core[4 * width + 4] = 1;

    compositeFluxOutput(
      bitmap,
      generated,
      core,
      width,
      { x: 0, y: 0, w: width, h: height },
      3,
    );

    expect(readValue(bitmap, width, 4, 4)).toBe(240);
    expect(readValue(bitmap, width, 5, 4)).toBeGreaterThan(10);
    expect(readValue(bitmap, width, 7, 4)).toBe(10);
  });
});

function createBitmap(width: number, height: number, value: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = value;
    bitmap[offset + 1] = value;
    bitmap[offset + 2] = value;
    bitmap[offset + 3] = 255;
  }
  return bitmap;
}

function readValue(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): number {
  return bitmap[(y * width + x) * 4] ?? -1;
}
