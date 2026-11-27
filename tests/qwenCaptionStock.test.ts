import { inlineCreatorCredit } from "../src/main/inpainting/qwenCreatorCaption";
import { measuredCaptionEnvelope } from "../src/main/inpainting/qwenCaptionEnvelope";
import { pixelsToBbox } from "../src/shared/geometry";
import { describe, expect, it } from "vitest";
import {
  measurePublisherRibbon,
  measureQwenCaptionStock,
  refineQwenCaptionStock,
} from "../src/main/inpainting/qwenCaptionStock";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { refineQwenPrintedContours } from "../src/main/inpainting/qwenPrintedContours";
import { stockCrossingPen } from "../src/main/inpainting/qwenStockCrossing";
import { groupedDiamondBacking } from "../src/main/inpainting/qwenDiamondStock";
import { publisherRowComposite } from "../src/main/inpainting/qwenPublisherRows";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import { createEmptyPatternMaskContext } from "../src/main/inpainting/patternMaskContext";
import { prepareGroupedRegionWindows } from "../src/main/inpainting/patternSharedWindows";
import { makePage, makeBlock } from "./unifiedInpaintingUiFixtures";

const width = 420,
  height = 112;
const size = { width, height },
  bounds = { x: 0, y: 0, w: width, h: height };

it("ends the feather at the measured keyline of a printed column on illustrated stock", () => {
  const w = 105,
    h = 218;
  const rect = { x: 31, y: 16, w: 40, h: 187 };
  const instance = {
    bounds: { x: 0, y: 0, w, h },
    data: new Uint8Array(w * h),
  };
  for (const x of [37, 59])
    for (let y = 23; y < 193; y += 18) {
      for (let dy = 0; dy < 7; dy++)
        instance.data.fill(1, (y + dy) * w + x, (y + dy) * w + x + 5);
    }
  const distance = distanceToMask(instance.data, w, h);
  const source = Buffer.alloc(4 * w * h, 255);
  function scan(white: number) {
    for (let i = 0; i < distance.length; i++)
      source.fill(
        instance.data[i] ? 38 : distance[i] < 4.1 ? white : 171,
        4 * i,
        4 * i + 3,
      );
    return measuredCaptionEnvelope(
      source,
      { width: w, height: h },
      rect,
      instance,
    );
  }
  const envelope = scan(249);
  if (!envelope)
    throw Error("Expected repeated printed ink with a white border");
  expect(envelope.featherPx).toBe(2);
  expect(envelope.compositeMask.data[26 * w + 33]).toBe(1);
  expect(envelope.compositeMask.data[26 * w + 32]).toBe(0);
  expect(envelope.constraint.data[26 * w + 31]).toBe(1);
  expect(envelope.constraint.data[26 * w + 30]).toBe(0);
  expect(scan(190)).toBeUndefined();
});

it("traces a fine pen crossing the printed edge only along an exposed continuation", () => {
  const w = 94,
    h = 80;
  const gray = Uint8Array.from({ length: w * h }, (_, i) => {
    const x = i % w,
      y = Math.floor(i / w);
    if (x < 28) return 12;
    if (x > 43 && x < 47 && y > 46 && y < 50) return 36;
    return Math.round(
      188 - 145 * Math.exp(-0.5 * ((y - 26 - 0.16 * (x - 29)) / 1.05) ** 2),
    );
  });
  const follow = stockCrossingPen(gray, { x: 0, y: 0, w, h });
  expect(follow(30, 26, 1, 0)).toBe(true);
  expect(follow(45, 48, 1, 0)).toBe(false);
  expect(follow(27, 58, 1, 0)).toBe(false);
  expect(follow(88, 36, 1, 0)).toBe(false);
});

