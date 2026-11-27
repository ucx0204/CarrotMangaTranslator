import {
  completePairedStops,
  measurePanelCrossingPrint,
} from "../src/main/inpainting/qwenPanelCrossingPrint";
import { expect, it } from "vitest";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import { measureLargeOutlinedSound } from "../src/main/inpainting/qwenSelectedPrint";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import {
  visibleSoundKeyline,
  measuredSoundKeyline,
  isolatedHollowKana,
  measureLargeSoundInk,
} from "../src/main/inpainting/qwenHollowSound";

const size = { width: 187, height: 270 };
const rect = { x: 29, y: 23, w: 121, h: 227 };
const strokes = [
  [32, 27, 45, 93],
  [111, 36, 127, 102],
  [132, 34, 145, 87],
  [54, 128, 69, 211],
  [80, 185, 96, 244],
];

it("keeps paper, narrow pen rules and incomplete individual counters outside outlined lettering", () => {
  const w = 110,
    h = 130,
    box = { x: 0, y: 0, w, h },
    white = new Uint8Array(w * h).fill(246);
  const active = new Uint8Array(w * h);
  active[55 * w + 55] = 1;
  const dist = distanceToMask(active, w, h);
  expect(measuredSoundKeyline(white, dist, box)).toBeUndefined();
  expect(
    measuredSoundKeyline(
      white.map(() => 130),
      dist,
      box,
    ),
  ).toBeUndefined();
  expect(isolatedHollowKana(white, box, box)).toBeUndefined();
  const rect = { x: 6, y: 10, w: 90, h: 103 };
  const line = (x: number, y: number, ww: number, hh: number, v: number) => {
    for (let k = y; k < y + hh; k++) white.fill(v, k * w + x, k * w + x + ww);
  };
  for (const [x, y] of [
    [14, 18],
    [35, 38],
    [54, 58],
    [74, 78],
  ]) {
    line(x, y, 9, 53, 45);
    line(x + 2, y + 2, 5, 49, 245);
  }
  expect(measureLargeSoundInk("solid", white, box, rect, 3)).toBeUndefined();
  expect(measureLargeSoundInk("hollow", white, box, rect, 3)).toBeUndefined();
  white.fill(246);
  for (const [x, y] of [
    [18, 20],
    [39, 29],
  ]) {
    line(x, y, 12, 20, 42);
    line(x + 2, y + 2, 8, 16, 248);
  }
  expect(isolatedHollowKana(white, box, rect)).toBeUndefined();
  line(30, 22, 4, 2, 149);
  expect(isolatedHollowKana(white, box, rect)).toBeUndefined();
});

it("recovers both small punctuation stops without including an adjacent hair tip", () => {
  const page = { width: 92, height: 134 };
  const rect = { x: 22, y: 17, w: 36, h: 96 };
  const source = Buffer.alloc(4 * page.width * page.height, 255);
  const data = new Uint8Array(page.width * page.height);
  function stroke(
    x: number,
    y: number,
    w: number,
    h: number,
    selected: boolean,
  ) {
    for (let j = y; j < y + h; j++)
      for (let k = x; k < x + w; k++) {
        const i = j * page.width + k;
        source.fill(32, 4 * i, 4 * i + 3);
        data[i] = Number(selected);
      }
  }
  stroke(30, 88, 5, 16, true);
  stroke(41, 89, 5, 15, true);
  stroke(31, 106, 3, 3, false);
  stroke(42, 106, 3, 3, false);
  stroke(50, 104, 2, 9, false);
  const selected = {
    bounds: { x: 0, y: 0, w: page.width, h: page.height },
    data,
  };
  const extra = completePairedStops(source, page, rect, selected);
  expect(extra).toBeDefined();
  if (!extra) throw Error("Expected two detached stops");
  const mask = expandWindowMaskToPage(extra, page.width, page.height);
  expect([32, 43, 50].map((x) => mask[107 * page.width + x])).toEqual([
    1, 1, 0,
  ]);
  for (let y = 106; y < 109; y++)
    source.fill(255, (y * page.width + 42) * 4, (y * page.width + 45) * 4);
  expect(completePairedStops(source, page, rect, selected)).toBeUndefined();
});

