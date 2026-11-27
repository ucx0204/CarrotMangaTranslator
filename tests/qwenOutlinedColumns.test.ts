import { describe, expect, it, vi } from "vitest";
import { completePrintedCrossbars } from "../src/main/inpainting/qwenHollowSound";
import {
  completeLayeredDisplayTitle,
  completeOutlinedColumns,
  hasOutlinedColumns,
} from "../src/main/inpainting/qwenOutlinedColumns";
import { nativeImage } from "electron";
vi.mock("electron", async () => ({
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
}));

it("completes partially selected crossbars only above other measured print on quiet stock", () => {
  const box = { x: 0, y: 0, w: 110, h: 400 };
  const gray = new Uint8Array(box.w * box.h).fill(253);
  const distance = new Float32Array(gray.length).fill(80);
  for (const y of [3, 40, 165, 260]) {
    for (let row = y; row < y + 5; row++) {
      for (let x = 22; x < 66; x++) {
        const i = row * box.w + x;
        if (y === 40 && row === 41 && x > 30 && x < 34) continue;
        gray[i] = 48;
        distance[i] = Math.max(0, 38 - x, x - 49);
      }
    }
    if (y !== 165) {
      for (let row = y + 14; row < y + 19; row++) {
        for (let x = 25; x < 62; x++) {
          const i = row * box.w + x;
          gray[i] = 58;
          distance[i] = 0;
        }
      }
    }
  }
  gray.fill(168, 255 * box.w, 258 * box.w);
  for (let y = 208; y < 222; y++) {
    gray.fill(35, y * box.w + 24, y * box.w + 67);
    distance.fill(0, y * box.w + 36, y * box.w + 51);
  }
  const dark = gray.map((v) => Number(v < 142));
  const finished = new Uint8Array(gray.length);
  const field = { box, selected: box, gray, distance };
  completePrintedCrossbars(dark, field, finished);
  expect([42, 167, 262].map((row) => finished[row * box.w + 22])).toEqual([
    1, 0, 0,
  ]);
  expect(finished[55 * box.w + 25]).toBe(0);
  expect(finished[4 * box.w + 43]).toBe(0);
  expect(finished[214 * box.w + 41]).toBe(0);
  finished.fill(0);
  completePrintedCrossbars(
    dark,
    { ...field, selected: { ...box, h: 100 } },
    finished,
  );
  expect(finished.some(Boolean)).toBe(false);
});

function printedPage() {
  const width = 230,
    height = 285;
  const bitmap = Buffer.alloc(width * height * 4, 0);
  const bounds = { x: 42, y: 48, w: 102, h: 175 };
  const data = new Uint8Array(bounds.w * bounds.h);
  function paint(x: number, y: number, w: number, h: number, tone: number) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const p = (row * width + col) * 4;
        bitmap.fill(tone, p, p + 3);
        bitmap[p + 3] = 255;
      }
    }
  }
  function mark(x: number, y: number, w: number, h: number) {
    for (let row = y; row < y + h; row++) {
      const left = (row - bounds.y) * bounds.w + x - bounds.x;
      data.fill(1, left, left + w);
    }
  }
  paint(0, 0, width, height, 4);
  for (const col of [43, 112]) {
    paint(col, 50, 30, 167, 252);
    for (let y = 58; y < 206; y += 22) paint(col + 6, y, 18, 10, 4);
    mark(col + 3, 51, 20, 166);
  }
  const complete = () =>
    completeOutlinedColumns(bitmap, { width, height }, { bounds, data });
  return { bitmap, paint, mark, data, bounds, complete };
}

