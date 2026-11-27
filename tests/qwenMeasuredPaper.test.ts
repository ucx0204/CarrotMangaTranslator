import { agreesWithFadingPaper } from "../src/main/inpainting/qwenFadingPaper";
import {
  soundPenProof,
  soundPaperBoundary,
} from "../src/main/inpainting/qwenSoundPen";
import { marginCaptionPlate } from "../src/main/inpainting/qwenMarginCaption";
import { measureBalloonEdgeReading } from "../src/main/inpainting/qwenBalloonEdgeReading";
import {
  measuredPaperStop,
  finishPaperStop,
} from "../src/main/inpainting/qwenPaperStops";
import { measuredRuledShadow } from "../src/main/inpainting/qwenRuledShadow";
import {
  measurePaperLettering,
  finishPaperLettering,
} from "../src/main/inpainting/qwenPaperLettering";
import { expect, it } from "vitest";
import {
  measureQwenPaperGradient,
  pasteQwenPaperGradient,
} from "../src/main/inpainting/qwenPaperGradient";
import { measuredFringe } from "../src/main/inpainting/qwenPaperOwnership";
import {
  agreesWithPrintBanks,
  predictsHeldOutPaper,
} from "../src/main/inpainting/qwenGuideContinuity";
import { measureDuotoneOverprint } from "../src/main/inpainting/qwenOverprint";
import { resolvePreparedContext } from "../src/main/bubbleLayout/preparedContextualText";

const width = 90,
  height = 80;
const frame = { x: 0, y: 0, w: width, h: height },
  word = { x: 16, y: 18, w: 55, h: 43 };
function paper() {
  const source = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      source[at] = 252;
      source[at + 1] = 202 + Math.floor(y / 5);
      source[at + 2] = 168 + Math.floor(y / 4);
    }
  return source;
}

it("checks visible shaded paper opposite a white balloon before restoring the contour", () => {
  const original = Buffer.alloc(4 * width * height, 255);
  const stencil = new Uint8Array(width * height);
  const box = { x: 30, y: 24, w: 28, h: 32 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > y + 2) original.fill(204, 4 * i, 4 * i + 3);
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)
        stencil[i] = 1;
    }
  const plate = { width, height, original, inkBounds: box };
  const rule = soundPaperBoundary(plate, stencil);
  expect(rule?.condition[40 * width + 23]).toBe(1);
  expect(rule?.condition[40 * width + 18]).toBe(0);
  expect(rule?.confirms(original)).toBe(true);
  expect(rule?.confirms(Buffer.alloc(original.length, 110))).toBe(false);
  expect(
    soundPaperBoundary({ ...plate, inkBounds: null }, stencil),
  ).toBeUndefined();
  expect(
    soundPaperBoundary({ ...plate, inkBounds: { ...box, x: 4 } }, stencil),
  ).toBeUndefined();
  expect(
    soundPaperBoundary(
      { ...plate, original: Buffer.alloc(original.length, 255) },
      stencil,
    ),
  ).toBeUndefined();
  for (let i = 0; i < original.length; i += 4) original[i] = 20;
  expect(soundPaperBoundary(plate, stencil)).toBeUndefined();
});