it("completes the exposed pen at a crossing, including the optical fringe on the dark rule", () => {
  const page = { width: 150, height: 160 };
  const rect = { x: 54, y: 37, w: 38, h: 89 };
  const source = Buffer.alloc(4 * page.width * page.height, 255);
  const data = new Uint8Array(page.width * page.height);
  for (let y = 0; y < page.height; y++)
    for (let x = 0; x < page.width; x++) {
      const i = y * page.width + x;
      const stem = x >= 59 && x <= 65 && y >= 40 && y <= 76;
      const lower = x >= 73 && x <= 78 && y >= 90 && y <= 107;
      data[i] = Number((stem && y > 49) || (lower && x < 78));
      const rim = x >= 55 && x <= 69;
      const rule = y >= 44 && y < 49 && !rim;
      source.fill(stem || lower || rule ? 20 : 255, 4 * i, 4 * i + 3);
    }
  const selected = {
    bounds: { x: 0, y: 0, w: page.width, h: page.height },
    data,
  };
  const measured = measurePanelCrossingPrint(source, page, rect, selected);
  if (!measured)
    throw Error("Expected an outlined stem across the dark panel rule");
  const mask = expandWindowMaskToPage(measured, page.width, page.height);
  expect(
    [
      [62, 40],
      [69, 46],
      [78, 98],
      [43, 47],
    ].map(([x, y]) => mask[y * page.width + x]),
  ).toEqual([1, 1, 1, 0]);
  for (let y = 44; y < 49; y++)
    source.fill(255, 4 * y * page.width, 4 * (y + 1) * page.width);
  expect(
    measurePanelCrossingPrint(source, page, rect, selected),
  ).toBeUndefined();
});

it("extends the visible white press on its dark side while retaining a separate white seam", () => {
  const box = { x: 0, y: 0, w: 60, h: 75 };
  const mask = new Uint8Array(box.w * box.h);
  const gray = new Uint8Array(mask.length).fill(143);
  for (let y = 10; y < 65; y++) {
    for (let x = 15; x < 41; x++) {
      const i = y * box.w + x;
      mask[i] = Number(x <= 35);
      if (x <= 32) gray[i] = 16;
      if (x > 30 && x <= 37 && y < 39) gray[i] = 253;
      if (x === 37 && y >= 43) gray[i] = 253;
    }
  }
  const outline = visibleSoundKeyline(gray, box, mask);
  expect(outline.data[25 * box.w + 37]).toBe(1);
  expect(mask[25 * box.w + 37]).toBe(0);
  expect(outline.data[25 * box.w + 38]).toBe(0);
  expect(outline.data[52 * box.w + 37]).toBe(0);
});

function scan(hollow: boolean, keyline: boolean) {
  const core = new Uint8Array(size.width * size.height);
  const ink = new Uint8Array(core.length);
  for (const [left, top, right, bottom] of strokes) {
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const i = y * size.width + x;
        core[i] = 1;
        ink[i] = Number(
          !hollow || Math.min(x - left, right - x, y - top, bottom - y) < 2,
        );
      }
  }
  const distance = distanceToMask(core, size.width, size.height);
  const bitmap = Buffer.alloc(4 * core.length, 255);
  for (let i = 0; i < core.length; i++) {
    const x = i % size.width;
    let gray = x === 103 ? 4 : 128 + (i % 5);
    if (keyline && distance[i] <= 4.4) gray = 252;
    if (core[i]) gray = ink[i] ? 18 : 249;
    bitmap.fill(gray, 4 * i, 4 * i + 3);
  }
  return bitmap;
}

it.each([false, true])(
  "measures ink islands and their shared keyline on illustrated stock (hollow=%s)",
  (hollow) => {
    const bitmap = scan(hollow, true);
    const result = measureLargeOutlinedSound(bitmap, size, rect, "バッ");
    expect(result?.measuredSoundOutline).toBe(true);
    if (!result) throw new Error("missing measured sound");
    const at = (x: number, y: number) =>
      result.data[
        (y - result.bounds.y) * result.bounds.w + x - result.bounds.x
      ];
    expect(at(40, 48)).toBe(1);
    expect(at(80, 220)).toBe(1);
    expect(at(103, 58)).toBe(0);
    expect(
      measureLargeOutlinedSound(scan(hollow, false), size, rect, "バッ"),
    ).toBeUndefined();
    expect(
      measureLargeOutlinedSound(bitmap, size, rect, "本文"),
    ).toBeUndefined();
  },
);
