import { describe, expect, it } from "vitest";
import { compositeFluxOutput } from "../src/main/inpainting/imageRaster";
import { prepareFluxComposite } from "../src/main/inpainting/fluxCompositeConstraint";

describe("Flux bubble composite constraints", () => {
  it("matches Euclidean falloff for non-binary mask values and blends the native alpha at the same weight", () => {
    const width = 17,
      height = 11,
      rect = { x: 0, y: 0, w: width, h: height };
    const points = [
      [0, 3],
      [7, 9],
      [15, 2],
      [16, 10],
    ];
    const core = new Uint8Array(width * height);
    points.forEach(([x, y], i) => {
      core[y * width + x] = [1, 5, 128, 255][i];
    });
    for (const feather of [0, 1, 3, 6]) {
      const dest = Buffer.alloc(width * height * 4, 0),
        generated = Buffer.alloc(dest.length, 0);
      for (let p = 0; p < core.length; p++) {
        dest[p * 4 + 3] = 192;
        generated[p * 4] = 48;
        generated[p * 4 + 3] = 64;
      }
      compositeFluxOutput(
        dest,
        generated,
        core,
        width,
        rect,
        feather,
        rect,
        undefined,
        true,
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const distance = Math.min(
            ...points.map(([cx, cy]) => Math.hypot(x - cx, y - cy)),
          );
          const weight =
            distance === 0
              ? 1
              : feather
                ? Math.max(0, 1 - distance / feather)
                : 0;
          const i = (y * width + x) * 4;
          expect(dest[i]).toBe(Math.round(48 * weight));
          expect(dest[i + 3]).toBe(
            Math.round(192 * (1 - weight) + 64 * weight),
          );
        }
    }
  });
  it("matches the full feather scan at page edges, mask holes and clipped write bounds", () => {
    const width = 37,
      height = 31;
    const tile = { x: 5, y: 2, w: 22, h: 25 };
    const write = { x: 7, y: 11, w: 17, h: 12 };
    for (const bounds of [
      { x: 0, y: 13, w: 12, h: 5 },
      { x: 14, y: 0, w: 5, h: 12 },
      { x: 23, y: 22, w: 7, h: 9 },
    ]) {
      const core = new Uint8Array(width * height);
      for (let y = bounds.y; y < bounds.y + bounds.h; y++)
        for (let x = bounds.x; x < bounds.x + bounds.w; x++)
          core[y * width + x] = Number((x + y) % 3 !== 0);
      for (const feather of [0, 1, 4, 12]) {
        const reference = createBitmap(width, height, 12),
          actual = Buffer.from(reference);
        const generated = createBitmap(tile.w, tile.h, 210);
        compositeFluxOutput(
          reference,
          generated,
          core,
          width,
          tile,
          feather,
          write,
        );
        const owned = { bounds, data: new Uint8Array(bounds.w * bounds.h) };
        for (let y = 0; y < bounds.h; y++)
          owned.data.set(
            core.subarray(
              (bounds.y + y) * width + bounds.x,
              (bounds.y + y) * width + bounds.x + bounds.w,
            ),
            y * bounds.w,
          );
        prepareFluxComposite({
          compositeMasks: [owned],
          width,
          height,
          index: 0,
          effectiveMask: core,
          featherPx: feather,
        })(actual, generated, {
          paddedBounds: tile,
          writeBounds: write,
          localMask: core,
          validationMask: core,
          processSize: { width: tile.w, height: tile.h },
        });
        expect(actual.equals(reference)).toBe(true);
      }
    }
  });
  it("does not feather across the right edge into the next row's mask", () => {
    const width = 9;
    const height = 4;
    const bitmap = createBitmap(width, height, 10);
    const core = new Uint8Array(width * height);
    core[width] = 1;
    compositeFluxOutput(
      bitmap,
      createBitmap(width, height, 240),
      core,
      width,
      { x: 0, y: 0, w: width, h: height },
      3,
    );
    expect(readValue(bitmap, width, 8, 0)).toBe(10);
    expect(readValue(bitmap, width, 7, 0)).toBe(10);
    expect(readValue(bitmap, width, 0, 1)).toBe(240);
    expect(readValue(bitmap, width, 1, 1)).toBeGreaterThan(10);
  });

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

  it("uses a narrow final core even when the model receives a broad mask", () => {
    const width = 9;
    const height = 9;
    const bitmap = createBitmap(width, height, 10);
    const generated = createBitmap(width, height, 240);
    const modelMask = new Uint8Array(width * height).fill(1);
    const core = new Uint8Array(width * height);
    const envelope = new Uint8Array(width * height);
    core[4 * width + 4] = 1;
    for (let x = 2; x <= 6; x += 1) envelope[4 * width + x] = 1;

    prepareFluxComposite({
      compositeConstraints: [
        { bounds: { x: 0, y: 0, w: width, h: height }, data: envelope },
      ],
      compositeMasks: [
        { bounds: { x: 0, y: 0, w: width, h: height }, data: core },
      ],
      effectiveMask: modelMask,
      featherPx: 3,
      height,
      index: 0,
      width,
    })(bitmap, generated, {
      localMask: modelMask,
      paddedBounds: { x: 0, y: 0, w: width, h: height },
      processSize: { width, height },
      validationMask: modelMask,
      writeBounds: { x: 0, y: 0, w: width, h: height },
    });

    expect(readValue(bitmap, width, 4, 4)).toBe(240);
    expect(readValue(bitmap, width, 5, 4)).toBeGreaterThan(10);
    expect(readValue(bitmap, width, 1, 4)).toBe(10);
    expect(readValue(bitmap, width, 4, 1)).toBe(10);
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