it("requires four registered knocks and their separate accents before treating unlabelled strokes as sound", () => {
  const width = 160,
    height = 210,
    box = { x: 52, y: 39, w: 46, h: 141 };
  const original = Buffer.alloc(4 * width * height, 255),
    stencil = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x % 20 < (y < 90 ? 5 : 8)) original.fill(210, 4 * i, 4 * i + 3);
    }
  for (let k = 0; k < 4; k++)
    for (let y = 0; y < 25; y++)
      for (let x = 0; x < 17; x++) {
        const glyph = y < 16 && (y < 4 || y > 11 || x > 12);
        const accent = y >= 21 && x >= 4 && x < 15;
        if (!glyph && !accent) continue;
        const i = (box.y + 34 * k + y) * width + box.x + 12 * (k % 2) + x;
        stencil[i] = 1;
        original.fill(22, 4 * i, 4 * i + 3);
      }
  const plate = { width, height, original, inkBounds: box };
  const rule = soundPaperBoundary(plate, stencil, true);
  expect(rule?.confirms(original)).toBe(true);
  expect(soundPaperBoundary(plate, stencil)).toBeUndefined();
  stencil.fill(0, (box.y + 102) * width);
  expect(soundPaperBoundary(plate, stencil, true)).toBeUndefined();
});
it("recovers the measured blue gradient at each glyph and retains all other pixels", () => {
  const clean = paper(),
    image = Buffer.from(clean);
  for (let y = 23; y < 51; y++)
    for (let x = 22; x < 63; x += 12)
      image.fill(45, (y * width + x) * 4, (y * width + x) * 4 + 3);
  const patch = measureQwenPaperGradient(image, width, frame, word);
  expect(patch).toBeDefined();
  if (patch) pasteQwenPaperGradient(patch, image, width);
  expect(image.equals(clean)).toBe(true);
  expect(measureQwenPaperGradient(image, width, frame, word)).toBeUndefined();
});
it("refuses to remove a pen line crossing the OCR selection", () => {
  const image = paper();
  for (let x = 0; x < width; x++)
    image.fill(20, (32 * width + x) * 4, (32 * width + x) * 4 + 3);
  expect(measureQwenPaperGradient(image, width, frame, word)).toBeUndefined();
});
it("extends only nearby ink with no overlap with another reading", () => {
  const box = { x: 0, y: 0, w: 24, h: 20 };
  const data = new Uint8Array(480),
    owned = new Uint8Array(480);
  for (let y = 6; y < 13; y++)
    for (let x = 5; x < 16; x++) {
      data[y * 24 + x] = 1;
      if (x < 14) owned[y * 24 + x] = 1;
    }
  const letters = { bounds: box, data },
    owner = { bounds: box, data: owned };
  expect(
    measuredFringe(letters, owner, box, [])?.data.reduce((a, b) => a + b, 0),
  ).toBe(14);
  expect(
    measuredFringe(letters, owner, box, [{ x: 0, y: 0, w: 24, h: 20 }]),
  ).toBeUndefined();
  expect(
    measuredFringe(
      letters,
      { bounds: box, data: new Uint8Array(480) },
      box,
      [],
    ),
  ).toBeUndefined();
});
it("rejects a native fill with an invented dark interior on plain paper", () => {
  const pixels = Buffer.alloc(width * height * 4, 255),
    stencil = new Uint8Array(width * height);
  for (let y = 20; y < 55; y++)
    for (let x = 25; x < 57; x++) stencil[y * width + x] = 1;
  expect(agreesWithPrintBanks(pixels, stencil, width, height)).toBe(true);
  stencil.forEach((v, i) => {
    if (v) pixels.fill(20, 4 * i, 4 * i + 3);
  });
  expect(agreesWithPrintBanks(pixels, stencil, width, height)).toBe(false);
  expect(
    measureDuotoneOverprint(paper(), { width, height }, word),
  ).toBeUndefined();
});
it("reuses both successful and empty context measurements only for matching crops", async () => {
  const target = { id: "a", selected: word },
    next = { id: "b", selected: frame };
  const mask = { bounds: word, data: new Uint8Array(word.w * word.h) };
  const key = JSON.stringify([target.id, word, undefined, undefined]);
  const ready = new Map([[key, mask]]);
  expect(
    await resolvePreparedContext([target, next], ready, async (missing) => {
      expect(missing).toEqual([next]);
      return new Map();
    }),
  ).toEqual(new Map([["a", mask]]));
  expect(
    await resolvePreparedContext([target], new Map([[key, null]]), async () => {
      throw Error("unexpected inference");
    }),
  ).toEqual(new Map());
});

