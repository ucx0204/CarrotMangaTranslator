import { describe, expect, it } from "vitest";
import { restoreRuledHeader } from "../src/main/inpainting/qwenRuledHeader";
import { restoreQwenPaper } from "../src/main/inpainting/qwenPaper";

function printedHeader() {
  const width = 360,
    height = 97;
  const box = { x: 21, y: 0, w: 312, h: 70 };
  const pixels = Buffer.alloc(width * height * 4, 255);
  const selection = new Uint8Array(width * height);
  const ink = (x: number, y: number, level: number) =>
    pixels.fill(level, 4 * (y * width + x), 4 * (y * width + x) + 3);
  for (let x = box.x - 3; x < width; x++) {
    ink(x, box.h, 39);
    ink(x, box.h + 1, 2);
    ink(x, box.h + 2, 173);
  }
  // A mark in the illustrated panel must survive bit-for-bit.
  ink(122, 78, 11);
  const blank = Buffer.from(pixels);
  for (let y = 0; y < box.h; y++)
    selection.fill(1, y * width + box.x, y * width + box.x + box.w);
  function printLine(top: number, em: number, pitch: number) {
    for (let x = box.x + 5; x < box.x + box.w - pitch; x += pitch)
      for (let v = 0; v < em; v++)
        for (let u = 0; u < pitch - 5; u++)
          if (u < 3 || v < 3 || Math.abs(v - em / 2) < 2)
            ink(x + u, top + v, 19);
  }
  printLine(5, 32, 28);
  printLine(48, 15, 15);
  ink(box.x + 8, 9, 227);
  return { pixels, selection, width, height, box, ink, blank };
}

describe("printed title above a continuous panel rule", () => {
  it("erases both sizes of type and the antialiasing without changing the ruled artwork", () => {
    const a = printedHeader();
    const repaired = restoreQwenPaper(
      a.pixels,
      a.selection,
      a.width,
      a.height,
      false,
    );
    expect(repaired?.equals(a.blank)).toBe(true);
  });
  it.each([
    "broken rule",
    "nearby caption",
    "third row",
    "unselected ink",
    "oversize drawing",
    "chroma",
    "textured stock",
    "inside panel",
  ] as const)("defers %s to the regular edit", (caseName) => {
    const { pixels, selection, width, height, box, ink } = printedHeader();
    if (caseName === "broken rule") ink(box.x + 100, box.h + 1, 214);
    if (caseName === "nearby caption") ink(box.x - 1, 24, 20);
    if (caseName === "third row") ink(box.x + 13, 42, 12);
    if (caseName === "unselected ink")
      for (let y = 4; y < 38; y++)
        selection.fill(0, y * width + box.x + 3, y * width + box.x + 30);
    if (caseName === "oversize drawing")
      for (let x = box.x + 5; x < box.x + 100; x++) ink(x, 16, 19);
    if (caseName === "chroma") pixels[4 * (18 * width + box.x + 16)] = 213;
    if (caseName === "textured stock") ink(box.x + 95, 41, 216);
    if (caseName === "inside panel") selection.fill(0, 0, width * 5);
    expect(
      restoreRuledHeader(pixels, selection, width, height),
    ).toBeUndefined();
  });
});
