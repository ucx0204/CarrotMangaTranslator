import { expect, it, vi } from "vitest";
import { restoreLightEffectGradient } from "../src/main/inpainting/qwenPaperBank";
import * as poisson from "../src/main/inpainting/retouchPoisson";
import { measureSmallSelectedSound } from "../src/main/inpainting/qwenSmallSound";
import { measureFramedSoundWithPause } from "../src/main/inpainting/qwenFramedScreen";
import { framedSoundInk } from "../src/main/inpainting/qwenFramedScreen";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import {
  pausedVocalStrokes,
  punctuatedVocalStrokes,
} from "../src/main/inpainting/qwenVocalStrokes";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { measureHorizontalSound } from "../src/main/inpainting/qwenHorizontalSound";
import { restoreQwenPaper } from "../src/main/inpainting/qwenPaper";
import {
  measureRuledSound,
  restoreRuledSoundPaper,
} from "../src/main/inpainting/qwenRuledPaper";
import { mergeMaskIntoPage } from "../src/main/inpainting/maskGeometry";
import {
  measureSelectedSignType,
  restoreSelectedSignType,
} from "../src/main/inpainting/qwenSignType";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import { alternateCoverBounds } from "../src/main/inpainting/qwenCoverViews";
import type { InpaintingWindowMask } from "../src/main/inpainting/inpaintingEngine";
import {
  qwenControlSampling,
  referenceEditMode,
} from "../src/main/inpainting/qwenControlSampling";

it("reconstructs a light ramp through effect strokes and keeps dark, coloured and page-edge banks intact", () => {
  const width = 100,
    height = 88,
    mask = new Uint8Array(width * height);
  const expected = Buffer.alloc(4 * mask.length, 255);
  for (let i = 0; i < mask.length; i++)
    expected.fill(205 + Math.floor((i % width) / 2), i * 4, i * 4 + 3);
  for (let y = 22; y < 51; y++) mask.fill(1, y * width + 24, y * width + 52);
  const original = Buffer.from(expected);
  mask.forEach((on, i) => {
    if (on) original.fill(25, 4 * i, 4 * i + 3);
  });
  const solve = (signal = new AbortController().signal) =>
    restoreLightEffectGradient(original, mask, width, signal);
  const repaired = solve();
  expect.assert(repaired);
  expect(
    repaired.every(
      (v, i) => Math.abs(v - expected[i]) <= (mask[Math.floor(i / 4)] ? 1 : 0),
    ),
  ).toBe(true);
  expect(() => solve(AbortSignal.abort())).toThrow();
  const solver = vi.spyOn(poisson, "solvePoissonChannel");
  try {
    solver.mockImplementationOnce(() => {
      throw new poisson.PoissonConvergenceError("no convergence");
    });
    expect(solve()).toBeUndefined();
    solver.mockImplementationOnce(() => {
      throw new TypeError("unexpected");
    });
    expect(solve).toThrow("unexpected");
  } finally {
    solver.mockRestore();
  }
  const neighbor = 4 * (30 * width + 23);
  for (const rgba of [
    [175, 175, 175, 255],
    [229, 240, 240, 255],
    [245, 245, 245, 127],
  ]) {
    original.set(rgba, neighbor);
    expect(solve()).toBeUndefined();
  }
  mask.fill(0);
  expect(solve()).toBeUndefined();
  mask[0] = 1;
  expect(solve()).toBeUndefined();
});

function drawing(background: number) {
  const size = { width: 100, height: 90 };
  const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
  function paint(x: number, y: number, w: number, h: number, gray: number) {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) {
        const i = 4 * (row * size.width + col);
        bitmap.fill(gray, i, i + 3);
      }
  }
  paint(0, 0, size.width, size.height, background);
  return { bitmap, size, paint };
}

