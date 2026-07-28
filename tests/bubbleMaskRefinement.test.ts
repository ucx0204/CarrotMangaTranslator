import { describe, expect, it } from "vitest";
import { refineBubbleSafeMask } from "../src/main/bubbleLayout/bubbleMaskRefinement";

const WIDTH = 120;
const HEIGHT = 70;

describe("bubble safe-mask refinement", () => {
  it("splits two balloon lobes at an eroded narrow neck", () => {
    const bitmap = createBitmap(20);
    paintCircle(bitmap, 35, 35, 25, 245);
    paintCircle(bitmap, 85, 35, 25, 245);
    paintRect(bitmap, 55, 33, 11, 5, 245);

    const result = refineBubbleSafeMask({
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      bubbleBox: { x: 5, y: 5, w: 110, h: 60 },
      promptBoxes: [
        { x: 24, y: 24, w: 20, h: 22 },
        { x: 76, y: 24, w: 20, h: 22 },
      ],
      fontSizePx: 22,
      outlineWidthPx: 1,
      policy: "balanced",
    });

    expect(result).not.toBeNull();
    expect(result?.regions).toHaveLength(2);
    expect(result?.regions[0].bounds.x).toBeLessThan(60);
    expect(result?.regions[1].bounds.x).toBeGreaterThan(60);
  });

  it("rejects an unbounded same-color flood", () => {
    const result = refineBubbleSafeMask({
      bitmap: createBitmap(245),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      bubbleBox: { x: 5, y: 5, w: 110, h: 60 },
      promptBoxes: [{ x: 45, y: 25, w: 30, h: 20 }],
      fontSizePx: 20,
      outlineWidthPx: 1,
      policy: "balanced",
    });
    expect(result).toBeNull();
  });

  it("repairs enclosed thick source glyphs only on the original-image path", () => {
    const bitmap = createBitmap(20);
    paintCircle(bitmap, 60, 35, 30, 245);
    for (const y of [18, 28, 38, 48]) {
      paintRect(bitmap, 43, y, 34, 5, 20);
    }

    const originalResult = refineBubbleSafeMask({
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      bubbleBox: { x: 25, y: 2, w: 70, h: 66 },
      promptBoxes: [{ x: 40, y: 14, w: 40, h: 44 }],
      fontSizePx: 22,
      outlineWidthPx: 1,
      policy: "balanced",
      repairOriginalTextInk: true,
    });

    expect(originalResult).not.toBeNull();
    expect(originalResult?.regions).toHaveLength(1);
    expect(originalResult?.regions[0].area).toBeGreaterThan(1_100);
  });

  it("does not restore a dark line that escapes the OCR prompt and crop", () => {
    const bitmap = createBitmap(20);
    paintCircle(bitmap, 60, 35, 30, 245);
    paintRect(bitmap, 58, 2, 5, 66, 20);

    const result = refineBubbleSafeMask({
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      bubbleBox: { x: 25, y: 2, w: 70, h: 66 },
      promptBoxes: [{ x: 50, y: 15, w: 20, h: 40 }],
      fontSizePx: 22,
      outlineWidthPx: 1,
      policy: "balanced",
      repairOriginalTextInk: true,
    });

    expect(result).toBeNull();
  });

  it("keeps a real narrow-neck pair split while repairing original text ink", () => {
    const bitmap = createBitmap(20);
    paintCircle(bitmap, 35, 35, 25, 245);
    paintCircle(bitmap, 85, 35, 25, 245);
    paintRect(bitmap, 55, 33, 11, 5, 245);
    paintRect(bitmap, 28, 28, 14, 4, 20);
    paintRect(bitmap, 78, 38, 14, 4, 20);

    const result = refineBubbleSafeMask({
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      bubbleBox: { x: 5, y: 5, w: 110, h: 60 },
      promptBoxes: [
        { x: 24, y: 24, w: 20, h: 22 },
        { x: 76, y: 24, w: 20, h: 22 },
      ],
      fontSizePx: 22,
      outlineWidthPx: 1,
      policy: "balanced",
      repairOriginalTextInk: true,
    });

    expect(result).not.toBeNull();
    expect(result?.regions).toHaveLength(2);
    expect(result?.regions[0].bounds.x).toBeLessThan(60);
    expect(result?.regions[1].bounds.x).toBeGreaterThan(60);
  });
});

function createBitmap(value: number): Uint8Array {
  const bitmap = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  }
  return bitmap;
}

function paintCircle(
  bitmap: Uint8Array,
  centerX: number,
  centerY: number,
  radius: number,
  value: number,
): void {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) {
        setPixel(bitmap, x, y, value);
      }
    }
  }
}

function paintRect(
  bitmap: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(bitmap, column, row, value);
    }
  }
}

function setPixel(
  bitmap: Uint8Array,
  x: number,
  y: number,
  value: number,
): void {
  const index = (y * WIDTH + x) * 4;
  bitmap[index] = value;
  bitmap[index + 1] = value;
  bitmap[index + 2] = value;
}
