import { describe, expect, it } from "vitest";
import { restoreMirroredFrameCorner } from "../src/main/inpainting/qwenFrameCorner";

const width = 480,
  height = 255,
  left = 65,
  right = 374,
  top = 48;
const crop = { x: 292, y: 12, w: 160, h: 221 };

function original(x: number, y: number) {
  const u = Math.min(x - left, right - x),
    v = y - top;
  if (v < 0 || u < 0 || u + v < 21)
    return u < 0 && u >= -11 && v > -u + 52 ? 215 : 254;
  if (u <= 1 || v <= 1 || u + v <= 22) return 55;
  if (u < 22 || v < 20) return 149;
  return 212;
}

function marked(x: number, y: number) {
  return (
    y >= top + 10 &&
    y < top + 98 &&
    ((x > right - 23 && x < right - 15) ||
      (x > right + 7 && x < right + 17) ||
      (x > right + 24 && x < right + 30))
  );
}

function fixture(hasOpposite: boolean, realBracket: boolean) {
  const source = Buffer.alloc(width * height * 4, 255),
    generated = Buffer.alloc(crop.w * crop.h * 4, 255);
  const selected = new Uint8Array(crop.w * crop.h);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x - right,
        v = y - top;
      const bracket =
        u > 1 &&
        u <= 32 &&
        (Math.abs(v - (21 + u)) < 1.5 || Math.abs(v - 53) < 1.5);
      const wall = hasOpposite || x > left + 60 ? original(x, y) : 254;
      const stock = bracket && realBracket ? 126 : wall;
      const ink = marked(x, y);
      const index = 4 * (y * width + x);
      source.fill(ink ? 18 : stock, index, index + 3);
      if (
        x < crop.x ||
        y < crop.y ||
        x >= crop.x + crop.w ||
        y >= crop.y + crop.h
      )
        continue;
      const i = (y - crop.y) * crop.w + x - crop.x;
      selected[i] = Number(ink);
      generated.fill(bracket ? 126 : wall, 4 * i, 4 * i + 3);
    }
  return { width, height, source, generated, crop, selected };
}

describe("native frame corner registration", () => {
  it("erases a line projected onto the wall by a decoded crop and preserves the original post and shadow", () => {
    const view = fixture(true, false);
    expect(restoreMirroredFrameCorner(view)).toBe(true);
    const pixel = (x: number, y: number) =>
      view.generated[4 * ((y - crop.y) * crop.w + x - crop.x)];
    expect(pixel(right + 18, top + 39)).toBe(original(right + 18, top + 39));
    expect(pixel(right + 10, top + 53)).toBe(original(right + 10, top + 53));
    expect(pixel(right, top + 65)).toBe(original(right, top + 65));
    expect(pixel(right + 7, top + 88)).toBe(original(right + 7, top + 88));
  });
  it.each([
    [false, false],
    [true, true],
  ])(
    "requires a corroborating second corner and original paper (%s, %s)",
    (peer, real) => {
      const view = fixture(peer, real),
        before = Buffer.from(view.generated);
      expect(restoreMirroredFrameCorner(view)).toBe(false);
      expect(view.generated.equals(before)).toBe(true);
    },
  );
});