it("removes unaligned handwritten kana with paired voicing marks from verified white paper", () => {
  const { bitmap, size, paint } = drawing(255);
  const { width, height } = size;
  const owned = new Uint8Array(width * height);
  const stroke = (x: number, y: number, w: number, h: number) => {
    paint(x, y, w, h, 14);
    for (let row = y; row < y + h; row++)
      owned.fill(1, row * width + x, row * width + x + w);
  };
  stroke(20, 23, 4, 30);
  stroke(20, 30, 23, 4);
  stroke(41, 15, 4, 11);
  stroke(47, 14, 4, 12);
  stroke(59, 43, 3, 16);
  stroke(59, 47, 15, 3);
  stroke(52, 65, 4, 6);
  paint(9, 8, 2, 69, 14);
  const stencil = Uint8Array.from(distanceToMask(owned, width, height), (d) =>
    Number(d <= 1.5),
  );
  const result = restoreQwenPaper(bitmap, stencil, width, height, false);
  expect(result?.[4 * (32 * width + 32)]).toBe(255);
  expect(result?.[4 * (18 * width + 47)]).toBe(255);
  expect(result?.[4 * (32 * width + 9)]).toBe(14);
});

it("requires both a registered dash tip and equally spaced punctuation with separate dots", () => {
  const rect = { x: 0, y: 0, w: 82, h: 130 };
  const part = (x: number, y: number, w: number, h: number) => ({
    rect: { x, y, w, h },
    area: w * h,
    data: new Uint8Array(w * h).fill(1),
  });
  const run = (dashX: number, secondX: number, secondH = 17) => {
    const parts = [
      part(dashX, 6, 3, 89),
      part(32, 99, 4, 17),
      part(32, 118, 4, 4),
      part(secondX, 98, 4, secondH),
      part(secondX, 100 + secondH, 4, 4),
    ];
    return punctuatedVocalStrokes(parts, rect, "ー!!");
  };
  expect(run(35, 39)).toHaveLength(5);
  expect(run(4, 39)).toBeUndefined();
  expect(run(35, 56)).toBeUndefined();
  expect(run(35, 39, 12)).toBeUndefined();
  expect(punctuatedVocalStrokes([], rect, "ー!!")).toBeUndefined();
  const placement = { rect, bounds: rect };
  const head = part(19, 10, 31, 34),
    tail = part(34, 105, 12, 13);
  const pause = (middleX: number, middleY: number) =>
    pausedVocalStrokes(
      [
        head,
        part(36, 65, 4, 4),
        part(middleX, middleY, 4, 4),
        part(38, 85, 4, 4),
        tail,
      ],
      placement,
      false,
    );
  expect(pause(37, 75)).toHaveLength(5);
  expect(pause(37, 81)).toBeUndefined();
  expect(pause(42, 75)).toBeUndefined();
});

it("restores a reverse-printed episode number from both intact sides of the black label", () => {
  const width = 184,
    height = 90;
  const source = Buffer.alloc(width * height * 4, 255);
  const select = new Uint8Array(width * height).fill(1);
  function paint(x: number, y: number, w: number, h: number, gray: number) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const i = (row * width + col) * 4;
        source.fill(gray, i, i + 3);
      }
    }
  }
  paint(0, 22, width, 46, 8);
  paint(0, 21, width, 1, 137);
  paint(0, 68, width, 1, 164);
  paint(63, 8, 48, 73, 8);
  paint(80, 16, 11, 12, 252);
  paint(80, 62, 11, 11, 252);
  for (const [x, w] of [
    [25, 19],
    [72, 28],
    [124, 25],
  ])
    paint(x, 34, w, 15, 250);
  paint(1, 41, 4, 4, 139);
  paint(80, 1, 4, 2, 43);
  const restored = () => restoreSelectedSignType(source, select, width, height);
  const result = restored();
  const at = (x: number, y: number) => result?.[4 * (y * width + x)];
  expect([at(33, 39), at(85, 39), at(132, 39)]).toEqual([8, 8, 8]);
  expect([at(82, 13), at(84, 75), at(3, 43)]).toEqual([255, 255, 139]);
  expect([at(85, 21), at(85, 68)]).toEqual([137, 164]);
  expect(at(82, 1)).toBe(43);
  select[width + 1] = 0;
  expect(restored()).toBeUndefined();
  select[width + 1] = 1;
  select[39 * width + 33] = 0;
  expect(restored()).toBeUndefined();
  select[39 * width + 33] = 1;
  paint(124, 34, 25, 15, 8);
  expect(restored()).toBeUndefined();
});

