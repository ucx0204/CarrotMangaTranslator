import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { SoundEffectReviewRegion } from "../src/shared/soundEffectReview";
import {
  withApprovedImageRedactions,
  externalImageMask,
} from "../src/main/imageRedactionContext";
import {
  applySoundEffectTargetHighlight,
  resolveSoundEffectContextSize,
  resolveSoundEffectCropSize,
  buildSoundEffectTranslationImages,
} from "../src/main/jobs/soundEffectTranslationImages";

// Native raster boundary only; the crop builder, disk writes and redaction
// coordinate registration execute their production implementations.
vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: () => raster(200, 100),
    createFromBitmap: (data: Buffer, size: { width: number; height: number }) =>
      raster(size.width, size.height, data),
  },
}));
function raster(
  width: number,
  height: number,
  data: Buffer = Buffer.alloc(width * height * 4, 255),
) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(data),
    toPNG: () =>
      PNG.sync.write(Object.assign(new PNG({ width, height }), { data })),
    resize: (size: { width: number; height: number }) =>
      raster(size.width, size.height),
    crop: (rect: { width: number; height: number }) =>
      raster(rect.width, rect.height),
  };
}

describe("sound-effect translation images", () => {
  it("registers both generated references with the original redaction coordinates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfx-reference-"));
    const imagePath = join(directory, "source.png");
    try {
      await withApprovedImageRedactions(
        [
          {
            id: "page",
            name: "source.png",
            imagePath,
            width: 200,
            height: 100,
            fingerprint: "a".repeat(64),
            strokes: [{ shape: "square", size: 4, points: [{ x: 5, y: 5 }] }],
          },
        ],
        async () => {
          const result = await buildSoundEffectTranslationImages(
            { imagePath } as MangaPage,
            {
              id: "sfx",
              bbox: { x: 400, y: 400, w: 200, h: 200 },
            } as SoundEffectReviewRegion,
            directory,
            async () => null,
          );
          const context = PNG.sync.read(await readFile(result.context.path));
          expect(context.width).toBe(200);
          expect(context.height).toBe(100);
          expect(
            externalImageMask(result.context.path, 200, 100)?.[5 * 200 + 5],
          ).toBe(255);
          const cropMask = externalImageMask(
            result.crop.path,
            result.crop.width,
            result.crop.height,
          );
          expect(cropMask?.some(Boolean)).toBe(false);
          expect((await readFile(result.crop.path)).length).toBeGreaterThan(0);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
