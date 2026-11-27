import { describe, expect, it } from "vitest";
import { measuredDotModulation } from "../src/main/inpainting/qwenDotModulation";

function printedSound(noisy = false) {
  const width = 252,
    height = 150,
    stencil = new Uint8Array(width * height);
  const original = Buffer.alloc(width * height * 4, 255),
    weak = Buffer.from(original),
    truth = Buffer.from(original),
    opposite = Buffer.from(original);
  let state = 1004;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        selected =
          (x >= 44 && x < 206 && y >= 66 && y < 84) ||
          (x >= 110 && x < 125 && y >= 52 && y < 90);
      stencil[i] = selected ? 255 : 0;
      const tone = 212 + (15 * x) / width,
        screen =
          18 *
          (noisy
            ? 2 * random() - 1
            : Math.cos((2 * Math.PI * x) / 5) *
              Math.cos((2 * Math.PI * y) / 5));
      for (let c = 0; c < 3; c++) {
        truth[4 * i + c] = Math.round(tone + screen + 2 * c);
        original[4 * i + c] = selected ? 40 : truth[4 * i + c];
        weak[4 * i + c] = selected
          ? Math.round(tone + 0.47 * screen + 2 * c)
          : truth[4 * i + c];
        opposite[4 * i + c] = selected
          ? Math.round(tone - 0.43 * screen + 2 * c)
          : truth[4 * i + c];
      }
    }
  return { width, height, original, stencil, truth, weak, opposite };
}
describe("weak rendered print modulation", () => {
  it("borrows exposed colour dots when the same weak screen survives under erased glyphs", () => {
    const img = printedSound(),
      repair = measuredDotModulation(img);
    if (!repair) throw Error("Expected a measured dot screen");
    const out = repair(img.weak);
    if (!out)
      throw Error("Expected measured native dots under the faded stroke");
    let before = 0,
      after = 0;
    for (let i = 0; i < img.stencil.length; i++)
      if (img.stencil[i])
        for (let c = 0; c < 3; c++) {
          before += Math.abs(img.weak[4 * i + c] - img.truth[4 * i + c]);
          after += Math.abs(out[4 * i + c] - img.truth[4 * i + c]);
        }
    expect(after).toBeLessThan(0.6 * before);
    expect(repair(img.truth)).toBeUndefined();
    expect(repair(img.opposite)).toBeUndefined();
  });
  it("preserves the original drawing when native dots cannot predict unobserved paper", () => {
    expect(measuredDotModulation(printedSound(true))).toBeUndefined();
  });
  it("leaves transparent and unselected paper unchanged", () => {
    const img = printedSound();
    img.original[(80 * img.width + 105) * 4 + 3] = 0;
    expect(measuredDotModulation(img)).toBeUndefined();
    img.stencil.fill(0);
    expect(measuredDotModulation(img)).toBeUndefined();
  });
  it("requires dark original typography and exposed print", () => {
    const img = printedSound();
    expect(
      measuredDotModulation({ ...img, original: img.truth }),
    ).toBeUndefined();
    for (let i = 0; i < img.stencil.length; i++)
      if (!img.stencil[i]) img.original.fill(255, 4 * i, 4 * i + 3);
    expect(measuredDotModulation(img)).toBeUndefined();
  });
});