it.each([
  ["じっ", 16, 26],
  ["ドド", 120, 62],
  ["ドド", 31, 140],
  ["ドド", 212, 330],
  ["ドド", 75, 399],
  ["ー!!!", 146, 255],
  ["ー!!!", 87, 391],
  ["あーっ", 18, 92],
  ["あーっ", 126, 199],
  ["あーっ", 81, 241],
] as const)(
  "leaves an unsupported %s selection of %i by %i untouched",
  (reading, w, h) => {
    const page = { width: 250, height: 445 };
    const original = Buffer.alloc(4 * page.width * page.height, 255);
    expect(
      measureSmallSelectedSound(
        original,
        page,
        { x: 10, y: 10, w, h },
        reading,
      ),
    ).toBeUndefined();
  },
);

it("separates a hand-lettered pause from the dark frame and the stock inside it", () => {
  const { bitmap, size, paint } = drawing(249);
  const rect = { x: 32, y: 7, w: 38, h: 77 };
  paint(29, 4, 2, 80, 25);
  paint(40, 16, 17, 3, 35);
  paint(54, 18, 3, 10, 35);
  paint(45, 26, 10, 2, 143);
  paint(44, 26, 2, 2, 38);
  paint(39, 38, 4, 11, 24);
  paint(50, 35, 4, 14, 61);
  for (const y of [62, 69, 76]) paint(47, y, 3, 3, 45);
  const measured = (word: string) =>
    measureFramedSoundWithPause(bitmap, size, rect, word);
  const mask = measured("ザワ…");
  if (!mask) throw Error("Expected native lettering inside the frame");
  const selected = new Uint8Array(size.width * size.height);
  mergeMaskIntoPage(selected, size.width, mask.bounds, mask.data);
  const at = (x: number, y: number) => selected[y * size.width + x];
  expect([at(45, 26), at(50, 26), at(48, 77)]).toEqual([1, 1, 1]);
  expect([at(30, 19), at(48, 56), at(50, 7)]).toEqual([0, 0, 0]);
  const block = {
    ...makeBlock(),
    textRole: "sound" as const,
    sourceText: "ザワ…",
  };
  const owner = { bounds: rect, data: new Uint8Array(rect.w * rect.h).fill(1) };
  const options = {
    ...size,
    bitmap,
    sourceRect: rect,
    regionMask: owner,
    block,
    page: { ...makePage(), ...size, blocks: [block] },
    segmentation: {
      imageWidth: size.width,
      imageHeight: size.height,
      detections: [],
    },
    conditionOnTypography: true,
    fallbackConstraint: owner,
  };
  const plan = resolvePatternFluxCompositePlan(options);
  expect(plan.speechBubble).toBe(true);
  expect(plan.modelMask).toEqual(mask);
  owner.data[(77 - rect.y) * rect.w + 48 - rect.x] = 0;
  expect(framedSoundInk(options)).toBeUndefined();
  expect(
    framedSoundInk({ ...options, conditionOnTypography: false }),
  ).toBeUndefined();
  expect(measured("ザワリ…")).toBeUndefined();
  expect(measured("ザワ")).toBeUndefined();
  paint(47, 69, 3, 3, 249);
  paint(53, 69, 3, 3, 45);
  expect(measured("ザワ…")).toBeUndefined();
  paint(53, 69, 3, 3, 249);
  paint(47, 69, 3, 3, 249);
  expect(measured("ザワ…")).toBeUndefined();
});

it("includes a detached small tsu ending at the selected box edge", () => {
  const { bitmap, size, paint } = drawing(239);
  for (const [x, y, w, h] of [
    [25, 27, 8, 19],
    [38, 22, 5, 9],
    [46, 19, 5, 9],
    [55, 49, 11, 9],
  ])
    paint(x, y, w, h, 9);
  const rect = { x: 22, y: 16, w: 47, h: 42 };
  const result = measureSmallSelectedSound(bitmap, size, rect, "じっ");
  expect(result).toBeDefined();
  if (!result) throw Error("Expected the four source strokes");
  const field = new Uint8Array(size.width * size.height);
  mergeMaskIntoPage(field, size.width, result.bounds, result.data);
  expect(field[57 * size.width + 61]).toBe(1);
  paint(62, 57, 7, 3, 9);
  const crossing = measureSmallSelectedSound(bitmap, size, rect, "じっ");
  expect(crossing).toBeDefined();
  if (!crossing) throw Error("Expected the three enclosed strokes");
  field.fill(0);
  mergeMaskIntoPage(field, size.width, crossing.bounds, crossing.data);
  expect(field[57 * size.width + 61]).toBe(0);
});

