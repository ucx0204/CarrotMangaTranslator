import { describe, expect, it } from "vitest";
import {
  applySoundEffectTargetHighlight,
  resolveSoundEffectContextSize,
  resolveSoundEffectCropSize,
} from "../src/main/jobs/soundEffectTranslationImages";

describe("sound-effect translation images", () => {
  it("keeps whole-page context near a 720p pixel budget", () => {
    expect(resolveSoundEffectContextSize(1200, 1800)).toEqual({
      width: 784,
      height: 1176,
    });
    const long = resolveSoundEffectContextSize(800, 12_000);
    expect(long.height).toBe(1600);
    expect(long.width).toBe(107);
    expect(resolveSoundEffectContextSize(600, 700)).toEqual({
      width: 600,
      height: 700,
    });
  });

  it("enlarges the authoritative crop without exceeding its long-side cap", () => {
    expect(resolveSoundEffectCropSize(100, 200)).toEqual({
      width: 384,
      height: 768,
    });
    expect(resolveSoundEffectCropSize(25, 150)).toEqual({
      width: 171,
      height: 1024,
    });
    expect(resolveSoundEffectCropSize(800, 900)).toEqual({
      width: 800,
      height: 900,
    });
  });

  it("marks only the target with cyan tint and a magenta outline", () => {
    const width = 100;
    const height = 100;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    applySoundEffectTargetHighlight(bitmap, width, height, {
      x: 20,
      y: 20,
      w: 60,
      h: 60,
    });
    expect(readPixel(bitmap, width, 20, 20)).toEqual([143, 45, 255, 255]);
    expect(readPixel(bitmap, width, 50, 50)).toEqual([255, 250, 219, 255]);
    expect(readPixel(bitmap, width, 5, 5)).toEqual([255, 255, 255, 255]);
  });
});

function readPixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): number[] {
  const offset = (y * width + x) * 4;
  return [...bitmap.subarray(offset, offset + 4)];
}
