import { describe, expect, it } from "vitest";
import {
  applyLightweightBubbleFill,
  resolveFlatBubbleFill,
  resolveLightweightBubbleFill,
} from "../src/main/inpainting/hybridBubbleCleaning";

describe("lightweight bubble fill", () => {
  it("reconstructs a smooth color gradient without a generative engine", () => {
    const width = 64;
    const height = 48;
    const bitmap = createBitmap(width, height, (x, y) => ({
      r: 90 + (60 * x) / (width - 1) + (10 * y) / (height - 1),
      g: 110 + (20 * x) / (width - 1) + (30 * y) / (height - 1),
      b: 150 - (20 * x) / (width - 1) + (10 * y) / (height - 1),
    }));
    const mask = centerMask(width, height);
    paintMask(bitmap, width, mask, { r: 0, g: 0, b: 0 });

    expect(
      resolveFlatBubbleFill(
        bitmap,
        width,
        { x: 0, y: 0, w: width, h: height },
        mask,
      ),
    ).toBeNull();
    const fill = resolveLightweightBubbleFill(
      bitmap,
      width,
      { x: 0, y: 0, w: width, h: height },
      mask,
    );
    expect(fill).toMatchObject({ inlierRatio: 1, sampleCount: 2880 });
    expect(fill?.rmse).toBeLessThan(1);
    if (!fill) throw new Error("Expected a lightweight fill.");

    applyLightweightBubbleFill(
      bitmap,
      width,
      { x: 0, y: 0, w: width, h: height },
      mask,
      fill,
    );
    expect(readRgb(bitmap, width, 32, 24)).toEqual({
      r: 126,
      g: 135,
      b: 145,
    });
  });

  it("rejects textured backgrounds so they are promoted to the engine", () => {
    const width = 64;
    const height = 48;
    const bitmap = createBitmap(width, height, (x, y) => {
      const value = (x + y) % 2 === 0 ? 30 : 220;
      return { r: value, g: 255 - value, b: value };
    });
    const mask = centerMask(width, height);
    paintMask(bitmap, width, mask, { r: 0, g: 0, b: 0 });

    expect(
      resolveLightweightBubbleFill(
        bitmap,
        width,
        { x: 0, y: 0, w: width, h: height },
        mask,
      ),
    ).toBeNull();
  });
});

function createBitmap(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => { r: number; g: number; b: number },
): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      writeRgb(bitmap, width, x, y, colorAt(x, y));
    }
  }
  return bitmap;
}

function centerMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 18; y < 30; y += 1) {
    for (let x = 24; x < 40; x += 1) mask[y * width + x] = 1;
  }
  return mask;
}

function paintMask(
  bitmap: Buffer,
  width: number,
  mask: Uint8Array,
  color: { r: number; g: number; b: number },
): void {
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    writeRgb(bitmap, width, index % width, Math.floor(index / width), color);
  }
}

function writeRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  color: { r: number; g: number; b: number },
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = Math.round(color.b);
  bitmap[offset + 1] = Math.round(color.g);
  bitmap[offset + 2] = Math.round(color.r);
  bitmap[offset + 3] = 255;
}

function readRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const offset = (y * width + x) * 4;
  return {
    r: bitmap[offset + 2],
    g: bitmap[offset + 1],
    b: bitmap[offset],
  };
}