it("continues a verified fine rule across selected kana on white paper", () => {
  const size = { width: 143, height: 158 };
  const bitmap = Buffer.alloc(4 * size.width * size.height, 255);
  const data = new Uint8Array(size.width * size.height);
  const bounds = { x: 0, y: 0, w: size.width, h: size.height };
  for (let y = 0; y < size.height; y++)
    bitmap.fill(108, 4 * (y * size.width + 68), 4 * (y * size.width + 68) + 3);
  for (const [x, y, w, h] of [
    [49, 39, 29, 5],
    [51, 59, 26, 4],
    [62, 89, 21, 6],
  ]) {
    for (let row = y - 3; row < y + h + 3; row++) {
      for (let col = x - 3; col < x + w + 3; col++) {
        const i = row * size.width + col;
        const set = col >= x && col < x + w && row >= y && row < y + h;
        bitmap.fill(set ? 12 : 255, 4 * i, 4 * i + 3);
        data[i] = Number(set);
      }
    }
  }
  const options = {
    ...size,
    sourceRect: { x: 45, y: 30, w: 46, h: 77 },
    block: { textRole: "sound" as const, sourceText: "チラ" },
  };
  const measured = measureRuledSound(bitmap, options, { bounds, data });
  if (!measured) throw Error("No measured kana on ruled stock");
  const block = { ...makeBlock(), ...options.block };
  const region = { bounds, data: new Uint8Array(data.length).fill(1) };
  const plan = resolvePatternFluxCompositePlan({
    ...options,
    block,
    bitmap,
    regionMask: region,
    fallbackConstraint: region,
    page: { ...makePage(), ...size, blocks: [block] },
    conditionOnTypography: true,
    segmentation: {
      imageWidth: size.width,
      imageHeight: size.height,
      detections: [
        {
          label: "onomatopoeia",
          labelId: 1,
          box: [45, 30, 91, 107],
          score: 0.98,
          mask: {
            ...size,
            logits: Float32Array.from(data, (v) => (v ? 12 : -12)),
          },
        },
      ],
    },
  });
  expect(plan.modelMask).toEqual(measured);
  expect(plan.soundReading).toBe("チラ");
  const stencil = new Uint8Array(data.length);
  mergeMaskIntoPage(stencil, size.width, measured.bounds, measured.data);
  const result = restoreRuledSoundPaper(bitmap, stencil, size, "sound:チラ");
  expect(
    restoreQwenPaper(
      bitmap,
      stencil,
      size.width,
      size.height,
      false,
      "sound:チラ",
    ),
  ).toEqual(result);
  expect(
    restoreRuledSoundPaper(
      bitmap,
      new Uint8Array(stencil.length),
      size,
      "sound:チラ",
    ),
  ).toBeUndefined();
  expect(result?.[4 * (41 * size.width + 68)]).toBe(108);
  expect(result?.[4 * (41 * size.width + 56)]).toBe(255);
  expect(
    restoreRuledSoundPaper(bitmap, stencil, size, "caption"),
  ).toBeUndefined();
  bitmap[4 * (41 * size.width + 56)] = 214;
  expect(
    restoreRuledSoundPaper(bitmap, stencil, size, "sound:チラ"),
  ).toBeUndefined();
  expect(
    measureRuledSound(
      bitmap,
      { ...options, block: { ...options.block, textRole: "ordinary" } },
      { bounds, data },
    ),
  ).toBeUndefined();
});

it("keeps the entire imprint when changing the reference crop along its widest exposed margin", () => {
  const size = { width: 310, height: 240 },
    mask = new Uint8Array(size.width * size.height);
  for (let y = 104; y < 207; y++)
    mask.fill(1, y * size.width + 22, y * size.width + 288);
  expect(alternateCoverBounds(mask, size)).toEqual({
    x: 0,
    y: 16,
    width: 310,
    height: 224,
  });
  expect(alternateCoverBounds(mask.fill(1), size)).toBeUndefined();
});