describe("native white outlines around printed title columns", () => {
  it("requires a selected area in the native scan and preserves unselected solid stock", () => {
    const f = printedPage();
    const size = { width: 230, height: 285 };
    const image = nativeImage.createFromBitmap(f.bitmap, size);
    expect(
      hasOutlinedColumns(image, new Uint8Array(size.width * size.height)),
    ).toBe(false);
    expect(hasOutlinedColumns(image, new Uint8Array(960000))).toBe(false);
    f.paint(24, 21, 141, 2, 251);
    f.paint(142, 104, 46, 9, 111);
    f.paint(142, 109, 46, 2, 178);
    const selected = f.complete();
    expect(selected).toBeDefined();
    for (const [x, y] of [
      [100, 22],
      [179, 108],
    ]) {
      expect(
        selected?.data[
          (y - selected.bounds.y) * selected.bounds.w + x - selected.bounds.x
        ],
      ).toBeFalsy();
    }
    f.data.fill(0);
    expect(f.complete()).toBeUndefined();
  });
  it("completes the narrow white edge of a small reading where it meets a lighter fold", () => {
    const f = printedPage();
    f.paint(97, 0, 2, 110, 233);
    f.paint(79, 104, 22, 13, 253);
    f.paint(83, 108, 8, 5, 14);
    f.mark(79, 104, 13, 13);
    const mask = f.complete();
    const at = (x: number, y: number) =>
      mask?.data[(y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x];
    expect(at(100, 109)).toBe(1);
    expect(at(104, 109)).toBe(0);
  });
  it("completes two independently selected columns and their connected printed terminal", () => {
    const f = printedPage();
    // Graded ornament leaves the saturated outline while staying on black ink.
    for (let x = 141; x < 159; x++) f.paint(x, 162, 1, 19, 48 + (x - 141) * 9);
    f.paint(156, 75, 5, 7, 251);
    const mask = f.complete();
    expect(mask).toBeDefined();
    function covers(x: number, y: number) {
      if (!mask) return false;
      return !!mask.data[
        (y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x
      ];
    }
    expect(covers(140, 145)).toBe(true);
    expect(covers(151, 171)).toBe(true);
    expect(covers(158, 78)).toBe(false);
    expect(covers(89, 120)).toBe(false);
  });

  it("requires independent printed interiors and keeps a flat neighboring band", () => {
    const f = printedPage();
    f.paint(142, 128, 17, 22, 118);
    const mask = f.complete();
    expect(mask).toBeDefined();
    expect(
      mask?.data[(136 - mask.bounds.y) * mask.bounds.w + 154 - mask.bounds.x],
    ).toBe(0);
    f.paint(112, 50, 30, 167, 252);
    expect(f.complete()).toBeUndefined();
  });
});

it("recovers the shadow of separately outlined light and dark lettering on the same title", () => {
  const width = 540,
    height = 250;
  const bitmap = Buffer.alloc(width * height * 4, 177);
  const bounds = { x: 20, y: 24, w: 490, h: 195 };
  const data = new Uint8Array(width * height);
  function paint(
    x: number,
    y: number,
    w: number,
    h: number,
    tone: number,
    selected = false,
  ) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const i = row * width + col;
        bitmap.fill(tone, i * 4, i * 4 + 3);
        if (selected) data[i] = 1;
      }
    }
  }
  const layer = (x: number, y: number, ink: number) => {
    paint(x - 3, y - 3, 54, 69, 255 - ink);
    paint(x, y, 48, 63, ink, true);
  };
  const detect = () =>
    completeLayeredDisplayTitle(
      bitmap,
      { width, height },
      { bounds: { x: 0, y: 0, w: width, h: height }, data },
      bounds,
    );
  expect(detect()).toBeUndefined();
  data.fill(1);
  expect(detect()).toBeUndefined();
  data.fill(0);
  for (const [x, y] of [
    [42, 42],
    [116, 130],
    [196, 54],
    [279, 130],
    [381, 50],
  ])
    layer(x, y, 10);
  expect(detect()).toBeUndefined();
  layer(279, 130, 245);
  layer(381, 50, 245);
  // Small pale print between the large faces can consist of separate stems
  // on light stock. A long flat stripe beside them belongs to the drawing.
  paint(322, 80, 51, 42, 243);
  paint(340, 92, 5, 15, 150);
  paint(344, 92, 8, 3, 150);
  paint(345, 61, 60, 2, 136);
  const title = detect();
  expect(title).toBeDefined();
  const at = (x: number, y: number) =>
    title?.data[(y - title.bounds.y) * title.bounds.w + x - title.bounds.x];
  expect(at(37, 69)).toBe(1);
  expect(at(371, 74)).toBe(1);
  expect(at(345, 34)).toBe(0);
});