it("measures the dark subtitle backing beyond its light lettering", () => {
  const source = Buffer.alloc(width * height * 4, 255);
  const text = { x: 85, y: 42, w: 238, h: 15 };
  for (let y = 39; y <= 60; y++) {
    for (let x = 65; x <= 346 - Math.max(0, y - 49); x++) {
      const lettering = y > 43 && y < 56 && x > 86 && x < 322 && x % 13 < 4;
      if (!lettering)
        source.fill(5, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  const ribbon = measurePublisherRibbon(source, size, text);
  expect(ribbon).toBeDefined();
  if (!ribbon) throw new Error("Expected the original subtitle backing");
  const mask = expandWindowMaskToPage(ribbon, width, height);
  expect(mask[59 * width + 160]).toBe(1);
  expect(mask[46 * width + 339]).toBe(1);
  expect(mask[65 * width + 160]).toBe(0);
  expect(mask[46 * width + 349]).toBe(0);
  expect(
    measurePublisherRibbon(Buffer.alloc(source.length, 255), size, text),
  ).toBeUndefined();
});

function joinedPrintedDiamonds() {
  const w = 240,
    h = 160;
  const truth = Buffer.alloc(w * h * 4, 255),
    source = Buffer.from(truth);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const x = i % w,
      y = Math.floor(i / w),
      dy = Math.abs(y - 80);
    const dx = Math.min(...[64, 110, 156].map((cx) => Math.abs(x - cx)));
    const diamond = dx + dy <= 25;
    const ornamental = dx <= 2 && dy >= 20 && dy <= 21;
    const letter =
      diamond &&
      dy <= 9 &&
      ((dx >= 5 && dx <= 7) || (dy >= 6 && dy <= 8 && dx <= 6));
    const stock = diamond ? (ornamental ? 230 : 2) : 180 + (x % 2) * 40;
    truth.fill(stock, 4 * i, 4 * i + 3);
    source.fill(letter ? 246 : stock, 4 * i, 4 * i + 3);
    mask[i] = Number(x >= 51 && x < 169 && y >= 67 && y < 94);
  }
  return { w, h, source, truth, mask };
}

it("recovers the selected lettering on joined black diamonds and keeps their tip ornaments and surrounding screen", () => {
  const { w, h, source, truth, mask } = joinedPrintedDiamonds();
  const result = refineQwenCaptionStock(source, truth, mask, w, h);
  expect(result).toEqual(truth);
  expect(refineQwenCaptionStock(source, source, mask, w, h)).toBeUndefined();
  const rect = { x: 51, y: 67, w: 118, h: 27 };
  const pageBounds = { x: 0, y: 0, w, h };
  const selected = { bounds: pageBounds, data: mask };
  for (const measured of [true, false]) {
    const backing = groupedDiamondBacking(
      source,
      w,
      h,
      rect,
      selected,
      measured,
    );
    expect(backing).toBeDefined();
    if (!backing) throw Error("Expected all three selected diamonds");
    const onPage = expandWindowMaskToPage(backing, w, h);
    expect(onPage[56 * w + 64]).toBe(1);
    expect(onPage[55 * w + 110]).toBe(1);
    expect(onPage[56 * w + 156]).toBe(1);
    expect(onPage[47 * w + 110]).toBe(0);
  }
  const options = {
    bitmap: source,
    page: { ...makePage(), width: w, height: h },
    typographySegmentation: {
      imageWidth: w,
      imageHeight: h,
      detections: [
        {
          label: "text" as const,
          labelId: 0 as const,
          score: 0.99,
          box: [51, 67, 169, 94] as [number, number, number, number],
          mask: {
            width: w,
            height: h,
            logits: Float32Array.from(mask, (v) => (v ? 9 : -9)),
          },
        },
      ],
    },
  };
  const rows = [
    { rect: { x: 186, y: 7, w: 29, h: 142 }, reading: "タイトル" },
    { rect, reading: "副題" },
    { rect: { x: 43, y: 122, w: 71, h: 16 }, reading: "原作 甲" },
  ];
  const inside = publisherRowComposite(options, rows, selected, pageBounds);
  expect(inside).toBeDefined();
  if (!inside) throw Error("Expected the registered grouped title");
  const pasted = expandWindowMaskToPage(inside, w, h);
  expect(pasted[80 * w + 110]).toBe(1);
  expect(pasted[43 * w + 110]).toBe(0);
  const paired = [
    ...rows,
    { rect: { x: 41, y: 116, w: 114, h: 20 }, reading: "漫画 山田 原作 鈴木" },
  ];
  const pairedMask = publisherRowComposite(
    options,
    paired,
    selected,
    pageBounds,
  );
  expect.assert(pairedMask);
  const owned = expandWindowMaskToPage(pairedMask, w, h);
  expect(owned[80 * w + 110]).toBe(1);
  expect(owned[12 * w + 12]).toBe(0);
  expect(
    publisherRowComposite(options, paired.slice(1), selected, pageBounds),
  ).toBeUndefined();
  const block = {
    ...makeBlock(),
    id: "diamonds",
    sourceText: "副題",
    bbox: pixelsToBbox(rect, w, h),
  };
  const page = { ...options.page, blocks: [block] };
  const context = createEmptyPatternMaskContext(w, h);
  context.inpaintWindowMasks.push(selected);
  context.inpaintCompositeMasks.push(selected);
  context.inpaintWindowConstraints.push(null);
  context.inpaintCompositeFeatherPx.push(0);
  context.inpaintWindowGroupIds.push(["qwen-illustrated-title:one-issue"]);
  context.inpaintSpeechBubbleWindows.push(false);
  context.inpaintWindows.push(pageBounds);
  context.validationBlockIds.push(block.id);
  prepareGroupedRegionWindows(context, {
    ...options,
    page,
    width: w,
    mode: "flux-region",
    conditionOnTypography: true,
  });
  expect(
    expandWindowMaskToPage(context.inpaintWindowMasks[0], w, h)[56 * w + 110],
  ).toBe(1);
  const colored = Buffer.from(source);
  colored[4 * (80 * w + 70)] = 5;
  expect(refineQwenCaptionStock(colored, truth, mask, w, h)).toBeUndefined();
  const translucent = Buffer.from(source);
  translucent[4 * (80 * w + 70) + 3] = 180;
  expect(
    groupedDiamondBacking(translucent, w, h, rect, selected, true),
  ).toBeUndefined();
  for (const [oldLevel, replacement] of [
    [2, 43],
    [246, 97],
  ]) {
    const faint = Buffer.from(source);
    for (let i = 0; i < w * h; i++) {
      if (source[4 * i] === oldLevel) faint.fill(replacement, 4 * i, 4 * i + 3);
    }
    expect(
      groupedDiamondBacking(faint, w, h, rect, selected, true),
    ).toBeUndefined();
  }
});
function captionInk(x: number, y: number, row: boolean, col: number) {
  const letter =
    row &&
    x >= 70 &&
    x < 348 &&
    y >= 44 &&
    y < 60 &&
    col >= 0 &&
    col < 15 &&
    (col < 4 || y < 48 || (y >= 52 && y < 55));
  const dash =
    (y === 52 || y === 53) && ((x >= 54 && x <= 62) || (x >= 357 && x <= 365));
  return { letter, dash };
}
function strip(inverse: boolean) {
  const source = Buffer.alloc(width * height * 4, 255),
    predicted = Buffer.from(source);
  const mask = new Uint8Array(width * height),
    truth = Buffer.from(source);
  for (let i = 0; i < mask.length; i++) {
    const x = i % width,
      y = Math.floor(i / width),
      row = y >= 39 && y < 65;
    const col = (x - 70) % 27;
    const { letter, dash } = captionInk(x, y, row, col);
    const stock = row ? 4 : 133 + (x % 45);
    const level = (v: number) => (inverse ? 255 - v : v);
    source.fill(level(letter || dash ? 248 : stock), 4 * i, 4 * i + 3);
    truth.fill(level(stock), 4 * i, 4 * i + 3);
    predicted.fill(
      level(row && y >= 51 && y < 54 ? 110 : stock),
      4 * i,
      4 * i + 3,
    );
    mask[i] = Number(letter);
  }
  return { source, predicted, mask, truth };
}

describe("Qwen opaque caption strips", () => {
  it("retains the measured strip when the decode removes the lettering and continues the picture behind it", () => {
    const { source, mask, truth } = strip(false);
    const decoded = Buffer.from(truth);
    for (let y = 39; y < 65; y++)
      for (let x = width / 2; x < width; x++)
        decoded.fill(146, 4 * (y * width + x), 4 * (y * width + x) + 3);
    const completed = refineQwenCaptionStock(
      source,
      decoded,
      mask,
      width,
      height,
    );
    expect(completed).toBeDefined();
    if (!completed) throw new Error("Missing restored subtitle stock");
    expect(completed[4 * (45 * width + 72)]).toBeLessThan(8);
    expect(completed[4 * (45 * width + 288)]).toBeLessThan(8);
    expect(completed.subarray(0, 4 * 38 * width)).toEqual(
      source.subarray(0, 4 * 38 * width),
    );
    for (let y = 39; y < 65; y++)
      for (let x = width / 2; x < width; x++) {
        const i = 4 * (y * width + x);
        decoded.set(source.subarray(i, i + 3), i);
      }
    expect(
      refineQwenCaptionStock(source, decoded, mask, width, height),
    ).toBeUndefined();
  });
  it("preserves illustration on both sides of a selected subtitle missed by the detector", () => {
    const { source } = strip(false);
    const box = { x: 70, y: 44, w: 278, h: 16 };
    const block = { ...makeBlock(), bbox: pixelsToBbox(box, width, height) };
    const plan = buildPatternPageMask({
      bitmap: source,
      width,
      height,
      page: { ...makePage(), width, height, blocks: [block] },
      mode: "flux-region",
      conditionOnTypography: true,
      typographySegmentation: {
        imageWidth: width,
        imageHeight: height,
        detections: [],
      },
    });
    expect(plan.inpaintWindowMasks).toHaveLength(1);
    const selected = expandWindowMaskToPage(
      plan.inpaintWindowMasks[0],
      width,
      height,
    );
    expect(selected[46 * width + 72]).toBe(1);
    expect(selected[52 * width + 58]).toBe(1);
    expect(selected[37 * width + 95]).toBe(0);
    expect(selected[66 * width + 95]).toBe(0);
  });
  it("recovers terminal print on a selected vertical strip and preserves its unselected neighbour", () => {
    const width = 160,
      height = 230,
      source = Buffer.alloc(width * height * 4, 255);
    const mask = new Uint8Array(width * height);
    for (const x0 of [32, 70]) {
      for (let y = 16; y < 216; y++)
        for (let x = x0; x < x0 + 28; x++) {
          const p = y * width + x;
          source.fill((x + 3 * y) % 9, 4 * p, 4 * p + 3);
          const ry = (y - 25) % 14;
          if (y < 25 || y > 202 || x < x0 + 7 || x > x0 + 19 || ry > 7)
            continue;
          if (ry < 2 || x === x0 + 9 || x === x0 + 17) {
            source.fill(247, 4 * p, 4 * p + 3);
            mask[p] = Number(x0 === 32 && y < 190);
          }
        }
    }
    const bounds = { x: 0, y: 0, w: width, h: height };
    const stock = measureQwenCaptionStock(
      source,
      { width, height },
      { bounds, data: mask },
    );
    expect(stock?.levels).toBeDefined();
    const decode = Buffer.from(source);
    for (let y = 20; y < 210; y++)
      for (let x = 37; x < 56; x++)
        decode.fill(6, 4 * (y * width + x), 4 * (y * width + x) + 3);
    const restored = refineQwenCaptionStock(
      source,
      decode,
      mask,
      width,
      height,
    );
    expect(restored).toBeDefined();
    const p = 4 * (193 * width + 41);
    expect(source[p]).toBe(247);
    expect(restored?.[p]).toBeLessThan(10);
    for (let y = 0; y < height; y++) {
      const a = 4 * (y * width + 70),
        b = a + 4 * 28;
      expect(restored?.subarray(a, b)).toEqual(source.subarray(a, b));
    }
  });
  it("extends the Koharu text instance to the two bracketing dashes", () => {
    const { source, mask } = strip(false);
    const box = { x: 70, y: 44, w: 278, h: 16 };
    const block = { ...makeBlock(), bbox: pixelsToBbox(box, width, height) };
    const logits = Float32Array.from(mask, (on) => (on ? 10 : -10));
    const plan = buildPatternPageMask({
      bitmap: source,
      width,
      height,
      page: { ...makePage(), width, height, blocks: [block] },
      mode: "flux-region",
      conditionOnTypography: true,
      typographySegmentation: {
        imageWidth: width,
        imageHeight: height,
        detections: [
          {
            label: "text",
            labelId: 0 as const,
            score: 0.995,
            box: [70, 44, 348, 60],
            mask: { width, height, logits },
          },
        ],
      },
    });
    expect(plan.inpaintWindows).toHaveLength(1);
    const selected = expandWindowMaskToPage(
      plan.inpaintWindowMasks[0],
      width,
      height,
    );
    expect(selected[52 * width + 58]).toBe(1);
    expect(selected[52 * width + 362]).toBe(1);
  });

  it("preserves a solid emblem between separately printed groups on the dark strip", () => {
    const { source, mask, predicted } = strip(false);
    for (let y = 41; y < 61; y++)
      for (let x = 204; x <= 221; x++) {
        const i = y * width + x;
        const emblem = x >= 207 && x <= 217 && y >= 42 && y < 60;
        source.fill(emblem ? 248 : 4, 4 * i, 4 * i + 3);
        mask[i] = Number(emblem);
      }
    const actual = refineQwenCaptionStock(
      source,
      predicted,
      mask,
      width,
      height,
    );
    expect(actual?.[4 * (50 * width + 212)]).toBe(248);
    for (const x of [179, 233])
      expect(actual?.[4 * (53 * width + x)]).toBeLessThan(9);
  });
  it.each([false, true])(
    "measures the native paper, its paired dashes and both boundaries (inverse %s)",
    (inverse) => {
      const { source, predicted, mask, truth } = strip(inverse);
      const measured = measureQwenCaptionStock(source, size, {
        bounds,
        data: mask,
      });
      expect(measured).toBeDefined();
      if (!measured) throw new Error("Missing caption measurement");
      const area = expandWindowMaskToPage(measured, width, height);
      expect(area[52 * width + 58]).toBe(1);
      expect(area[52 * width + 362]).toBe(1);
      expect(area[38 * width + 180]).toBe(0);
      for (const stencil of [mask, area]) {
        const image = refineQwenCaptionStock(
          source,
          predicted,
          stencil,
          width,
          height,
        );
        if (!image) throw new Error("Missing native caption");
        expect(
          refineQwenPrintedContours(source, stencil, predicted, width, height),
        ).toEqual(image);
        expect(
          Math.abs(image[4 * (52 * width + 58)] - truth[4 * (52 * width + 58)]),
        ).toBeLessThanOrEqual(1);
        expect(image.subarray(0, 4 * width * 39)).toEqual(
          source.subarray(0, 4 * width * 39),
        );
      }
      expect(
        refineQwenCaptionStock(
          source,
          Buffer.alloc(source.length, 114),
          mask,
          width,
          height,
        ),
      ).toBeUndefined();
    },
  );
  it("leaves an unselected continuous highlight, colored stock and an unframed dark panel on the model route", () => {
    const { source, mask } = strip(false);
    const read = (s: Buffer) =>
      measureQwenCaptionStock(s, size, { bounds, data: mask });
    expect(read(Buffer.alloc(source.length, 5))).toBeUndefined();
    const ruled = Buffer.from(source);
    for (let x = 42; x < 377; x++)
      ruled.fill(240, 4 * (52 * width + x), 4 * (52 * width + x) + 3);
    expect(read(ruled)).toBeUndefined();
    const color = Buffer.from(source);
    for (let i = 0; i < mask.length; i++)
      if (color[4 * i] === 4) color[4 * i] = 42;
    expect(read(color)).toBeUndefined();
    const unframed = Buffer.from(source);
    for (let i = 0; i < mask.length; i++)
      if (source[4 * i] > 20 && source[4 * i] < 220)
        unframed.fill(4, i * 4, i * 4 + 3);
    expect(read(unframed)).toBeUndefined();
  });
});

it("groups only selected adjacent ruled title rows while retaining each block's validation mask", () => {
  const w = 480,
    h = 300,
    bitmap = Buffer.alloc(w * h * 4, 225);
  const positions = [22, 102, 182, 262];
  const paint = (x: number, y: number, v: number) =>
    bitmap.fill(v, 4 * (y * w + x), 4 * (y * w + x) + 3);
  for (const y of positions) for (let x = 8; x < w - 8; x++) paint(x, y, 24);
  const blocks = positions.slice(0, 3).map((top, i) => {
    for (let x = 44; x < w - 30; x += 39)
      for (let y = top + 12; y < top + 64; y++)
        for (let dx = 0; dx < 24; dx++)
          if (dx < 6 || y < top + 18 || (y >= top + 36 && y < top + 43))
            paint(x + dx, y, 20);
    return {
      ...makeBlock(),
      id: "title" + i,

      bbox: pixelsToBbox({ x: 60, y: top + 12, w: 350, h: 53 }, w, h),
    };
  });
  const render = (blockIds: string[]) =>
    buildPatternPageMask({
      page: { ...makePage(), width: w, height: h, blocks },
      width: w,
      height: h,
      bitmap,
      blockIds,
      mode: "flux-region",
      conditionOnTypography: true,
      typographySegmentation: { imageWidth: w, imageHeight: h, detections: [] },
    });
  const paired = render(["title0", "title1", "title2"]);
  expect(paired.inpaintWindows).toHaveLength(2);
  expect(paired.validationBlockIds).toEqual(blocks.map((b) => b.id));
  const mask = expandWindowMaskToPage(paired.inpaintCompositeMasks[0], w, h);
  expect(mask[46 * w + 46]).toBe(1);
  expect(mask[126 * w + 46]).toBe(1);
  expect(mask[102 * w + 46]).toBe(0);
  expect(mask[206 * w + 46]).toBe(0);
  expect(render(["title0", "title2"]).inpaintWindows).toHaveLength(2);
  expect(render(["title1"]).validationBlockIds).toEqual(["title1"]);
});

it("measures black creator names on coloured stock while retaining the gap before the credit", () => {
  const size = { width: 180, height: 42 },
    rect = { x: 5, y: 8, w: 160, h: 24 };
  const image = Buffer.alloc(size.width * size.height * 4, 255);
  for (let i = 0; i < size.width * size.height; i++) image[4 * i] = 172;
  for (const x of [10, 20, 30, 40, 55, 107, 118, 129, 140, 153])
    for (let y = 12; y < 24; y++)
      for (let col = x; col < x + 4; col++) {
        const pos = 4 * (y * size.width + col);
        image.fill(18, pos, pos + 3);
      }
  const read = (text: string) => inlineCreatorCredit(image, size, rect, text);
  const mask = read("作者名 原作: 作者名");
  if (!mask) throw new Error("Expected measured creator lettering");
  const at = (x: number, y: number) =>
    mask.data[(y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x];
  expect(at(25, 18)).toBe(1);
  expect(at(80, 18)).toBe(0);
  expect(read("普通の会話")).toBeUndefined();
  image.fill(255);
  expect(read("作者名 原作: 作者名")).toBeUndefined();
});