it("follows opaque horizontal handwriting and its terminal dots across a thin original line", () => {
  const size = { width: 320, height: 120 },
    bitmap = Buffer.alloc(size.width * size.height * 4, 255);
  const bounds = { x: 38, y: 32, w: 190, h: 50 };
  expect(measureHorizontalSound(bitmap, size, bounds, "じー…")).toBeUndefined();
  const paint = (x: number, y: number, w: number, h: number) => {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++)
        bitmap.fill(
          25,
          4 * (row * size.width + col),
          4 * (row * size.width + col) + 3,
        );
  };
  paint(43, 43, 12, 33);
  paint(65, 38, 12, 9);
  paint(84, 38, 10, 9);
  paint(99, 55, 88, 8);
  for (const x of [198, 212, 225]) paint(x, 57, 4, 4);
  paint(0, 33, 237, 1);
  const mask = measureHorizontalSound(bitmap, size, bounds, "じー…");
  expect(covered(mask, 226, 58)).toBe(true);
  expect(covered(mask, 180, 58)).toBe(true);
  expect(covered(mask, 132, 33)).toBe(false);
});

it("separates small horizontal lettering and its ellipsis from the surrounding printed dots", () => {
  const d = drawing(249),
    box = { x: 5, y: 28, w: 89, h: 32 };
  const drawLetters = () => {
    d.paint(13, 34, 12, 3, 24);
    d.paint(12, 44, 4, 10, 24);
    d.paint(32, 45, 10, 3, 24);
    d.paint(49, 39, 4, 14, 24);
    for (const x of [72, 79, 86]) d.paint(x, 45, 3, 2, 24);
  };
  drawLetters();
  const measure = () =>
    measureHorizontalSound(d.bitmap, d.size, box, "うーん…");
  expect(measure()).toBeUndefined();
  for (let y = 2; y < d.size.height - 2; y += 5) {
    for (let x = 2 + (y % 10 === 2 ? 0 : 5); x < d.size.width - 2; x += 10) {
      if (y >= 29 && y <= 55 && x > 9 && x < 90) continue;
      d.paint(x, y, 2, 2, 61);
    }
  }
  const mask = measure();
  expect(mask?.soundReading).toBe("うーん…");
  for (const x of [32, 49, 72, 79, 86]) expect(covered(mask, x, 46)).toBe(true);
  expect(covered(mask, 60, 46)).toBe(false);
  expect(covered(mask, 83, 59)).toBe(false);
  d.paint(86, 40, 2, 2, 44);
  const competingDot = measure();
  expect(covered(competingDot, 87, 46)).toBe(true);
  expect(covered(competingDot, 87, 40)).toBe(false);
});

it("retains the requested reading when a compact effect has no measurable ink or segmentation", () => {
  const size = { width: 500, height: 620 };
  const bounds = { x: 100, y: 180, w: 25, h: 22 };
  const regionMask = {
    bounds,
    data: new Uint8Array(bounds.w * bounds.h).fill(1),
  };
  const block = {
    ...makeBlock(),
    textRole: "sound" as const,
    sourceText: " ザッ ",
  };
  const options = {
    ...size,
    sourceRect: bounds,
    regionMask,
    page: { ...makePage(), ...size, blocks: [block] },
    block,
    conditionOnTypography: true,
    fallbackConstraint: null,
  };
  const plan = resolvePatternFluxCompositePlan(options);
  expect(plan.soundReading).toBe("ザッ");
  expect(plan.modelMask).toBe(regionMask);
});