it("recovers a white reading with a dark halo only on a measured periodic bank", () => {
  const size = { width: 100, height: 135 },
    bounds = { x: 38, y: 36, w: 20, h: 50 };
  const data = new Uint8Array(bounds.w * bounds.h).fill(1);
  function sample(rules: boolean) {
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        const around = x >= 33 && x < 63 && y >= 31 && y < 91;
        const glyph = x >= 38 && x < 58 && y >= 36 && y < 86;
        const value = glyph
          ? 255
          : around
            ? 45
            : rules && x % 8 === 0
              ? 110
              : 248;
        const at = 4 * (y * size.width + x);
        bitmap.fill(value, at, at + 3);
      }
    return measuredRuledShadow(bitmap, size, { bounds, data });
  }
  const patch = sample(true);
  expect(patch).toBeDefined();
  if (!patch) throw Error("Missing ruled reading");
  expect(patch.data.reduce((a, b) => a + b, 0)).toBeGreaterThan(data.length);
  expect(sample(false)).toBeUndefined();
});

it("removes residual warm ink on pale paper while retaining an already repaired glyph and unrelated ink", () => {
  const bitmap = Buffer.alloc(width * height * 4, 246);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) bitmap[4 * (y * width + x) + 3] = 255;
  const rect = { x: 36, y: 13, w: 15, h: 54 };
  function paint(
    out: Buffer,
    x: number,
    y: number,
    h: number,
    colour: number[],
  ) {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + 5; col++)
        out.set(colour, 4 * (row * width + col));
  }
  for (const y of [16, 30, 45, 58]) paint(bitmap, 39, y, 7, [62, 60, 240, 255]);
  paint(bitmap, 65, 30, 9, [30, 30, 220, 255]);
  const patch = measurePaperLettering({
    bitmap,
    width,
    bounds: frame,
    selection: rect,
  });
  expect(patch).toBeDefined();
  if (!patch) throw Error("Missing red reading");
  const output = Buffer.from(bitmap);
  paint(output, 39, 30, 7, [207, 207, 207, 255]);
  finishPaperLettering(patch, output, width);
  expect(output[4 * (17 * width + 40)]).toBe(246);
  expect(output[4 * (30 * width + 40)]).toBe(207);
  expect(output[4 * (31 * width + 66)]).toBe(30);
});

it("keeps an outlined reading inside its own edit if a neighbouring reading crosses its reconstruction", () => {
  const word = { x: 32, y: 12, w: 25, h: 60 };
  const bitmap = Buffer.alloc(width * height * 4, 248);
  for (const y of [18, 32, 53])
    for (const x of [38, 47])
      for (let row = y; row < y + 8; row++)
        for (let col = x; col < x + 4; col++)
          bitmap.fill(40, 4 * (row * width + col), 4 * (row * width + col) + 3);
  const owner = {
    bounds: { x: 44, y: 0, w: 38, h: height },
    data: new Uint8Array(38 * height).fill(1),
  };
  const input = {
    bitmap,
    word,
    owner,
    page: { width, height },
    reading: "ふぁ…",
    peers: [],
  };
  expect(measureBalloonEdgeReading(input)?.bounds).toEqual(word);
  expect(
    measureBalloonEdgeReading({
      ...input,
      peers: [{ x: 42, y: 25, w: 4, h: 7 }],
    }),
  ).toBeUndefined();
  expect(
    measureBalloonEdgeReading({
      ...input,
      owner: { bounds: frame, data: new Uint8Array(width * height).fill(1) },
    }),
  ).toBeUndefined();
});

it("finishes a disconnected stop only when its original stem has already disappeared", () => {
  const bitmap = Buffer.alloc(width * height * 4, 248),
    word = { x: 28, y: 8, w: 27, h: 60 };
  for (let y = 44; y < 54; y++)
    for (let x = 34; x < 37; x++)
      bitmap.fill(34, 4 * (y * width + x), 4 * (y * width + x) + 3);
  for (let y = 56; y < 59; y++)
    for (let x = 34; x < 37; x++)
      bitmap.fill(45, 4 * (y * width + x), 4 * (y * width + x) + 3);
  const owner = { bounds: frame, data: new Uint8Array(width * height).fill(1) };
  const patch = measuredPaperStop(bitmap, width, word, owner, "あ!");
  if (!patch) throw Error("Missing stop");
  const output = Buffer.from(bitmap);
  finishPaperStop(patch, output, width);
  expect(output[4 * (57 * width + 35)]).toBe(45);
  for (const i of patch.stem) output.fill(246, 4 * i, 4 * i + 3);
  finishPaperStop(patch, output, width);
  expect(output[4 * (57 * width + 35)]).toBe(248);
});

