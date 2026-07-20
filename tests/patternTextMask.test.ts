import { describe, expect, it } from "vitest";
import { buildPatternTextMask } from "../src/main/inpainting/patternTextMask";

describe("pattern text mask", () => {
  it("uses Otsu retry for low-contrast text that adaptive thresholds miss", () => {
    const width = 40;
    const height = 40;
    const bitmap = createBitmap(width, height, 180);
    fillRect(bitmap, width, { x: 15, y: 13, w: 8, h: 12 }, 165);

    const result = buildPatternTextMask(
      bitmap,
      width,
      height,
      { x: 0, y: 0, w: width, h: height },
      1,
      { focusRect: { x: 12, y: 10, w: 16, h: 18 } },
    );

    expect(result.strategy).toBe("otsu");
    expect(result.count).toBeGreaterThan(80);
    expect(result.mask[18 * width + 18]).toBe(1);
  });

  it("keeps a high-contrast bubble outline outside the source box", () => {
    const width = 48;
    const height = 48;
    const bitmap = createBitmap(width, height, 248);
    drawRectOutline(bitmap, width, { x: 7, y: 7, w: 34, h: 34 }, 10);
    fillRect(bitmap, width, { x: 20, y: 17, w: 7, h: 15 }, 10);

    const result = buildPatternTextMask(
      bitmap,
      width,
      height,
      { x: 0, y: 0, w: width, h: height },
      3,
      { focusRect: { x: 16, y: 14, w: 16, h: 21 } },
    );

    expect(result.strategy).toBe("adaptive");
    expect(result.mask[24 * width + 23]).toBe(1);
    expect(result.mask[7 * width + 24]).toBe(0);
    expect(result.mask[24 * width + 7]).toBe(0);
  });
});

function createBitmap(width: number, height: number, value: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      writePixel(bitmap, width, x, y, value);
    }
  }
  return bitmap;
}

function fillRect(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      writePixel(bitmap, width, x, y, value);
    }
  }
}

function drawRectOutline(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let x = rect.x; x < rect.x + rect.w; x += 1) {
    writePixel(bitmap, width, x, rect.y, value);
    writePixel(bitmap, width, x, rect.y + rect.h - 1, value);
  }
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    writePixel(bitmap, width, rect.x, y, value);
    writePixel(bitmap, width, rect.x + rect.w - 1, y, value);
  }
}

function writePixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  value: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = value;
  bitmap[offset + 1] = value;
  bitmap[offset + 2] = value;
  bitmap[offset + 3] = 255;
}