function covered(mask: InpaintingWindowMask | undefined, x: number, y: number) {
  if (!mask) return false;
  return Boolean(
    mask.data[(y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x],
  );
}

it("restores small reversed capitals from the black sign and leaves its frame alone", () => {
  const d = drawing(4),
    rect = { x: 23, y: 26, w: 51, h: 16 };
  d.paint(18, 18, 63, 1, 241);
  for (const x of [26, 34, 42, 50, 58, 66]) {
    d.paint(x, 29, 2, 10, 220);
    d.paint(x, 29, 5, 2, 220);
  }
  const result = measureSelectedSignType(
    d.bitmap,
    d.size.width,
    rect,
    "CLOSED",
  );
  expect(covered(result, 27, 32)).toBe(true);
  expect(
    measureSelectedSignType(d.bitmap, d.size.width, rect, "CLOSE"),
  ).toBeUndefined();
  const stencil = new Uint8Array(d.size.width * d.size.height);
  result?.data.forEach((v, i) => {
    stencil[
      (rect.y + Math.floor(i / rect.w)) * d.size.width + rect.x + (i % rect.w)
    ] = v;
  });
  const restored = restoreSelectedSignType(
    d.bitmap,
    stencil,
    d.size.width,
    d.size.height,
  );
  expect(restored?.[4 * (32 * d.size.width + 27)]).toBe(4);
  expect(
    restoreQwenPaper(d.bitmap, stencil, d.size.width, d.size.height, false),
  ).toEqual(restored);
  expect(restored?.[4 * (18 * d.size.width + 27)]).toBe(241);
  d.paint(24, 26, 46, 1, 95);
  expect(
    measureSelectedSignType(d.bitmap, d.size.width, rect, "CLOSED"),
  ).toBeUndefined();
});

it("requires a separately outlined long vowel, a matching set of stems and one dot per stem", () => {
  const width = 105,
    height = 175,
    rect = { x: 18, y: 15, w: 65, h: 142 };
  const ink = new Uint8Array(width * height);
  for (let y = 19; y < 122; y++) {
    const x = 22 + Math.round((y - 19) * 0.36);
    ink.fill(1, y * width + x, y * width + x + 4);
  }
  for (let k = 0; k < 3; k++) {
    const x = 59 + 7 * k,
      y = 128 - 2 * k;
    for (let j = 0; j < 24; j++) {
      if (j === 18 || j === 19) continue;
      ink.fill(1, (y + j) * width + x, (y + j) * width + x + 4);
    }
  }
  const dist = distanceToMask(ink, width, height),
    src = Buffer.alloc(ink.length * 4, 255);
  for (let i = 0; i < ink.length; i++)
    src.fill(ink[i] ? 20 : dist[i] < 5 ? 252 : 160, 4 * i, 4 * i + 3);
  const scan = (word: string) =>
    measureSmallSelectedSound(src, { width, height }, rect, word);
  expect(covered(scan("ー!!!"), 24, 22)).toBe(true);
  expect(covered(scan("ー!!!"), 74, 144)).toBe(true);
  expect(covered(scan("ー!!!"), 70, 60)).toBe(false);
  expect(scan("ー!!")).toBeUndefined();
  for (let y = 144; y < 148; y++)
    src.fill(252, 4 * (y * width + 73), 4 * (y * width + 77));
  expect(scan("ー!!!")).toBeUndefined();
});

it("keeps the balloon pen alongside a voiced vowel, its long dash and terminal kana", () => {
  const width = 104,
    height = 148,
    rect = { x: 17, y: 14, w: 59, h: 107 };
  const ink = new Uint8Array(width * height);
  const stroke = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++)
      ink.fill(1, j * width + x, j * width + x + w);
  };
  stroke(26, 21, 7, 35);
  stroke(23, 26, 32, 6);
  stroke(44, 31, 6, 20);
  for (let y = 59; y < 98; y++) stroke(41 + Math.floor((y - 59) / 4), y, 5, 1);
  stroke(50, 100, 8, 6);
  stroke(48, 110, 9, 7);
  const distance = distanceToMask(ink, width, height),
    source = Buffer.alloc(4 * ink.length, 255);
  for (let i = 0; i < ink.length; i++) {
    const x = i % width;
    const gray = ink[i]
      ? 12
      : distance[i] < 5
        ? 252
        : x >= 64 && x <= 67
          ? 21
          : 167;
    source.fill(gray, 4 * i, 4 * i + 3);
  }
  const scan = (reading: string) =>
    measureSmallSelectedSound(source, { width, height }, rect, reading, false);
  const selected = scan("あ゛ーっ");
  expect(covered(selected, 27, 44)).toBe(true);
  expect(covered(selected, 49, 89)).toBe(true);
  expect(covered(selected, 53, 113)).toBe(true);
  expect(covered(selected, 65, 84)).toBe(false);
  expect(scan("あい")).toBeUndefined();
  const intact = Buffer.from(source);
  for (const [top, bottom] of [
    [98, 122],
    [59, 98],
    [21, 57],
  ]) {
    intact.copy(source);
    for (let y = top; y < bottom; y++)
      for (let x = 20; x < 60; x++)
        source.fill(167, 4 * (y * width + x), 4 * (y * width + x) + 3);
    expect(scan("あ゛ーっ")).toBeUndefined();
  }
});

