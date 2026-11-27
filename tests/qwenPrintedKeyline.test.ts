import { describe, expect, it } from "vitest";
import {
  measuredPrintedKeyline,
  recoverQwenFolio,
  recoverQwenIsolatedMark,
} from "../src/main/inpainting/qwenPrintedKeyline";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import {
  measureDetectedBrush,
  completeQwenOutlinedLettering,
  recoverOutlinedBrushEffect,
} from "../src/main/inpainting/qwenOutlinedLettering";
import { traceDryBrushEnds } from "../src/main/inpainting/qwenSoundRim";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { dilateBinaryMaskDisk } from "../src/main/inpainting/patternMaskMorphology";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
describe("Qwen printed keylines", () => {
  it("leaves an isolated tiny mark and an oversized whole-page selection to the regular erase path", () => {
    for (const [w, h] of [
      [18, 35],
      [1450, 1500],
    ]) {
      const size = { width: w, height: h };
      const instance = {
        bounds: { x: 0, y: 0, w, h },
        data: new Uint8Array(w * h).fill(1),
      };
      expect(
        completeQwenOutlinedLettering(
          Buffer.alloc(w * h * 4, 255),
          size,
          instance,
        ),
      ).toBeUndefined();
    }
  });
  it("preserves a solid panel rule crossing a narrow selection at the page edge", () => {
    const size = { width: 106, height: 115 };
    const bounds = { x: 6, y: 38, w: 52, h: 28 };
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
    bitmap.fill(24, size.width * 49 * 4, size.width * 52 * 4);
    expect(
      completeQwenOutlinedLettering(
        bitmap,
        { ...size, sourceRect: bounds },
        {
          bounds,
          data: new Uint8Array(bounds.w * bounds.h).fill(1),
        },
      ),
    ).toBeUndefined();
  });
  it.each([false, true])(
    "protects a coat and confines the brush matte at a native panel border (%s)",
    (hasRule) => {
      const width = 360,
        height = 275,
        bounds = { x: 0, y: 0, w: width, h: height };
      const ink = new Uint8Array(width * height),
        selection = new Uint8Array(ink.length);
      const bitmap = Buffer.alloc(4 * ink.length, 255);
      for (const [left, top] of [
        [39, 34],
        [95, 44],
        [153, 67],
        [58, 149],
      ]) {
        for (let y = 0; y < 45; y++)
          for (let x = 0; x < 16; x++)
            ink[(y + top) * width + left + x + Math.floor(y * 0.25)] = 1;
      }
      const rim = dilateBinaryMaskDisk(ink, width, height, 8);
      for (let i = 0; i < ink.length; i++) {
        const x = i % width,
          y = Math.floor(i / width),
          coat = x >= 214 && x < 302 && y > 169 && y < 227;
        const coatEdge = coat && y >= 182 && y < 185;
        const panelRule = hasRule && (x === 183 || x === 184);
        selection[i] = Number(!!ink[i] || coat);
        bitmap.fill(
          ink[i] || coatEdge || panelRule ? 12 : rim[i] ? 252 : 153,
          4 * i,
          4 * i + 3,
        );
      }
      const page = { ...makePage(), width, height },
        block = { ...makeBlock(), sourceText: "", textRole: "sound" as const };
      const plan = resolvePatternFluxCompositePlan({
        page,
        block,
        width,
        height,
        bitmap,
        conditionOnTypography: true,
        regionMask: { bounds, data: selection },
        sourceRect: bounds,
        fallbackConstraint: null,
        segmentation: {
          imageWidth: width,
          imageHeight: height,
          detections: [
            {
              label: "onomatopoeia",
              labelId: 1,
              score: 0.99,
              box: [0, 0, width, height],
              mask: {
                width,
                height,
                logits: Float32Array.from(selection, (v) => (v ? 10 : -10)),
              },
            },
          ],
        },
      });
      expect(plan.measuredBrush).toBe(true);
      for (const layer of [plan.modelMask, plan.compositeMask]) {
        const pixels = expandWindowMaskToPage(layer, width, height);
        expect(pixels[183 * width + 247]).toBe(0);
        expect(pixels[109 * width + 183]).toBe(hasRule ? 0 : 1);
        expect(pixels[46 * width + 48]).toBe(1);
        expect(pixels[46 * width + 40]).toBe(1);
      }
    },
  );
  it("recovers an incomplete brush stroke and preserves the garment merged into a local detection", () => {
    const width = 310,
      height = 225;
    const bounds = { x: 0, y: 0, w: width, h: height };
    const glyph = new Uint8Array(width * height);
    const owned = new Uint8Array(glyph.length);
    const centers = [
      [48, 50],
      [112, 45],
      [174, 54],
      [68, 141],
      [168, 128],
    ];
    for (const [x, y] of centers)
      for (let dy = 0; dy < 43; dy++) {
        const first = (y + dy) * width + x;
        glyph.fill(1, first, first + 25);
        owned.fill(1, first, first + (x === 174 ? 11 : 25));
      }
    const paper = dilateBinaryMaskDisk(glyph, width, height, 8);
    const bitmap = Buffer.alloc(glyph.length * 4, 255);
    for (let i = 0; i < glyph.length; i++) {
      const x = i % width,
        y = Math.floor(i / width);
      const garment = x >= 224 && x < 270 && y > 65 && y < 148;
      bitmap.fill(
        garment || glyph[i] ? 12 : paper[i] ? 254 : 170,
        i * 4,
        i * 4 + 3,
      );
      if (garment) owned[i] = 1;
    }
    bitmap.fill(30, width * 4, width * 8);
    const fixed = recoverOutlinedBrushEffect(
      bitmap,
      { width, height },
      { bounds, data: owned },
    );
    expect(fixed?.data[75 * width + 194]).toBe(1);
    expect(fixed?.data[70 * width + 43]).toBe(1);
    expect(fixed?.data[102 * width + 241]).toBe(0);
    expect(fixed?.data[width + 38]).toBe(0);
    const sparse = { bounds, data: new Uint8Array(owned.length) };
    sparse.data.fill(1, 0, 285);
    expect(
      recoverOutlinedBrushEffect(bitmap, { width, height }, sparse),
    ).toBeUndefined();
    expect(
      measureDetectedBrush(bitmap, { width, height }, sparse),
    ).toBeUndefined();
    const blank = Buffer.alloc(bitmap.length, 255);
    expect(
      measureDetectedBrush(blank, { width, height }, { bounds, data: owned }),
    ).toBeUndefined();
    expect(
      recoverOutlinedBrushEffect(
        bitmap,
        { width, height },
        { bounds, data: glyph },
      ),
    ).toBeUndefined();
    for (let i = 0; i < paper.length; i++)
      if (paper[i] && !glyph[i]) bitmap.fill(170, i * 4, i * 4 + 3);
    expect(
      recoverOutlinedBrushEffect(
        bitmap,
        { width, height },
        { bounds, data: owned },
      ),
    ).toBeUndefined();
  });
  it.each([false, true])(
    "keeps a hard sound-effect rim alongside outlined lettering (outlined %s)",
    (outlined) => {
      const width = 422,
        height = 180;
      const bitmap = Buffer.alloc(width * height * 4, 255);
      const glyph = Uint8Array.from({ length: width * height }, (_, i) => {
        const x = i % width,
          y = Math.floor(i / width);
        return Number(
          (x >= 330 && x < 338 && y >= 44 && y < 139) ||
            (y >= 67 && y < 75 && x >= 299 && x < 374) ||
            (y >= 91 && y < 98 && x >= 300 && x < 368),
        );
      });
      const rim = dilateBinaryMaskDisk(glyph, width, height, 6);
      const logits = Float32Array.from(glyph, (v, i) => {
        const x = i % width,
          y = Math.floor(i / width);
        if (x >= 237) {
          const level = v ? 15 : rim[i] ? 254 : 182 + (i % 5) * 6;
          bitmap.fill(level, 4 * i, 4 * i + 3);
        }
        return v || (outlined && x >= 78 && x < 208 && y >= 5 && y < 147)
          ? 10
          : -10;
      });
      const strokes = outlined
        ? [
            [34, 19, 80],
            [109, 13, 49],
            [124, 84, 43],
          ]
        : [];
      for (const [left, top, rows] of strokes) {
        for (let y = 0; y < rows; y++)
          for (let dx = 0; dx < 13; dx++) {
            if (dx > 1 && dx < 11 && y > 1 && y < rows - 2) continue;
            const p = ((top + y) * width + left + y + dx) * 4;
            bitmap.fill(25, p, p + 3);
          }
      }
      const page = { ...makePage(), blocks: [makeBlock()], width, height };
      const sourceRect = { x: 0, y: 0, w: width, h: height };
      const plan = resolvePatternFluxCompositePlan({
        page,
        block: page.blocks[0],
        width,
        height,
        bitmap,
        sourceRect,
        regionMask: { bounds: sourceRect, data: glyph },
        fallbackConstraint: null,
        conditionOnTypography: true,
        segmentation: {
          imageWidth: width,
          imageHeight: height,
          detections: [
            {
              label: "onomatopoeia",
              labelId: 1,
              box: [0, 0, width, height],
              score: 0.99,
              mask: { width, height, logits },
            },
          ],
        },
      });
      const mask = expandWindowMaskToPage(plan.modelMask, width, height);
      expect(mask[82 * width + 326]).toBe(1);
      expect(mask[82 * width + 319]).toBe(0);
      expect(mask[27 * width + 48]).toBe(Number(outlined));
    },
  );
  it("measures all eight sides of an isolated oversized sound glyph and keeps the adjacent screen", () => {
    const w = 195,
      h = 200,
      bounds = { x: 0, y: 0, w, h };
    const ink = Uint8Array.from({ length: w * h }, (_, i) => {
      const x = i % w,
        y = Math.floor(i / w);
      return Number(
        (x >= 88 && x < 96 && y >= 44 && y < 139) ||
          (y >= 67 && y < 75 && x >= 57 && x < 132) ||
          (y >= 91 && y < 98 && x >= 58 && x < 126),
      );
    });
    const shoulder = dilateBinaryMaskDisk(ink, w, h, 6);
    const tone = Float32Array.from(ink, (on, i) =>
      on ? 15 : shoulder[i] ? 254 : 140 + (i % 5) * 16,
    );
    const result = measuredPrintedKeyline(bounds, ink, tone, true);
    expect(result?.data[82 * w + 84]).toBe(1);
    expect(result?.data[82 * w + 78]).toBe(0);
    expect(measuredPrintedKeyline(bounds, ink, tone)).toBeUndefined();
    for (let y = 44; y < 65; y++)
      for (let x = 79; x < 104; x++) if (!ink[y * w + x]) tone[y * w + x] = 177;
    expect(measuredPrintedKeyline(bounds, ink, tone, true)).toBeUndefined();
  });
  it("recovers scanned folio digits near the margin while preserving the panel's pale edge", () => {
    const w = 230,
      h = 250,
      size = { width: w, height: h },
      image = Buffer.alloc(w * h * 4, 255);
    const box = { x: 13, y: 185, w: 17, h: 13 };
    const paint = (x: number, y: number, v: number) =>
      image.fill(v, (y * w + x) * 4, (y * w + x) * 4 + 3);
    for (let y = 0; y < h; y++) {
      paint(32, y, 8);
      paint(30, y, 247);
    }
    for (let y = 187; y < 196; y++) {
      for (const x of [16, 17, 18, 21, 22, 23, 24]) paint(x, y, 42);
    }
    const read = (text: string) => recoverQwenFolio(image, size, box, text);
    const actual = read("２６");
    expect(actual).toBeDefined();
    if (!actual)
      throw new Error("The isolated baseline digits should be measured");
    const visible = expandWindowMaskToPage(actual, w, h);
    expect(visible[190 * w + 16]).toBe(1);
    expect(visible[190 * w + 30]).toBe(0);
    expect(read("12話")).toBeUndefined();
    expect(read("3")).toBeUndefined();
    expect(
      recoverQwenFolio(image, size, { ...box, x: 95, y: 90 }, "26"),
    ).toBeUndefined();
    for (let y = 177; y < 207; y++)
      for (let x = 7; x < 31; x++)
        if (image[4 * (y * w + x)] === 255) paint(x, y, 231);
    expect(read("26")).toBeUndefined();
  });
  it("recognizes an opaque printed rim across changing original materials", () => {
    const w = 210,
      h = 165,
      bounds = { x: 0, y: 0, w, h };
    const mask = Uint8Array.from({ length: w * h }, (_, i) => {
      const x = i % w,
        y = Math.floor(i / w);
      return Number(
        [46, 90, 134, 178].some((cx) =>
          [35, 73, 111].some(
            (cy) =>
              x >= cx &&
              x < cx + 15 &&
              y >= cy &&
              y < cy + 20 &&
              (x < cx + 4 || y < cy + 4 || (y > cy + 9 && y < cy + 13)),
          ),
        ),
      );
    });
    const shoulder = dilateBinaryMaskDisk(mask, w, h, 5);
    const draw = (printed: boolean) => {
      const tone = Float32Array.from(mask, (set, i) => {
        const x = i % w,
          y = Math.floor(i / w);
        if (set) return 18;
        if (printed && shoulder[i]) return 255;
        return x % 14 < 4 ? 254 : 66 + ((3 * x + 7 * y) % 73);
      });
      return measuredPrintedKeyline(bounds, mask, tone);
    };
    expect(draw(false)).toBeUndefined();
    const keyline = draw(true);
    expect(keyline).toBeDefined();
    expect(keyline?.data[41 * w + 42]).toBe(1);
    expect(keyline?.data[45 * w + 37]).toBe(0);
  });
  it("confines an undetected single sound mark to its native white keyline", () => {
    const width = 360,
      height = 330;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const sourceRect = { x: 131, y: 121, w: 52, h: 55 };
    const regionMask = {
      bounds: sourceRect,
      data: new Uint8Array(52 * 55).fill(1),
    };
    const block = {
      ...makeBlock(),
      id: "sound",
      bbox: sourceRect,
      bboxSpace: "pixels" as const,
    };
    const selected = () =>
      resolvePatternFluxCompositePlan({
        bitmap,
        sourceRect,
        width,
        height,
        regionMask,
        block,
        page: { ...makePage(), width, height, blocks: [block] },
        fallbackConstraint: null,
        conditionOnTypography: true,
        segmentation: {
          imageWidth: width,
          imageHeight: height,
          detections: [],
        },
      });
    const dark = (x: number, y: number) =>
      (x >= 142 && x <= 149 && y >= 128 && y <= 168) ||
      (y >= 149 && y <= 155 && x >= 137 && x <= 175);
    const mark = Uint8Array.from({ length: width * height }, (_, i) =>
      Number(dark(i % width, Math.floor(i / width))),
    );
    const outline = dilateBinaryMaskDisk(mark, width, height, 5);
    for (let i = 0; i < mark.length; i++) {
      const x = i % width,
        y = Math.floor(i / width);
      if (x < 123 || x >= 192 || y < 113 || y >= 185) continue;
      const paper = 244 - ((x & 2) + (y & 2)) * 48;
      const level = mark[i] ? 23 : outline[i] ? 255 : paper;
      bitmap.fill(level, 4 * i, 4 * i + 3);
    }
    const plan = selected();
    expect(plan.featherPx).toBe(0);
    const visible = expandWindowMaskToPage(plan.modelMask, width, height);
    expect(visible[156 * width + 144]).toBe(1);
    expect(visible[142 * width + 153]).toBe(1);
    expect(visible[137 * width + 171]).toBe(0);
    expect(plan.compositeMask).toEqual(plan.modelMask);
    bitmap.fill(255);
    expect(selected().compositeMask).toBe(regionMask);
  });
  it("leaves ambiguous artwork and non-matte strokes on the normal selection route", () => {
    const size = { width: 320, height: 320 };
    const selection = { x: 70, y: 85, w: 50, h: 50 };
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
    const extract = () => recoverQwenIsolatedMark(bitmap, size, selection);
    const stroke = (paper: number, ink: (x: number, y: number) => number) => {
      bitmap.fill(paper);
      for (let y = 90; y < 130; y++) {
        for (let x = 75; x < 115; x++) {
          if ((x >= 88 && x < 96) || (y >= 106 && y < 113)) {
            const start = 4 * (y * size.width + x);
            bitmap.fill(ink(x, y), start, start + 3);
          }
        }
      }
    };
    stroke(255, () => 22);
    expect(extract()).toBeDefined();
    expect(
      recoverQwenIsolatedMark(bitmap, size, { ...selection, w: 25 }),
    ).toBeUndefined();
    expect(
      recoverQwenIsolatedMark(bitmap, size, { ...selection, h: 80 }),
    ).toBeUndefined();
    for (let y = 92; y < 99; y++) {
      const start = 4 * (y * size.width + 103);
      bitmap.fill(20, start, start + 4 * 7);
    }
    expect(extract()).toBeUndefined();
    stroke(218, () => 22);
    expect(extract()).toBeUndefined();
    stroke(255, () => 127);
    expect(extract()).toBeUndefined();
    stroke(255, (x, y) => ((x + y) % 2 ? 75 : 17));
    expect(extract()).toBeUndefined();
  });
});
it("follows the fading tip only while the original ink retains two paper shoulders", () => {
  const width = 156,
    height = 61,
    y = 30;
  const tone = new Uint8Array(width * height).fill(242);
  const core = new Uint8Array(tone.length);
  const positions = Array.from({ length: 47 }, (_, i) => y * width + i + 12);
  for (const p of positions) core[p] = 1;
  for (let x = 12; x < 110; x++) tone[y * width + x] = x < 59 ? 20 : 112;
  for (let x = 85; x < 130; x++) tone[(y - 6) * width + x] = 112;
  const part = {
    rect: { x: 12, y, w: 47, h: 1 },
    data: new Uint8Array(47).fill(1),
    area: 47,
  };
  const stroke = { positions, x: 35, y, axis: 0, aspect: 8, part };
  traceDryBrushEnds({ width, height, tone }, { ...stroke, aspect: 2 }, core);
  expect(core[y * width + 73]).toBe(0);
  traceDryBrushEnds({ width, height, tone }, stroke, core);
  expect(core[y * width + 73]).toBe(1);
  expect(core[y * width + 99]).toBe(0);
  expect(core[(y - 6) * width + 73]).toBe(0);
});
