import { assert, describe, expect, it } from "vitest";
import { recoverQwenLuminousLettering } from "../src/main/inpainting/qwenLuminousLettering";
import { recoverQwenDisplayMask } from "../src/main/inpainting/qwenUndetectedDisplay";
import { addBracketedRule } from "../src/main/inpainting/qwenPrintedDash";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";

const width = 382,
  height = 168;
const selection = { x: 21, y: 32, w: 338, h: 99 };
const index = (x: number, y: number) => y * width + x;
function lettering(count = 7, background = 53) {
  const bitmap = Buffer.alloc(4 * width * height, 255);
  for (let i = 0; i < width * height; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const letter = inkAt(x, y, count);
    const star = Math.hypot(x - 211, y - 26) < 3;
    const luminance = letter || star ? 252 : background;
    bitmap.fill(luminance, 4 * i, 4 * i + 3);
  }
  return bitmap;
}

function inkAt(x: number, y: number, count: number) {
  const cell = Math.floor((x - 36) / 43);
  if (cell < 0 || cell >= count) return false;
  const u = (x - 36) % 43,
    v = y - 56;
  if (u >= 26 || v < 0 || v > 31) return false;
  return u < 5 || v < 5 || (v >= 13 && v <= 17 && u <= 20) || v > 26;
}

describe("white outlined cover lettering", () => {
  it("recovers the printed face and dark rim from a page selection while retaining a native star", () => {
    const source = lettering();
    const result = recoverQwenDisplayMask(source, { width, height }, selection);
    assert.isDefined(result);
    const mask = expandWindowMaskToPage(result, width, height);
    expect(mask[index(38, 72)]).toBe(1);
    expect(mask[index(34, 72)]).toBe(1);
    expect(mask[index(69, 79)]).toBe(0);
    expect(mask[index(211, 26)]).toBe(0);
    expect(mask[index(303, 108)]).toBe(0);
  });

  it("requires several distributed strokes with genuine dark banks", () => {
    const measure = (source: Buffer) =>
      recoverQwenLuminousLettering(source, { width, height }, selection);
    expect(measure(lettering(2))).toBeUndefined();
    expect(
      recoverQwenLuminousLettering(
        lettering(5),
        { width, height },
        { ...selection, x: 0, w: width },
      ),
    ).toBeUndefined();
    expect(measure(lettering(7, 180))).toBeUndefined();
    expect(measure(Buffer.alloc(width * height * 4, 255))).toBeUndefined();
  });

  it("recovers a slanted dash when both round stops have a stem above them", () => {
    const source = lettering(6);
    for (let y = 84; y < 128; y++) {
      for (let x = 164; x < 332; x++) {
        const punctuation = [
          [301, 115],
          [317, 112],
        ].some(
          ([cx, cy]) =>
            Math.hypot(x - cx, y - cy) <= 4.25 ||
            ((x - cx) / 4.3) ** 2 + ((y - cy + 16) / 8.5) ** 2 <= 1,
        );
        const axis = 105 - (x - 301) * 0.1875;
        const white =
          x >= 176 && x <= 289
            ? 53 + 200 * Math.max(0, 1 - Math.abs(y - axis) / 1.3)
            : 53;
        if (punctuation || white > 53)
          source.fill(
            punctuation ? 252 : Math.round(white),
            index(x, y) * 4,
            index(x, y) * 4 + 3,
          );
      }
    }
    const result = recoverQwenLuminousLettering(
      source,
      { width, height },
      selection,
    );
    assert.isDefined(result);
    const mask = expandWindowMaskToPage(result, width, height);
    expect(mask[index(301, 115)]).toBe(1);
    expect(mask[index(317, 112)]).toBe(1);
    expect(mask[index(258, 113)]).toBe(1);
    expect(mask[index(250, 121)]).toBe(0);
  });
});

function candidateRule(paired: boolean) {
  const tone = new Uint8Array(width * height).fill(42);
  const data = new Uint8Array(width * height);
  const field = { tone, w: width, h: height, selection };
  const point = (x: number, y: number) => ({
    cx: x,
    cy: y,
    rect: { x: x - 4, y: y - 4, w: 8, h: 8 },
  });
  for (let x = 168; x <= 287; x++) {
    const y = 112 - (x - 168) * 0.17;
    for (let py = Math.floor(y) - 1; py <= Math.ceil(y) + 1; py++)
      tone[index(x, py)] = Math.round(
        42 + 210 * Math.max(0, 1 - Math.abs(py - y) / 1.3),
      );
  }
  addBracketedRule(
    field,
    data,
    point(298, 99),
    point(313, paired ? 96.5 : 102),
  );
  return data;
}

it("continues only the thin dash at the measured inclination of two punctuation marks", () => {
  const confirmed = candidateRule(true);
  expect(confirmed[index(195, 107)]).toBe(1);
  expect(confirmed[index(194, 99)]).toBe(0);
  expect(confirmed[index(146, 118)]).toBe(0);
  expect(candidateRule(false).some(Boolean)).toBe(false);
});