it("uses held-out pixels to reject a model that loses the exposed black contour", () => {
  const n = 1000,
    mask = new Uint8Array(n),
    wide = new Uint8Array(n).fill(1),
    src = Buffer.alloc(n * 4, 244);
  for (let i = 0; i < 80; i++) src.fill(50, 4 * i, 4 * i + 3);
  mask.fill(1, 300, 500);
  expect(predictsHeldOutPaper(src, src, mask, wide)).toBe(true);
  expect(predictsHeldOutPaper(src, Buffer.alloc(n * 4, 244), mask, wide)).toBe(
    false,
  );
});
it("requires two pigment runs, a pale margin and both ends of the same panel rule", () => {
  const width = 175,
    height = 365,
    stencil = new Uint8Array(width * height);
  const original = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = 4 * (y * width + x);
      original.set([236, 234, 232, 255], at);
      if (x >= 100 && y > 158) original.fill(42, at, at + 3);
      if (x >= 55 && x < 105 && y >= 55 && y < 295) {
        stencil[y * width + x] = 1;
        if (x >= 61 && x < 85 && y < 151) original.set([62, 51, 224, 255], at);
        if (x >= 60 && x < 84 && y > 168) original.fill(59, at, at + 3);
      }
    }
  const input = { width, height, stencil, original };
  expect(marginCaptionPlate(input)).toBeUndefined();
  for (let x = 0; x < width; x++)
    for (let dy = 0; dy < 2; dy++) {
      const at = 4 * ((121 + Math.round((x - 55) * 0.14) + dy) * width + x);
      original.fill(24, at, at + 3);
    }
  const paint = marginCaptionPlate(input);
  if (!paint) throw Error("Missing registered page margin");
  const guide = Buffer.alloc(width * height * 4, 251);
  paint(guide);
  expect([
    ...guide.subarray(4 * (219 * width + 76), 4 * (219 * width + 76) + 3),
  ]).toEqual([236, 234, 232]);
  expect(guide[4 * (219 * width + 114)]).toBe(251);
});

it("requires the exposed and reconstructed stock to follow the same fade", () => {
  const width = 100,
    height = 120,
    inkBounds = { x: 32, y: 15, w: 33, h: 83 },
    original = Buffer.alloc(4 * width * height, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      original.fill(
        Math.min(255, 120 + y),
        4 * (y * width + x),
        4 * (y * width + x) + 3,
      );
  const input = { width, height, inkBounds, original };
  expect(agreesWithFadingPaper(input, original)).toBe(true);
  const damaged = Buffer.from(original);
  for (let y = 40; y < 73; y++)
    for (let x = 37; x < 60; x++)
      damaged.fill(16, 4 * (y * width + x), 4 * (y * width + x) + 3);
  expect(agreesWithFadingPaper(input, damaged)).toBe(false);
});
it("requires one continuous thin sound-effect pen across the original two ends", () => {
  const width = 100,
    height = 105,
    inkBounds = { x: 38, y: 32, w: 20, h: 41 },
    original = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++)
    original.fill(50, 4 * (y * width + 44), 4 * (y * width + 44) + 3);
  const proof = soundPenProof({ width, height, original, inkBounds });
  expect(proof?.(original)).toBe(true);
  const broken = Buffer.from(original);
  broken.fill(255, 4 * (50 * width + 44), 4 * (50 * width + 44) + 3);
  expect(proof?.(broken)).toBe(false);
});