it("completes the detected italic sign row alongside capitals and preserves the crest and rules", () => {
  const d = drawing(3),
    w = d.size.width,
    mask = new Uint8Array(w * d.size.height);
  const glyph = (x: number, y: number, h: number, markedRows: number) => {
    d.paint(x, y, 3, h, 229);
    for (let j = 0; j < markedRows; j++)
      mask.fill(1, (y + j) * w + x, (y + j) * w + x + 3);
  };
  for (const x of [14, 27, 40, 53, 66, 79]) glyph(x, 45, 13, 11);
  for (const x of [36, 41, 46, 51]) glyph(x, 35, 6, x === 46 ? 1 : 3);
  d.paint(31, 30, 26, 2, 242);
  d.paint(5, 61, 89, 2, 241);
  const clean = restoreSelectedSignType(d.bitmap, mask, w, d.size.height);
  expect(clean?.[4 * (38 * w + 46)]).toBe(3);
  expect(clean?.[4 * (54 * w + 53)]).toBe(3);
  expect(clean?.[4 * (31 * w + 45)]).toBe(242);
  expect(clean?.[4 * (61 * w + 54)]).toBe(241);
});

it("measures the white outline of vertical sound type separately from the panel rail", () => {
  const size = { width: 150, height: 220 };
  const rect = { x: 31, y: 24, w: 66, h: 165 };
  function scan(keyline: boolean) {
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
    for (let i = 0; i < size.width * size.height; i++) {
      const x = i % size.width,
        y = Math.floor(i / size.width);
      const d = Math.min(
        ...[53, 105, 160].map((cy) =>
          Math.hypot(
            Math.max(0, Math.abs(x - 62) - 16),
            Math.max(0, Math.abs(y - cy) - 16),
          ),
        ),
      );
      let value = x >= 88 && x <= 90 ? 5 : 145;
      if (keyline && d <= 5) value = 253;
      if (d === 0) value = 17;
      bitmap.fill(value, 4 * i, 4 * i + 3);
    }
    return measureSmallSelectedSound(bitmap, size, rect, "ザワ");
  }
  const measured = scan(true);
  expect(covered(measured, 62, 105)).toBe(true);
  expect(covered(measured, 82, 105)).toBe(true);
  expect(covered(measured, 89, 105)).toBe(false);
  expect(scan(false)).toBeUndefined();
});

it("registers the separate dark strokes of a selected sound while preserving the sleeve entering its box", () => {
  const d = drawing(236),
    rect = { x: 20, y: 15, w: 62, h: 61 };
  d.paint(0, 49, 60, 5, 26);
  for (const [x, y, w, h] of [
    [29, 24, 8, 16],
    [43, 27, 14, 5],
    [64, 57, 5, 10],
  ])
    d.paint(x, y, w, h, 26);
  const mask = measureSmallSelectedSound(d.bitmap, d.size, rect, "ぐい");
  expect(mask?.soundReading).toBe("ぐい");
  expect(covered(mask, 31, 30)).toBe(true);
  expect(covered(mask, 40, 51)).toBe(false);
  expect(
    measureSmallSelectedSound(d.bitmap, d.size, rect, "発言"),
  ).toBeUndefined();
  d.paint(37, 27, 6, 5, 89);
  expect(
    measureSmallSelectedSound(d.bitmap, d.size, rect, "ぐい"),
  ).toBeUndefined();
});

it("registers a bounded light sound inside an ink outline and preserves the adjacent dark hair", () => {
  const d = drawing(111),
    rect = { x: 24, y: 36, w: 26, h: 29 };
  d.paint(0, 48, 45, 4, 53);
  d.paint(29, 40, 16, 21, 65);
  d.paint(32, 43, 10, 15, 243);
  const mask = measureSmallSelectedSound(d.bitmap, d.size, rect, "ス");
  expect(covered(mask, 34, 45)).toBe(true);
  expect(covered(mask, 30, 50)).toBe(true);
  expect(covered(mask, 24, 50)).toBe(false);
  d.paint(32, 43, 10, 15, 195);
  expect(
    measureSmallSelectedSound(d.bitmap, d.size, rect, "ス"),
  ).toBeUndefined();
});

it("requires native brush strokes under a vertically stretched sound reading", () => {
  const size = { width: 81, height: 160 };
  const bitmap = Buffer.alloc(4 * size.width * size.height, 246);
  const bounds = { x: 21, y: 14, w: 30, h: 128 };
  expect(
    measureSmallSelectedSound(bitmap, size, bounds, "ざわー", false),
  ).toBeUndefined();
});

