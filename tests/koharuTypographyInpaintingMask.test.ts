import { describe, expect, it } from "vitest";
import { completeDetectedQwenPrintEdges } from "../src/main/inpainting/qwenDetectedPrintEdge";
import type {
  ComicPageDetection,
  KoharuTypographySegmentation,
} from "../src/main/bubbleLayout/contracts";
import {
  buildKoharuTypographyCompositeMask,
  nativeKoharuTextInstance,
  resolveKoharuTypographyCoreDilationPx,
  resolveKoharuTypographyFeatherPx,
} from "../src/main/inpainting/koharuTypographyMask";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import {
  completeQwenDisplayInk,
  completeQwenOutlinedLettering,
} from "../src/main/inpainting/qwenOutlinedLettering";
import {
  completeContextualCredit,
  measureQwenPrintGlow,
} from "../src/main/inpainting/qwenPrintGlow";
import { recoverQwenDisplayMask } from "../src/main/inpainting/qwenUndetectedDisplay";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import { recoverQwenPigment } from "../src/main/inpainting/qwenPrintedPigment";
import { recoverQwenRuledTitle } from "../src/main/inpainting/qwenRuledTitle";
import { measuredQwenSubtitle } from "../src/main/inpainting/qwenPrintedSubtitle";
import {
  contextualTextTargets,
  refineContextualText,
} from "../src/main/inpainting/qwenContextualTypography";
import { makeFilledDetection, makePage } from "./koharuTypographyMask.fixture";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("Koharu typography inpainting masks", () => {
  it("measures narrow white shoulders around text against pale original screentone", () => {
    const width = 146,
      height = 96,
      size = { width, height };
    const bitmap = Buffer.alloc(4 * width * height, 255);
    const dark = new Uint8Array(width * height);
    const centers = [22, 47, 74, 101, 125];
    const render = (outline: boolean) => {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const d = Math.min(
            ...centers.map((cx) => Math.hypot(x - cx, y - 46)),
          );
          const i = y * width + x;
          dark[i] = Number(d < 6);
          const level = dark[i]
            ? 19
            : outline && d < 10
              ? 254
              : 234 + ((x + y) % 7);
          bitmap.fill(level, 4 * i, 4 * i + 3);
        }
    };
    const instance = {
      bounds: { x: 0, y: 0, w: width, h: height },
      data: dark,
    };
    render(false);
    expect(measureQwenPrintGlow(bitmap, size, instance)).toBeUndefined();
    render(true);
    const m = requireValue(
      measureQwenPrintGlow(bitmap, size, instance),
      "pale print shoulder",
    );
    expect(m.data[46 * width + 82]).toBe(1);
    expect(m.data[46 * width + 88]).toBe(0);
    expect(completeContextualCredit(bitmap, size, instance)).toEqual(m);
  });
  it("fits the narrow white edge of confirmed credit strokes over dark fabric", () => {
    const width = 110,
      height = 62;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const dx = Math.max(0, Math.abs(((x + 1) % 14) - 7) - 1);
        const dy = Math.max(
          0,
          Math.min(Math.abs(y - 20), Math.abs(y - 42)) - 3,
        );
        const distance = Math.hypot(dx, dy);
        const i = y * width + x;
        data[i] = Number(distance === 0);
        const tone = data[i]
          ? 18
          : distance <= 2.3
            ? 253
            : 114 + ((x + y) % 3) * 3;
        bitmap.fill(tone, i * 4, i * 4 + 3);
      }
    const instance = { bounds: { x: 0, y: 0, w: width, h: height }, data };
    const expanded = completeContextualCredit(
      bitmap,
      { width, height },
      instance,
    );
    expect(expanded.data[20 * width + 9]).toBe(1);
    expect(expanded.data[20 * width + 10]).toBe(0);
    expect(expanded.data[31 * width + 6]).toBe(0);
  });
  it("follows a clipped title across a pale frame while retaining both separators and the side ornament", () => {
    const width = 480,
      height = 142,
      selected = { x: 61, y: 45, w: 346, h: 54 };
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const paint = (x: number, y: number, v: number) =>
      bitmap.fill(v, 4 * (y * width + x), 4 * (y * width + x) + 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        paint(x, y, 184 + ((Math.floor(x / 30) + Math.floor(y / 50)) % 3) * 26);
    const drawRule = (y: number) => {
      for (let x = 12; x < width - 14; x++) paint(x, y, 19);
    };
    drawRule(28);
    drawRule(117);
    for (let y = 29; y < 117; y++)
      paint(18 + Math.round(3 * Math.cos(y / 8)), y, 34);
    const recover = () =>
      recoverQwenRuledTitle(bitmap, { width, height }, selected);
    expect(recover()).toBeUndefined();
    for (let x = 44; x < width - 34; x += 39)
      for (let yy = 42; yy < 101; yy++)
        for (let dx = 0; dx < 24; dx++)
          if (dx < 6 || yy < 50 || (yy > 69 && yy < 75))
            paint(x + dx, yy, x < 180 ? 99 : 13);
    const mask = expandWindowMaskToPage(
      requireValue(recover(), "ruled title mask"),
      width,
      height,
    );
    expect(mask[60 * width + 46]).toBe(1);
    expect(mask[60 * width + 436]).toBe(1);
    expect(mask[80 * width + 58]).toBe(0);
    expect(mask[28 * width + 100]).toBe(0);
    expect(mask[117 * width + 100]).toBe(0);
    expect(mask[70 * width + 16]).toBe(0);
    // Add a narrow oscillating compression halo on the pale side of each
    // horizontal and vertical glyph stroke. The distant stock stays smooth.
    for (let y = 34; y < 109; y++)
      for (let x = 35; x < width - 26; x++) {
        const at = y * width + x;
        if (mask[at]) continue;
        const near = [1, 2, 3].some((d) =>
          [at - d, at + d, at - d * width, at + d * width].some((i) => mask[i]),
        );
        if (near) paint(x, y, (x + y) % 2 ? 239 : 196);
      }
    const compressed = expandWindowMaskToPage(
      requireValue(recover(), "printed compression halo"),
      width,
      height,
    );
    expect(compressed[60 * width + 54]).toBe(1);
    expect(compressed[60 * width + 60]).toBe(0);
    expect(compressed[28 * width + 100]).toBe(0);
    for (let x = 0; x < width; x++) paint(x, 28, 215);
    expect(recover()).toBeUndefined();
  });
  it("follows the same printed colour gradient across dark and light illustration", () => {
    const width = 380,
      height = 90;
    const tone = new Uint8Array(width * height);
    for (let i = 0; i < tone.length; i++) {
      const x = i % width,
        y = Math.floor(i / width);
      tone[i] = x > 190 ? 18 + ((x + 3 * y) % 13) : 215 + ((x + 3 * y) % 16);
    }
    expect(recoverQwenPigment(tone, width, height)).toBeUndefined();
    const centers: number[] = [];
    for (let letter = 0; letter < 9; letter++) {
      const start = 13 + letter * 41;
      centers.push(42 * width + start + 6);
      for (let y = 16; y < 72; y++)
        for (let x = start; x < start + 28; x++)
          if (x < start + 12 || y < 27 || (y > 39 && y < 50 && x < start + 23))
            tone[y * width + x] = Math.round(60 + (65 * x) / width);
    }
    const pigment = requireValue(
      recoverQwenPigment(tone, width, height),
      "gradient lettering",
    );
    expect(centers.map((i) => pigment[i])).toEqual(Array(9).fill(1));
    expect(pigment[60 * width + 40]).toBe(0);
    expect(pigment[44 * width + 335]).toBe(0);
  });
  it("includes fine print between two title rules only when the original contains letters there", () => {
    const rect = { x: 0, y: 0, w: 106, h: 64 },
      stride = rect.w;
    const rgb = Buffer.alloc(stride * rect.h * 4, 80);
    const ink = new Uint8Array(stride * rect.h);
    for (let x = 12; x < 94; x++) {
      ink[15 * stride + x] = 1;
      ink[47 * stride + x] = 1;
      for (const y of [25, 34])
        rgb.fill(201, 4 * (y * stride + x), 4 * (y * stride + x) + 3);
    }
    const instance = { bounds: rect, data: ink };
    expect(measuredQwenSubtitle(rgb, stride, rect, instance)).toBeUndefined();
    for (let x = 15; x < 91; x += 3)
      rgb.fill(185, 4 * (29 * stride + x), 4 * (29 * stride + x) + 3);
    const support = requireValue(
      measuredQwenSubtitle(rgb, stride, rect, instance),
      "source subtitle",
    );
    expect(support.data[29 * stride + 52]).toBe(1);
    expect(support.data[29 * stride + 2]).toBe(0);
    expect(support.data[49 * stride + 52]).toBe(0);
  });
  it("registers crop predictions to the same selected instance and ignores a nearby word", async () => {
    const page = makePage();
    page.width = 500;
    page.height = 500;
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { x: 360, y: 280, w: 124, h: 114 },
      bboxSpace: "normalized_1000",
    };
    const weak = {
      ...makeFilledDetection("text", 0, [191, 151, 218, 182]),
      score: 0.29,
    };
    const segmentation = {
      imageWidth: 500,
      imageHeight: 500,
      detections: [weak],
    };
    const targets = contextualTextTargets(page, segmentation, []);
    expect(targets).toHaveLength(1);
    expect(contextualTextTargets(page, segmentation, [], [])).toHaveLength(0);
    const id = page.blocks[0].id;
    const refined = await refineContextualText(
      page,
      targets,
      async (view) => {
        const box = (
          x: number,
          y: number,
          r: number,
          b: number,
        ): ComicPageDetection["box"] => [
          x - view.x,
          y - view.y,
          r - view.x,
          b - view.y,
        ];
        return {
          imageWidth: view.width,
          imageHeight: view.height,
          detections: [
            makeFilledDetection("text", 0, box(195, 151, 226, 182)),
            makeFilledDetection("text", 0, box(235, 185, 258, 202)),
          ],
        };
      },
      new AbortController().signal,
    );
    const mask = expandWindowMaskToPage(
      requireValue(refined.get(id), "registered native text"),
      500,
      500,
    );
    expect(mask[161 * 500 + 225]).toBe(1);
    expect(mask[187 * 500 + 237]).toBe(0);
    const planned = resolvePatternFluxCompositePlan({
      page,
      width: page.width,
      height: page.height,
      block: page.blocks[0],
      bitmap: Buffer.alloc(500 * 500 * 4, 255),
      conditionOnTypography: true,
      segmentation: { ...segmentation, contextualText: refined },
      sourceRect: targets[0].selected,
      fallbackConstraint: null,
      regionMask: requireValue(targets[0].full, "original page instance"),
    });
    const conditioning = expandWindowMaskToPage(planned.modelMask, 500, 500);
    expect(conditioning[161 * 500 + 225]).toBe(1);
    expect(conditioning[187 * 500 + 237]).toBe(0);
    page.blocks.push({ ...page.blocks[0], id: "adjacent-owner" });
    expect(contextualTextTargets(page, segmentation, [])).toHaveLength(0);
  });
  it("recovers undetected cover strokes and open white medallions while preserving adjacent line art", () => {
    const width = 436,
      height = 142,
      size = { width, height };
    const rect = { x: 8, y: 12, w: 412, h: 109 };
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const paint = (x: number, y: number, v: number) => {
      const at = (y * width + x) * 4;
      bitmap.fill(v, at, at + 3);
    };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // A broad garment edge crosses the bottom of the OCR selection.
        if (y > 92 && Math.abs(x - 75 - (y - 92)) < 12) paint(x, y, 23);
      }
    expect(recoverQwenDisplayMask(bitmap, size, rect)).toBeUndefined();
    function medallion(x: number, y: number) {
      const body =
        Math.hypot(x - 310, y - 61) < 20 ||
        Math.hypot(x - 354, y - 61) < 20 ||
        (x > 310 && x < 354 && Math.abs(y - 61) < 3);
      return body && !(x >= 351 && x <= 355 && y < 68);
    }
    for (let y = 27; y < 91; y++)
      for (let x = 15; x < 410; x++) {
        const dx = (x - 15) % 44;
        if (x < 273 && dx < 25 && (dx < 12 || y >= 65)) paint(x, y, 48);
        if (medallion(x, y)) paint(x, y, 58);
        if (x >= 387 && x <= 406 && y >= 69 && y <= 87) paint(x, y, 53);
      }
    const native = recoverQwenDisplayMask(bitmap, size, rect);
    const pixels = expandWindowMaskToPage(
      requireValue(native, "printed cover"),
      width,
      height,
    );
    expect(pixels[54 * width + 22]).toBe(1);
    expect(pixels[56 * width + 354]).toBe(1);
    expect(pixels[115 * width + 98]).toBe(0);
    expect(pixels[60 * width + 130]).toBe(0);
  });
  it("keeps overlapping dialogue and sound-effect detector ink on the native Qwen grid", () => {
    const page = makePage();
    const text = makeFilledDetection("text", 0, [25, 25, 32, 34]);
    const effect = makeFilledDetection("onomatopoeia", 2, [32, 29, 39, 35]);
    const invalid = makeFilledDetection("text", 0, [NaN, 24, 34, 40]);
    const masks = buildPatternPageMask({
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      width: 64,
      height: 64,
      page,
      mode: "flux-region",
      conditionOnTypography: true,
      typographySegmentation: makeSegmentation([text, effect, invalid]),
    });
    const selected = expandWindowMaskToPage(
      requireValue(masks.inpaintWindowMasks[0], "mixed print mask"),
      64,
      64,
    );
    expect(selected[29 * 64 + 28]).toBe(1);
    expect(selected[31 * 64 + 35]).toBe(1);
    expect(nativeKoharuTextInstance(invalid, page)).toBeUndefined();
    expect(nativeKoharuTextInstance(effect, page)).toBeUndefined();
    expect(
      nativeKoharuTextInstance({ ...text, mask: undefined }, page),
    ).toBeUndefined();
  });
  it("keeps the measured white keyline of multiple printed glyphs on dark art", () => {
    const width = 190,
      height = 150,
      size = { width, height };
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const mask = {
      bounds: { x: 0, y: 0, w: width, h: height },
      data: new Uint8Array(width * height),
    };
    const glyphs = [
      [45, 38],
      [67, 51],
      [88, 65],
      [108, 82],
    ];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = Math.min(
          ...glyphs.map(([left, top]) =>
            Math.hypot(
              Math.max(left - x, x - left - 13, 0),
              Math.max(top - y, y - top - 16, 0),
            ),
          ),
        );
        if (!d) mask.data[i] = 1;
        const shade = glyphs.some(
          ([l, t]) => x >= l + 3 && x <= l + 8 && y >= t + 2 && y < t + 12,
        )
          ? 10
          : d <= 6
            ? 255
            : 47;
        bitmap.fill(shade, 4 * i, 4 * i + 3);
      }
    const result = requireValue(
      measureQwenPrintGlow(bitmap, size, mask),
      "white print keyline",
    );
    expect(result.data[43 * width + 40]).toBe(1);
    expect(result.data[43 * width + 30]).toBe(0);
    expect(measureQwenPrintGlow(bitmap, size, mask, result)).toBeUndefined();
    // The layout detector may trace the outside of the white print on a
    // textured background. Retain that exact limit, including any holes.
    for (let i = 0; i < mask.data.length; i++) {
      const shade = (i + Math.floor(i / width)) % 2 ? 28 : 85;
      if (bitmap[i * 4] === 47) bitmap.fill(shade, i * 4, i * 4 + 3);
    }
    const selection = { ...result, data: result.data.slice() };
    selection.data[43 * width + 42] = 0;
    const page = { ...makePage(), width, height };
    const block = page.blocks[0];
    block.bbox = { x: 32, y: 25, w: 103, h: 92 };
    block.bboxSpace = "pixels";
    const detections = glyphs.map(([x, y]) =>
      makeFilledDetection("text", 0, [x, y, x + 14, y + 17]),
    );
    const pattern = (constraint: typeof selection, qwen: boolean) =>
      buildPatternPageMask({
        bitmap,
        width,
        height,
        page,
        mode: "flux-region",
        conditionOnTypography: qwen,
        bubbleLayoutConstraintBlockIds: [block.id],
        sourceEraseConstraintsByBlock: { [block.id]: constraint },
        typographySegmentation: {
          imageWidth: width,
          imageHeight: height,
          detections,
        },
      });
    const artwork = pattern(selection, true);
    expect(artwork.inpaintSpeechBubbleWindows).toEqual([false]);
    const native = expandWindowMaskToPage(
      artwork.inpaintWindowMasks[0],
      width,
      height,
    );
    expect(native[43 * width + 40]).toBe(1);
    expect(native[43 * width + 42]).toBe(0);
    expect(pattern(selection, false).inpaintSpeechBubbleWindows).toEqual([
      true,
    ]);
    expect(
      pattern({ ...result, data: result.data.map(() => 1) }, true)
        .inpaintSpeechBubbleWindows,
    ).toEqual([true]);
    // The detector missed two bright native edge pixels. Recover them only
    // when constructing a fresh, isolated automatic source constraint.
    const cut = { ...selection, data: selection.data.slice() };
    for (let y = 37; y < 55; y++) cut.data.fill(0, y * width, y * width + 41);
    const layout = {
      version: 1 as const,
      origin: "detected" as const,
      direction: "horizontal" as const,
      regions: [],
      confidence: 1,
      insetRatio: 0,
    };
    const patch = {
      blockId: block.id,
      bubbleLayout: layout,
      sourceEraseConstraint: cut,
    };
    const refine = (pg: MangaPage, ids?: string[]) =>
      completeDetectedQwenPrintEdges(
        pg,
        [patch],
        {
          detections,
          imageWidth: width,
          imageHeight: height,
        },
        bitmap,
        new AbortController().signal,
        ids,
      )[0];
    const adjusted = expandWindowMaskToPage(
      requireValue(refine(page).sourceEraseConstraint, "native edge"),
      width,
      height,
    );
    expect(
      Array.from(adjusted.slice(43 * width + 38, 43 * width + 43)),
    ).toEqual([0, 1, 1, 1, 0]);
    expect(cut.data[43 * width + 40]).toBe(0);
    expect(refine(page, ["another"])).toBe(patch);
    expect(
      refine({ ...page, blocks: [block, { ...block, id: "neighbor" }] }),
    ).toBe(patch);
    expect(
      refine({
        ...page,
        blocks: [{ ...block, bubbleLayout: { ...layout, origin: "manual" } }],
      }),
    ).toBe(patch);
  });
  it("restores missing native title ink from flat two-colour type with a measured white keyline", () => {
    const width = 360,
      height = 165;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const instance = {
      bounds: { x: 0, y: 0, w: width, h: height },
      data: new Uint8Array(width * height),
    };
    const source = { x: 18, y: 30, w: 263, h: 81 };
    const native = (value: number, i: number) =>
      bitmap.fill(value, 4 * i, 4 * i + 3);
    function print(style: "solid" | "tones" | "texture", surround = 255) {
      for (let i = 0; i < width * height; i++) native(surround, i);
      for (const left of [28, 117, 207, 297])
        for (let y = 0; y < 56; y++)
          for (let x = 0; x < 54; x++) {
            if (x > 14 && x < 28 && y > 19 && y < 29) continue;
            const i = (47 + y) * width + left + x;
            const tone = style === "solid" ? 26 : x < 32 ? 21 : 85;
            native(style === "texture" ? 13 + ((i * 13) % 123) : tone, i);
            instance.data[i] = Number(
              !(x >= 28 && x <= 37 && y >= 7 && y <= 44),
            );
          }
    }
    const index = 65 * width + 117 + 32;
    print("tones");
    expect(instance.data[index]).toBe(0);
    const restored = requireValue(
      completeQwenDisplayInk(bitmap, { width, height }, instance, source),
      "two-tone title",
    );
    expect(restored.data[index]).toBe(1);
    expect(restored.data[65 * width + 297 + 32]).toBe(0);
    expect(restored.data[22 * width + 117]).toBe(0);
    print("solid");
    expect(
      completeQwenDisplayInk(bitmap, { width, height }, instance, source)?.data[
        index
      ],
    ).toBe(1);
    print("texture");
    expect(
      completeQwenDisplayInk(bitmap, { width, height }, instance, source),
    ).toBeUndefined();
    print("tones", 174);
    expect(
      completeQwenDisplayInk(bitmap, { width, height }, instance, source),
    ).toBeUndefined();
    print("solid");
    for (let y = 45; y < 110; y++)
      instance.data.fill(0, y * width + 117, y * width + 168);
    expect(
      completeQwenDisplayInk(bitmap, { width, height }, instance, source),
    ).toBeUndefined();
  });
  it("measures the full soft surround on repeated print while preserving distant art and sharp outlines", () => {
    const width = 210,
      height = 210;
    const origins = [
      [65, 36],
      [65, 66],
      [65, 96],
      [167, 152],
    ];
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const instance = {
      bounds: { x: 0, y: 0, w: width, h: height },
      data: new Uint8Array(width * height),
    };
    function paint(soft: boolean) {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let value = 90;
          for (const [left, top] of origins) {
            const dx = Math.max(0, left - x, x - left - 13);
            const dy = Math.max(0, top - y, y - top - 13);
            const d = Math.hypot(dx, dy);
            const alpha = soft
              ? Math.exp(-0.5 * (d / 7.5) ** 2)
              : Number(d < 4);
            value = Math.max(value, Math.round(90 + 165 * alpha));
            if (d === 0) instance.data[y * width + x] = 1;
          }
          if (
            origins.some(
              ([left, top]) =>
                x > left + 3 && x < left + 8 && y >= top + 3 && y < top + 10,
            )
          )
            value = 16;
          bitmap.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
        }
    }
    paint(true);
    const glow = requireValue(
      measureQwenPrintGlow(bitmap, { width, height }, instance),
      "measured print glow",
    );
    expect(glow.data[70 * width + 54]).toBe(1);
    expect(glow.data[70 * width + 28]).toBe(0);
    expect(glow.data[156 * width + 156]).toBe(0);
    paint(false);
    expect(
      measureQwenPrintGlow(bitmap, { width, height }, instance),
    ).toBeUndefined();
  });
  it("completes a trailing character only with two distinct, detector-owned matching specimens", () => {
    const width = 220,
      height = 136,
      bitmap = Buffer.alloc(width * height * 4, 255);
    const page = { ...makePage(), width, height };
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: {
        x: (20 * 1000) / width,
        y: (17 * 1000) / height,
        w: (31 * 1000) / width,
        h: (70 * 1000) / height,
      },
    };
    const draw = (left: number, top: number, letter: "L" | "F") => {
      for (let y = 0; y < 14; y++)
        for (let x = 0; x < 14; x++) {
          const ink =
            x < 3 ||
            (letter === "F" ? y < 3 || (y >= 6 && y < 9 && x < 9) : y >= 11);
          if (ink)
            bitmap.fill(
              30,
              4 * ((top + y) * width + left + x),
              4 * ((top + y) * width + left + x) + 3,
            );
        }
    };
    draw(29, 23, "L");
    draw(29, 42, "L");
    draw(29, 63, "F");
    draw(128, 27, "F");
    draw(164, 64, "F");
    const first = makeFilledDetection("text", 0, [24, 18, 47, 59]),
      one = makeFilledDetection("text", 0, [124, 23, 147, 46]),
      two = makeFilledDetection("text", 0, [160, 60, 184, 84]);
    function hasTrailingCharacter(detections: ComicPageDetection[]) {
      const mask = buildPatternPageMask({
        page,
        width,
        height,
        bitmap,
        mode: "flux-region",
        conditionOnTypography: true,
        typographySegmentation: {
          imageWidth: width,
          imageHeight: height,
          detections,
        },
      }).inpaintWindowMasks[0];
      return expandWindowMaskToPage(
        requireValue(mask, "Qwen model mask"),
        width,
        height,
      )[64 * width + 39];
    }
    expect(hasTrailingCharacter([first, one, one])).toBe(0);
    expect(hasTrailingCharacter([first, one, two])).toBe(1);
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { ...page.blocks[0].bbox, h: (43 * 1000) / height },
    };
    expect(hasTrailingCharacter([first, one, two])).toBe(0);
  });
  it("completes a partially selected printed outline only with matching intact strokes", () => {
    const width = 220,
      height = 160;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const bounds = { x: 78, y: 5, w: 130, h: 142 };
    const instance = {
      bounds,
      data: new Uint8Array(bounds.w * bounds.h).fill(1),
    };
    const draw = (left: number, top: number, rows: number) => {
      for (let y = 0; y < rows; y++) {
        const x0 = left + y;
        for (let dx = 0; dx < 13; dx++) {
          if (dx > 1 && dx < 11 && y > 1 && y < rows - 2) continue;
          const p = ((top + y) * width + x0 + dx) * 4;
          bitmap.fill(25, p, p + 3);
        }
      }
    };
    draw(34, 19, 80);
    draw(109, 13, 49);
    expect(
      completeQwenOutlinedLettering(bitmap, { width, height }, instance),
    ).toBeUndefined();
    draw(124, 84, 43);
    const found = completeQwenOutlinedLettering(
      bitmap,
      { width, height },
      instance,
    );
    expect(found?.bounds).toEqual({ x: 34, y: 19, w: 92, h: 80 });
    expect(found?.data[8 * 92 + 14]).toBe(1);
    const page = { ...makePage(), width, height };
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { x: 355, y: 31, w: 590, h: 888 },
    };
    const prepare = (label: "text" | "onomatopoeia") =>
      buildPatternPageMask({
        page,
        width,
        height,
        bitmap,
        mode: "flux-region",
        conditionOnTypography: true,
        typographySegmentation: {
          imageWidth: width,
          imageHeight: height,
          detections: [
            makeFilledDetection(
              label,
              label === "text" ? 0 : 1,
              [78, 5, 208, 147],
            ),
          ],
        },
      }).inpaintWindowMasks[0];
    const sample = (label: "text" | "onomatopoeia") =>
      expandWindowMaskToPage(
        requireValue(prepare(label), "model window"),
        width,
        height,
      )[27 * width + 48];
    expect(sample("onomatopoeia")).toBe(1);
    expect(sample("text")).toBe(0);
    // A dark interior object contradicts the bright print even if the outer shape matches.
    for (let y = 3; y < 77; y++) {
      const p = ((19 + y) * width + 34 + y + 5) * 4;
      bitmap.fill(80, p, p + 12);
    }
    expect(
      completeQwenOutlinedLettering(bitmap, { width, height }, instance),
    ).toBeUndefined();
  });
  it("conditions Qwen on the original letters inside a decorated balloon", () => {
    const page = makePage();
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { x: 125, y: 125, w: 750, h: 750 },
    };
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      height: 64,
      width: 64,
      mode: "flux-region",
      conditionOnTypography: true,
      typographySegmentation: makeSegmentation([
        makeFilledDetection("text", 0, [14, 14, 19, 46]),
        makeFilledDetection("text", 0, [44, 14, 49, 46]),
      ]),
    });
    const model = expandWindowMaskToPage(
      requireValue(context.inpaintWindowMasks[0], "model mask"),
      64,
      64,
    );
    const composite = expandWindowMaskToPage(
      requireValue(context.inpaintCompositeMasks[0], "composite mask"),
      64,
      64,
    );
    expect(model[30 * 64 + 16]).toBe(1);
    expect(model[30 * 64 + 46]).toBe(1);
    expect(model[30 * 64 + 32]).toBe(0);
    expect(model[30 * 64 + 21]).toBe(0);
    expect(composite[30 * 64 + 21]).toBe(1);
  });

  it("does not substitute neighboring ink for an undetected selected effect", () => {
    const page = { ...makePage(), width: 200, height: 200 };
    const result = buildKoharuTypographyCompositeMask({
      block: page.blocks[0] as TranslationBlock,
      featherPx: 8,
      height: 200,
      width: 200,
      page,
      segmentation: {
        imageWidth: 200,
        imageHeight: 200,
        detections: [makeFilledDetection("text", 0, [40, 30, 60, 49])],
      },
      sourceRect: { x: 20, y: 50, w: 100, h: 100 },
    });
    expect(result).toBeNull();
  });
  it("associates a crossing effect box only when its native ink reaches the selected sign", () => {
    const page = makePage();
    const sound = makeDetection("onomatopoeia", 1, [18, 12, 58, 53]);
    const sourceRect = { x: 24, y: 43, w: 31, h: 12 };
    const args = {
      block: page.blocks[0],
      page,
      width: 64,
      height: 64,
      requireInkInSourceRect: true,
      featherPx: 1,
      sourceRect,
      segmentation: { imageWidth: 64, imageHeight: 64, detections: [sound] },
    };
    expect(buildKoharuTypographyCompositeMask(args)).toBeNull();
    const sign = makeFilledDetection("text", 0, [27, 46, 49, 51]);
    const hit = buildKoharuTypographyCompositeMask({
      ...args,
      segmentation: { ...args.segmentation, detections: [sound, sign] },
    });
    expect(hit?.detectionCount).toBe(1);
    expect(hit?.instance.bounds.y).toBeGreaterThan(43);
    expect(
      buildKoharuTypographyCompositeMask({
        ...args,
        requireInkInSourceRect: false,
      }),
    ).not.toBeNull();
  });
  it("does not claim a distant SFX when one detector instance spans both blocks", () => {
    const page = { ...makePage(), width: 200, height: 200 };
    const detection = makeFilledDetection("onomatopoeia", 1, [20, 40, 170, 80]);
    const result = buildKoharuTypographyCompositeMask({
      block: page.blocks[0] as TranslationBlock,
      featherPx: 8,
      height: 200,
      width: 200,
      page,
      segmentation: {
        imageWidth: 200,
        imageHeight: 200,
        detections: [detection],
      },
      sourceRect: { x: 20, y: 40, w: 30, h: 40 },
    });
    const mask = requireValue(result, "selected SFX mask");
    const core = expandWindowMaskToPage(mask.core, 200, 200);
    const envelope = expandWindowMaskToPage(mask.featherEnvelope, 200, 200);
    expect(core[60 * 200 + 35]).toBe(1);
    expect(envelope[60 * 200 + 150]).toBe(0);
    expect(
      mask.featherEnvelope.bounds.x + mask.featherEnvelope.bounds.w,
    ).toBeLessThan(100);
  });
  it("keeps a nearby excluded detection outside all selected-block Flux masks", () => {
    const page = { ...makePage(), width: 100, height: 100 };
    page.blocks[0] = {
      ...requireValue(page.blocks[0], "page block"),
      bbox: { x: 400, y: 400, w: 100, h: 100 },
      renderBbox: { x: 200, y: 200, w: 400, h: 400 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 1,
        origin: "manual",
        insetRatio: 0,
        regions: [
          {
            spans: [
              { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
            ],
          },
        ],
      },
    };
    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(100 * 100 * 4, 255),
      bubbleLayoutConstraintBlockIds: ["block-1"],
      height: 100,
      width: 100,
      mode: "flux-region",
      page,
      typographySegmentation: {
        ...makeSegmentation([
          makeFilledDetection("text", 0, [40, 40, 50, 50]),
          makeFilledDetection("text", 0, [61, 40, 66, 45]),
        ]),
        imageWidth: 100,
        imageHeight: 100,
      },
    });
    for (const inventory of [
      context.inpaintWindowMasks,
      context.inpaintCompositeMasks,
      context.inpaintWindowConstraints,
    ]) {
      const mask = expandWindowMaskToPage(
        requireValue(inventory[0], "mask"),
        100,
        100,
      );
      expect(mask[42 * 100 + 63]).toBe(0);
      expect(mask[45 * 100 + 45]).toBe(1);
      for (let y = 0; y < 100; y += 1) {
        for (let x = 0; x < 100; x += 1) {
          if (x < 20 || x >= 60 || y < 20 || y >= 60)
            expect(mask[y * 100 + x]).toBe(0);
        }
      }
    }
  });

  it("lets Codex discover all text in a selected region even when segmentation misses it", () => {
    const page = makePage();
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { x: 125, y: 125, w: 750, h: 750 },
    };
    const options = {
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      height: 64,
      width: 64,
      page,
      mode: "flux-region" as const,
      typographySegmentation: makeSegmentation([
        makeFilledDetection("onomatopoeia", 1, [14, 14, 19, 46]),
        makeFilledDetection("onomatopoeia", 1, [44, 14, 49, 46]),
      ]),
    };
    const codex = buildPatternPageMask({ ...options, mode: "codex-region" });
    const model = expandWindowMaskToPage(
      requireValue(codex.inpaintWindowMasks[0], "model mask"),
      64,
      64,
    );
    const constraint = expandWindowMaskToPage(
      requireValue(codex.inpaintWindowConstraints[0], "constraint"),
      64,
      64,
    );
    expect(model[30 * 64 + 16]).toBe(1);
    expect(model[30 * 64 + 46]).toBe(1);
    expect(model[30 * 64 + 32]).toBe(1);
    expect(constraint[30 * 64 + 32]).toBe(1);
    expect(model).toEqual(constraint);
    const restyled = buildPatternPageMask({
      ...options,
      mode: "codex-region",
      page: {
        ...page,
        blocks: [{ ...page.blocks[0], fontSizePx: 180, outlineWidthPx: 50 }],
      },
    });
    expect(restyled.pageMask).toEqual(codex.pageMask);
    const legacy = buildPatternPageMask(options);
    expect(legacy.pageMask[30 * 64 + 32]).toBe(1);
    expect(() =>
      buildPatternPageMask({
        ...options,
        mode: "codex-region",
        typographySegmentation: undefined,
      }),
    ).not.toThrow();
  });
  it("builds a solid outlined-glyph core and a wider feather envelope", () => {
    const page = makePage();
    const block = page.blocks[0] as TranslationBlock;
    const segmentation = makeSegmentation([
      makeDetection("text", 0, [24, 24, 40, 40]),
      makeDetection("bubble", 2, [8, 8, 56, 56]),
    ]);

    const result = buildKoharuTypographyCompositeMask({
      block,
      featherPx: 8,
      height: 64,
      page,
      segmentation,
      sourceRect: { x: 24, y: 24, w: 16, h: 16 },
      width: 64,
    });

    const mask = requireValue(result, "Koharu typography mask");
    expect(mask.detectionCount).toBe(1);
    expect(mask.coreDilationPx).toBeGreaterThanOrEqual(4);
    const core = expandWindowMaskToPage(mask.core, 64, 64);
    const envelope = expandWindowMaskToPage(mask.featherEnvelope, 64, 64);
    expect(countMask(core)).toBeGreaterThan(16 * 16);
    expect(countMask(envelope)).toBeGreaterThan(countMask(core));
    expect(core.every((value, index) => !value || envelope[index] === 1)).toBe(
      true,
    );
  });

  it("keeps the model mask broad while binding final composite and validation to typography", () => {
    const page = makePage();
    const segmentation = makeSegmentation([
      makeDetection("text", 0, [25, 25, 39, 39]),
    ]);
    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      height: 64,
      mode: "flux-region",
      page,
      typographySegmentation: segmentation,
      width: 64,
    });

    expect(context.inpaintWindowMasks).toHaveLength(1);
    expect(context.inpaintCompositeMasks).toHaveLength(1);
    expect(context.inpaintWindowConstraints).toHaveLength(1);
    const model = expandWindowMaskToPage(
      requireValue(context.inpaintWindowMasks[0], "model mask"),
      64,
      64,
    );
    const composite = expandWindowMaskToPage(
      requireValue(context.inpaintCompositeMasks[0], "composite mask"),
      64,
      64,
    );
    const constraint = expandWindowMaskToPage(
      requireValue(context.inpaintWindowConstraints[0], "constraint mask"),
      64,
      64,
    );
    const validation = expandWindowMaskToPage(
      requireValue(context.validationWindowMasks[0], "validation mask"),
      64,
      64,
    );
    expect(countMask(model)).toBeGreaterThan(countMask(composite));
    expect(countMask(constraint)).toBeGreaterThan(countMask(composite));
    expect(composite).toEqual(validation);
    expect(
      composite.every((value, index) => !value || constraint[index] === 1),
    ).toBe(true);
  });

  it("keeps typography from both lobes of one constrained bubble in the final composite", () => {
    const page = makePage();
    page.blocks[0] = {
      ...requireValue(page.blocks[0], "page block"),
      bbox: { x: 375, y: 125, w: 250, h: 187.5 },
      renderBbox: { x: 250, y: 62.5, w: 500, h: 875 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.99,
        origin: "detected",
        modelId: "test-connected-bubble",
        sourceImageRevision: "test-revision",
        insetRatio: 0,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0,
                inlineEnd: 1,
              },
            ],
          },
        ],
      },
    };
    const segmentation = makeSegmentation([
      makeFilledDetection("text", 0, [26, 10, 38, 20]),
      makeFilledDetection("text", 0, [26, 44, 38, 54]),
      makeFilledDetection("text", 0, [2, 44, 10, 54]),
    ]);

    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      bubbleLayoutConstraintBlockIds: ["block-1"],
      height: 64,
      mode: "flux-region",
      page,
      typographySegmentation: segmentation,
      width: 64,
    });
    const composite = expandWindowMaskToPage(
      requireValue(context.inpaintCompositeMasks[0], "composite mask"),
      64,
      64,
    );

    expect(composite[15 * 64 + 32]).toBe(1);
    expect(composite[49 * 64 + 32]).toBe(1);
    expect(composite[49 * 64 + 6]).toBe(0);
  });

  it("fails closed when detector and page dimensions drift", () => {
    const page = makePage();
    expect(() =>
      buildKoharuTypographyCompositeMask({
        block: requireValue(page.blocks[0], "page block"),
        featherPx: 8,
        height: 64,
        page,
        segmentation: { ...makeSegmentation([]), imageWidth: 63 },
        sourceRect: { x: 24, y: 24, w: 16, h: 16 },
        width: 64,
      }),
    ).toThrow("image size drifted");
  });

  it("expands thick outlined styles more than plain dialogue", () => {
    const block = requireValue(makePage().blocks[0], "page block");
    expect(
      resolveKoharuTypographyCoreDilationPx(
        {
          ...block,
          fontSizePx: 40,
          outlineWidthPx: 8,
        },
        makePage(),
      ),
    ).toBeGreaterThan(
      resolveKoharuTypographyCoreDilationPx(
        {
          ...block,
          fontSizePx: 20,
          outlineWidthPx: 0,
        },
        makePage(),
      ),
    );
  });

  it("scales feather width with page resolution instead of fixing it at 8px", () => {
    const block = requireValue(makePage().blocks[0], "page block");
    expect(
      resolveKoharuTypographyFeatherPx(block, { width: 2000, height: 2800 }),
    ).toBeGreaterThan(
      resolveKoharuTypographyFeatherPx(block, { width: 720, height: 1020 }),
    );
  });
});

function makeSegmentation(
  detections: ComicPageDetection[],
): KoharuTypographySegmentation {
  return { imageWidth: 64, imageHeight: 64, detections };
}

function makeDetection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
): ComicPageDetection {
  const logits = new Float32Array(8 * 8).fill(-10);
  for (let y = 3; y <= 4; y += 1) {
    for (let x = 3; x <= 4; x += 1) logits[y * 8 + x] = 10;
  }
  return {
    box,
    label,
    labelId,
    mask: { logits, width: 8, height: 8 },
    score: 0.99,
  };
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label}.`);
  }
  return value;
}
