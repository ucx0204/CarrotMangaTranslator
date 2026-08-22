import { describe, expect, it } from "vitest";
import { compositeGeneratedPageWithWindowMasks } from "../src/main/inpainting/pageMaskComposite";

describe("generated page typography composite", () => {
  it("keeps the core fully opaque and feathers only inside its envelope", () => {
    const width = 9;
    const height = 9;
    const bitmap = createBitmap(width, height, 10);
    const generated = createBitmap(width, height, 250);
    const core = new Uint8Array(width * height);
    const envelope = new Uint8Array(width * height);
    core[4 * width + 4] = 1;
    for (let x = 2; x <= 6; x += 1) envelope[4 * width + x] = 1;

    compositeGeneratedPageWithWindowMasks({
      bitmap,
      compositeConstraints: [
        { bounds: { x: 0, y: 0, w: width, h: height }, data: envelope },
      ],
      compositeFeatherPx: [3],
      compositeMasks: [
        { bounds: { x: 0, y: 0, w: width, h: height }, data: core },
      ],
      generated,
      height,
      width,
    });

    expect(readValue(bitmap, width, 4, 4)).toBe(250);
    expect(readValue(bitmap, width, 5, 4)).toBeGreaterThan(10);
    expect(readValue(bitmap, width, 5, 4)).toBeLessThan(250);
    expect(readValue(bitmap, width, 1, 4)).toBe(10);
    expect(readValue(bitmap, width, 4, 3)).toBe(10);
  });

  it("rejects a composite inventory that cannot bind every mask", () => {
    expect(() =>
      compositeGeneratedPageWithWindowMasks({
        bitmap: createBitmap(2, 2, 10),
        compositeFeatherPx: [],
        compositeMasks: [
          {
            bounds: { x: 0, y: 0, w: 2, h: 2 },
            data: new Uint8Array(4),
          },
        ],
        generated: createBitmap(2, 2, 250),
        height: 2,
        width: 2,
      }),
    ).toThrow("inventory drifted");
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