it("conditions the source-only image edit on the selected handwriting", () => {
  const sampling = qwenControlSampling({
    ...referenceEditMode("sound:ぐい"),
    sourceReference: true,
    registered: false,
  });
  expect(sampling).toMatchObject({
    steps: 40,
    denoise: 1,
    cfg: 1,
    referenceSource: true,
    referenceEdit: true,
  });
  expect(sampling.prompt).toContain("「ぐい」");
});

it("traces two thin outlined handwritten strokes crossing a printed emblem", () => {
  const d = drawing(232);
  d.paint(4, 47, 91, 3, 64);
  for (const x of [31, 60]) {
    d.paint(x - 3, 18, 10, 50, 36);
    d.paint(x, 21, 4, 44, 249);
  }
  const found = measureSmallSelectedSound(
    d.bitmap,
    d.size,
    { x: 18, y: 10, w: 62, h: 66 },
    "ぱ",
  );
  expect(covered(found, 32, 33)).toBe(true);
  expect(covered(found, 59, 48)).toBe(true);
  expect(covered(found, 46, 48)).toBe(false);
});

it("uses the original illustration for a reviewed sound without an OCR reading", () => {
  const mode = referenceEditMode("sound:");
  const sampling = qwenControlSampling({
    ...mode,
    sourceReference: true,
    registered: false,
  });
  expect(mode.material.kind).toBe("sound");
  expect(sampling.referenceEdit).toBe(true);
  expect(sampling.prompt).toContain("拟声词");
  expect(sampling.prompt).not.toContain("「」");
});

it("fills both original hollow strokes and preserves the independent light gap", () => {
  const d = drawing(236);
  const box = { x: 20, y: 16, w: 54, h: 55 };
  for (const [x, y, w, h] of [
    [25, 21, 13, 37],
    [49, 39, 17, 27],
  ]) {
    d.paint(x, y, w, h, 31);
    d.paint(x + 2, y + 2, w - 4, h - 4, 248);
  }
  const result = measureSmallSelectedSound(d.bitmap, d.size, box, "す");
  expect(covered(result, 30, 33)).toBe(true);
  expect(covered(result, 57, 50)).toBe(true);
  expect(covered(result, 43, 32)).toBe(false);
});

it.each([
  ["う…っ", false],
  ["ぐ…っ", true],
  ["ぐ…っ", false],
] as const)(
  "recovers the native pause and checks the voiced strokes (%s, %s)",
  (reading, voiced) => {
    const d = drawing(150);
    const box = { x: 20, y: 8, w: 51, h: 76 };
    const ink = new Uint8Array(d.size.width * d.size.height);
    const pieces = [
      [30, 17, 19, 22],
      [40, 49, 4, 4],
      [42, 55, 4, 4],
      [43, 61, 4, 4],
      [44, 70, 9, 9],
    ];
    if (voiced) pieces.push([50, 12, 4, 9], [57, 11, 4, 9]);
    for (const [x, y, w, h] of pieces)
      for (let row = y; row < y + h; row++)
        ink.fill(1, row * d.size.width + x, row * d.size.width + x + w);
    const distance = distanceToMask(ink, d.size.width, d.size.height);
    distance.forEach((dist, i) => {
      const level = ink[i] ? 20 : dist <= 4.8 ? 251 : 150;
      d.bitmap.fill(level, 4 * i, 4 * i + 3);
    });
    const result = measureSmallSelectedSound(
      d.bitmap,
      d.size,
      box,
      reading,
      false,
    );
    if (reading.startsWith("ぐ") && !voiced) {
      expect(result).toBeUndefined();
      return;
    }
    expect(covered(result, 43, 56)).toBe(true);
    expect(covered(result, 48, 75)).toBe(true);
    expect(covered(result, 56, 37)).toBe(false);
    if (voiced) expect(covered(result, 58, 15)).toBe(true);
    // Each piece is independently required. A broken ellipsis between two
    // unrelated drawings must not take either drawing into the erase area.
    for (const [x, y, w, h] of pieces.slice(0, 5)) {
      const native = Buffer.from(d.bitmap);
      d.paint(x, y, w, h, 251);
      expect(
        measureSmallSelectedSound(d.bitmap, d.size, box, reading, false),
      ).toBeUndefined();
      native.copy(d.bitmap);
    }
  },
);
