import { describe, expect, it } from "vitest";
import { missingBalloonReadings } from "../src/main/inpainting/qwenBalloonReadings";
import { maskComponents } from "../src/main/inpainting/rasterMasks";
import { restoreQwenPaper } from "../src/main/inpainting/qwenPaper";

function printedBalloon() {
  const width = 120;
  const height = 104;
  const dark = new Uint8Array(width * height);
  const stencil = new Uint8Array(dark.length);
  const original = Buffer.alloc(4 * dark.length, 255);
  const restored = Buffer.from(original);
  function print(
    x: number,
    y: number,
    w: number,
    h: number,
    selected: boolean,
    erased: boolean,
    outline = false,
  ) {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        if (outline && row && col && row < h - 1 && col < w - 1) continue;
        const i = (y + row) * width + x + col;
        dark[i] = 1;
        stencil[i] = Number(selected);
        original.fill(25, 4 * i, 4 * i + 3);
        if (!erased) restored.fill(25, 4 * i, 4 * i + 3);
      }
    }
  }
  const readings = () =>
    missingBalloonReadings(
      original,
      restored,
      maskComponents(dark, width, height, 4),
      stencil,
      width,
      height,
    ).map(({ rect }) => [rect.x, rect.y]);
  return {
    print,
    readings,
    width,
    restore: () => restoreQwenPaper(original, stencil, width, height),
  };
}

describe("small native readings between restored print", () => {
  it("clears the whole printed pause on measured paper when the detector selects only its last dot", () => {
    const { print, restore, width } = printedBalloon();
    print(36, 13, 18, 12, true, false, true);
    print(36, 60, 18, 18, true, false, true);
    print(69, 31, 14, 13, true, false, true);
    for (const y of [32, 40, 48]) print(43, y, 4, 4, y === 48, false, true);
    print(93, 40, 4, 4, false, false, true);
    const paper = restore();
    if (!paper) throw Error("Expected the original white balloon stock");
    expect([32, 40, 48].map((y) => paper[4 * (y * width + 43)])).toEqual([
      255, 255, 255,
    ]);
    expect(paper[4 * (40 * width + 93)]).toBe(25);
  });

  it("recognizes a selected small reading flanked by two erased main characters", () => {
    const { print, readings } = printedBalloon();
    print(21, 31, 18, 22, true, true);
    print(50, 31, 18, 22, true, true);
    print(49, 61, 22, 22, true, true);
    print(41, 38, 7, 7, true, false, true);
    print(79, 38, 7, 7, true, false, true);
    expect(readings()).toEqual([[41, 38]]);
  });

  it.each([
    [true, 40, 2],
    [false, 40, 0],
    [true, 84, 0],
  ])(
    "requires both printed pieces in the restored text column (%s, %i)",
    (dotSelected, x, expected) => {
      const { print, readings } = printedBalloon();
      print(31, 9, 18, 15, true, true);
      print(32, 30, 18, 16, true, true);
      print(69, 25, 18, 17, true, true);
      print(x, 57, 5, 15, true, false);
      print(x + 5, 57, 4, 15, false, false);
      print(x - 1, 74, 4, 5, dotSelected, false);
      expect(readings()).toHaveLength(expected);
    },
  );

  it.each([
    [48, true, 2],
    [52, true, 0],
    [48, false, 0],
  ])(
    "requires an evenly spaced trio with an erased dot (%i, %s)",
    (lastRow, erasedDot, expected) => {
      const { print, readings } = printedBalloon();
      print(36, 13, 18, 12, true, true);
      print(36, 60, 18, 18, true, true);
      print(69, 31, 14, 13, true, true);
      print(43, 32, 4, 4, false, false);
      print(43, 40, 4, 4, false, false);
      print(43, lastRow, 4, 4, true, erasedDot);
      expect(readings()).toHaveLength(expected);
    },
  );
});
