import { expect, it } from "vitest";
import { completeKeylinedKana } from "../src/main/inpainting/qwenSelectedPrint";
import { printMaskGrid } from "../src/main/inpainting/qwenPrintedPigment";

function printedKana(keyline = true, word = false) {
  const width = 190,
    height = 285;
  const rect = { x: 20, y: 15, w: 140, h: 244 };
  const masks = Array.from({ length: 7 }, () => new Uint8Array(width * height));
  const paint = (
    mark: number,
    left: number,
    top: number,
    h: number,
    thick: number,
    slant: number,
  ) => {
    for (let y = 0; y < h; y++) {
      const x = left + Math.round((y * slant) / (h - 1));
      masks[mark].fill(1, (top + y) * width + x, (top + y) * width + x + thick);
    }
  };
  if (word) {
    paint(0, 116, 26, 130, 7, -62);
    paint(0, 28, 58, 8, 101, 0);
    paint(0, 31, 89, 7, 84, 0);
    paint(5, 149, 39, 65, 7, -19);
    paint(6, 65, 151, 5, 39, 0);
    paint(6, 67, 167, 5, 37, 0);
    paint(6, 65, 183, 5, 39, 0);
    paint(6, 100, 151, 37, 5, 0);
  } else {
    paint(0, 90, 25, 44, 8, 12);
    paint(1, 119, 26, 43, 5, 5);
  }
  paint(2, 64, 204, 24, 7, 2);
  paint(3, 80, 206, 22, 7, 2);
  paint(4, 106, 216, 36, 6, -23);
  const selected = masks[0].map((v, i) =>
    Number(v || masks[2][i] || masks[3][i] || masks[5][i] || masks[6][i]),
  );
  const all = selected.map((v, i) => Number(v || masks[1][i] || masks[4][i]));
  const dist = printMaskGrid(width, height).distance(all);
  const bitmap = Buffer.alloc(width * height * 4, 255);
  dist.forEach((d, i) =>
    bitmap.fill(
      d === 0 ? 15 : keyline && d <= 4.2 ? 253 : 150 + (i % 2) * 16,
      4 * i,
      4 * i + 3,
    ),
  );
  const mask = { bounds: { x: 0, y: 0, w: width, h: height }, data: selected };
  const supplement = (text: string, source = rect, constraint?: typeof mask) =>
    completeKeylinedKana(
      bitmap,
      { width, height },
      source,
      mask,
      text,
      constraint,
    );
  return { supplement, mask, masks, rect, width };
}

it("completes the detached voiced accent and final small tsu only at their printed positions", () => {
  const a = printedKana(),
    extra = a.supplement("ギョッ");
  if (!extra) throw new Error("Expected the two unselected strokes");
  const at = (x: number, y: number) =>
    extra.data[(y - extra.bounds.y) * extra.bounds.w + x - extra.bounds.x];
  expect(at(123, 51)).toBe(1);
  expect(at(100, 228)).toBe(1);
  expect(at(100, 103)).toBe(0);
  expect(at(83, 214)).toBe(0);
  const unvoiced = a.supplement("シュッ");
  expect(unvoiced?.data.reduce((n, v) => n + v, 0)).toBeLessThan(
    extra.data.reduce((n, v) => n + v, 0),
  );
});

it("requires two selected taps and independent evidence for the missing accent", () => {
  const a = printedKana();
  a.mask.data = a.mask.data.map((v, i) =>
    Number(v && !a.masks[2][i] && !a.masks[0][i]),
  );
  expect(a.supplement("ギョッ")).toBeUndefined();
  const b = printedKana();
  b.mask.data = b.mask.data.map((v, i) =>
    Number(v || b.masks[1][i] || b.masks[4][i]),
  );
  expect(b.supplement("ギョッ")).toBeUndefined();
});

it("preserves drawn strokes without a white outline, shallow boxes and other readings", () => {
  expect(printedKana(false).supplement("ギョッ")).toBeUndefined();
  const a = printedKana();
  expect(a.supplement("ギョ")).toBeUndefined();
  expect(a.supplement("ギョッ", { ...a.rect, h: 80 })).toBeUndefined();
});

it("preserves the native panel between the three separately confirmed glyphs", () => {
  const a = printedKana(true, true),
    word = a.supplement("ギョッ")?.registered;
  if (!word) throw new Error("Missing contracted word registration");
  const pixel = (x: number, y: number) =>
    word.data[(y - word.bounds.y) * word.bounds.w + x - word.bounds.x];
  expect(pixel(46, 35)).toBe(0);
  expect(pixel(80, 169)).toBe(1);
  expect(pixel(100, 228)).toBe(1);
  const restricted = a.supplement("ギョッ", a.rect, {
    ...a.mask,
    data: a.mask.data.map(() => 0),
  })?.registered;
  expect(
    restricted?.data[
      (169 - word.bounds.y) * word.bounds.w + 80 - word.bounds.x
    ],
  ).toBe(0);
  expect(
    restricted?.data[
      (228 - word.bounds.y) * word.bounds.w + 100 - word.bounds.x
    ],
  ).toBe(1);
  a.mask.data = a.mask.data.map((v, i) => Number(v && !a.masks[6][i]));
  expect(a.supplement("ギョッ")?.registered).toBeUndefined();
});
