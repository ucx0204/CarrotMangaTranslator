import { describe, expect, it } from "vitest";
import { restoreQwenPaper } from "../src/main/inpainting/qwenPaper";
import {
  restoreEnclosedQwenPaper,
  restoreEnclosedQwenPunctuation,
} from "../src/main/inpainting/qwenBalloonPaper";
import {
  clearQwenPaperRinging,
  restoreFlatQwenText,
} from "../src/main/inpainting/qwenFlatText";
import { QwenRepeatedGlyphs } from "../src/main/inpainting/qwenRepeatedGlyphs";
import { registerBalloonDash } from "../src/main/inpainting/qwenBalloonDash";
import { samplePaperColor } from "../src/main/inpainting/qwenPaperBank";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { recoverQwenFolio } from "../src/main/inpainting/qwenPrintedKeyline";
import { refineQwenPrintedContours } from "../src/main/inpainting/qwenPrintedContours";
import {
  compositeQwenArtwork,
  qwenCropCompositeWeights,
  qwenTextArtworkWeights,
} from "../src/main/inpainting/qwenTextArtwork";
import { qwenReferenceSize } from "../src/main/inpainting/qwenCoverViews";
import { nativeInferencePlan } from "../src/main/runtimeSupport/nativeInferencePlan";

describe("Qwen Image 2.1 crop processing", () => {
  it("requires a bright sample on every channel of the unprinted paper", () => {
    const region = new Uint8Array(20).fill(1);
    const excluded = new Uint8Array(20);
    const luminance = new Uint8Array(20).fill(252);
    const source = Buffer.alloc(80, 255);
    const read = (local?: Uint8Array) =>
      samplePaperColor(source, local, luminance, excluded, (i) => i);
    expect(read()).toBeUndefined();
    excluded.fill(1, 10);
    expect(read(region)).toBeUndefined();
    excluded.fill(0);
    for (let i = 0; i < 20; i++) source[4 * i] = 239;
    expect(read(region)).toBeUndefined();
    source.fill(253);
    expect(read(region)).toEqual([253, 253, 253]);
  });
  it.each([false, true])(
    "includes a terminal dash on verified balloon paper (vertical %s)",
    (vertical) => {
      const length = 121,
        cross = 23;
      const w = vertical ? cross : length,
        h = vertical ? length : cross;
      const bounds = { x: 0, y: 0, w, h };
      const scan = Buffer.alloc(w * h * 4, 255);
      const ink = { bounds, data: new Uint8Array(w * h) };
      const balloon = { bounds, data: new Uint8Array(w * h).fill(1) };
      const at = (u: number, v: number) => (vertical ? v * w + u : u * w + v);
      const paint = (u: number, v: number, level: number) =>
        scan.fill(level, 4 * at(u, v), 4 * at(u, v) + 3);
      for (const top of [18, 38, 58])
        for (let v = top; v < top + 14; v++)
          for (let u = 5; u < 18; u++) {
            if (u > 7 && u < 15 && v > top + 3 && v < top + 11) continue;
            paint(u, v, 21);
            ink.data[at(u, v)] = 1;
          }
      for (let v = 76; v < 111; v++) paint(11, v, 23);
      const checked = () => registerBalloonDash(scan, w, ink, bounds, balloon);
      expect(checked()?.data[at(11, 104)]).toBe(1);
      expect(checked()?.data[at(12, 104)]).toBe(0);
      balloon.data[at(13, 100)] = 0;
      expect(checked()).toBeUndefined();
      balloon.data[at(13, 100)] = 1;
      paint(14, 100, 73);
      expect(checked()).toBeUndefined();
      paint(14, 100, 255);
      for (let v = 58; v < 72; v++)
        for (let u = 5; u < 18; u++) ink.data[at(u, v)] = 0;
      expect(checked()).toBeUndefined();
      for (let v = 38; v < 52; v++)
        for (let u = 5; u < 18; u++) paint(u, v, 255);
      expect(checked()).toBeUndefined();
      for (let v = 76; v < 111; v++) paint(11, v, 255);
      expect(checked()).toBeUndefined();
    },
  );
  it("separates a faint scan bridge from a selected glyph and retains the burst ray", () => {
    const width = 110,
      height = 120,
      scan = Buffer.alloc(width * height * 4, 255),
      mask = new Uint8Array(width * height);
    const draw = (x: number, y: number, intensity: number) =>
      scan.fill(intensity, 4 * (y * width + x), 4 * (y * width + x) + 3);
    for (const top of [30, 51, 72, 93])
      for (let y = top; y < top + 10; y++)
        for (let x = 49; x < 57; x++) {
          draw(x, y, 45);
          mask[y * width + x] = 1;
        }
    for (let x = 9; x < 40; x++) draw(x, 52, 60);
    for (let x = 40; x < 49; x++) draw(x, 52, 248);
    expect(restoreFlatQwenText(scan, mask, width, height)).toBeUndefined();
    const clean = restoreFlatQwenText(scan, mask, width, height, true);
    expect(clean?.[4 * (52 * width + 51)]).toBe(255);
    expect(clean?.[4 * (52 * width + 39)]).toBe(60);
    const textured = Buffer.from(scan);
    for (let i = 0; i < mask.length; i++)
      if (!mask[i] && i % 5 < 2) textured.fill(212, 4 * i, 4 * i + 3);
    expect(
      restoreFlatQwenText(textured, mask, width, height, true),
    ).toBeUndefined();
  });
  it.each([false, true])(
    "registers a typeset ellipsis with two endpoint witnesses (vertical %s)",
    (vertical) => {
      const w = 96,
        h = 96,
        source = Buffer.alloc(w * h * 4, 255),
        selected = new Uint8Array(w * h);
      const at = (u: number, v: number) => (vertical ? u * w + v : v * w + u);
      for (let u = 6; u <= 16; u++)
        for (let v = 18; v <= 27; v++) {
          const i = at(u, v);
          source.fill(24, i * 4, i * 4 + 3);
          selected[i] = 1;
        }
      for (let dot = 0; dot < 6; dot++)
        for (let u = 0; u < 3; u++)
          for (let v = 21; v < 24; v++) {
            const i = at(23 + dot * 9 + u, v);
            source.fill(20, i * 4, i * 4 + 3);
          }
      const body = {
        bounds: { x: 0, y: 0, w, h },
        data: new Uint8Array(w * h).fill(1),
      };
      const mask = { bounds: body.bounds, data: selected };
      const classifier = new QwenRepeatedGlyphs(
        source,
        { width: w, height: h },
        { imageWidth: w, imageHeight: h, detections: [] },
      );
      selected[at(22, 22)] = 1;
      expect(
        classifier.balloonEllipsis(mask, body.bounds, body),
      ).toBeUndefined();
      selected[at(71, 22)] = 1;
      const dots = classifier.balloonEllipsis(mask, body.bounds, body);
      expect(dots?.data.reduce((a, b) => a + b, 0)).toBe(54);
      const block = { ...makeBlock(), sourceText: "……" };
      const detect = (registered?: QwenRepeatedGlyphs, effect = false) => {
        const plan = resolvePatternFluxCompositePlan({
          bitmap: source,
          width: w,
          height: h,
          page: { ...makePage(), width: w, height: h, blocks: [block] },
          block,
          regionMask: mask,
          sourceRect: body.bounds,
          fallbackConstraint: body,
          conditionOnTypography: true,
          repeatedGlyphs: registered,
          segmentation: {
            imageWidth: w,
            imageHeight: h,
            detections: [
              {
                label: effect ? "onomatopoeia" : "text",
                labelId: effect ? 1 : 0,
                score: 0.99,
                box: [0, 0, w, h],
                mask: {
                  width: w,
                  height: h,
                  logits: Float32Array.from(selected, (v) => (v ? 10 : -10)),
                },
              },
            ],
          },
        });
        return expandWindowMaskToPage(plan.modelMask, w, h)[at(42, 22)];
      };
      expect(detect(classifier)).toBe(1);
      expect(detect()).toBe(0);
      expect(detect(classifier, true)).toBe(0);
      body.data[at(42, 22)] = 0;
      expect(
        classifier.balloonEllipsis(mask, body.bounds, body),
      ).toBeUndefined();
    },
  );
  it.each([true, false])(
    "registers a three-dot ellipsis aligned between two kana strokes (vertical %s)",
    (vertical) => {
      const size = 64;
      const bitmap = Buffer.alloc(size * size * 4, 255);
      const owned = new Uint8Array(size * size);
      const at = (x: number, y: number) =>
        vertical ? y * size + x : x * size + y;
      const ink = (
        x: number,
        y: number,
        w: number,
        h: number,
        select: boolean,
      ) => {
        for (let u = x; u < x + w; u++)
          for (let v = y; v < y + h; v++) {
            const i = at(u, v);
            bitmap.fill(24, 4 * i, 4 * i + 3);
            owned[i] = Number(select);
          }
      };
      const bounds = { x: 0, y: 0, w: size, h: size };
      const classifier = new QwenRepeatedGlyphs(
        bitmap,
        { width: size, height: size },
        { imageWidth: size, imageHeight: size, detections: [] },
      );
      const find = () =>
        classifier.balloonEllipsis({ bounds, data: owned }, bounds, {
          bounds,
          data: new Uint8Array(size * size).fill(1),
        });
      ink(5, 8, 8, 14, true);
      ink(17, 10, 5, 8, false);
      for (let i = 0; i < 3; i++) ink(12, 29 + 8 * i, 3, 3, i !== 1);
      expect(find()).toBeUndefined();
      ink(17, 10, 5, 8, true);
      expect(find()?.data[at(13, 38)]).toBe(1);
      ink(12, 45, 3, 3, false);
      expect(find()).toBeUndefined();
    },
  );
  it("keeps the page border out of a two-digit folio mask", () => {
    const w = 130,
      h = 160,
      source = Buffer.alloc(w * h * 4, 255);
    const pen = (x: number, y: number) =>
      source.fill(25, 4 * (y * w + x), 4 * (y * w + x) + 3);
    for (let y = 0; y < h; y++) pen(22, y);
    for (const left of [7, 14])
      for (let y = 134; y < 143; y++)
        for (let x = left; x < left + 5; x++)
          if (x === left || x === left + 4 || y % 4 === 0) pen(x, y);
    const box = { x: 5, y: 132, w: 18, h: 13 },
      size = { width: w, height: h };
    const folio = recoverQwenFolio(source, size, box, "２６");
    expect(folio).toBeDefined();
    const pixel = (x: number, y: number) =>
      folio?.data[(y - folio.bounds.y) * folio.bounds.w + x - folio.bounds.x];
    expect(pixel(7, 137)).toBe(1);
    expect(pixel(22, 137)).toBe(0);
    expect(recoverQwenFolio(source, size, box, "8")).toBeUndefined();
    expect(recoverQwenFolio(source, size, box, "!?")).toBeUndefined();
  });
  it("keeps decoder drift off nearby artwork when restoring a textured crop", () => {
    const width = 40,
      height = 24,
      center = 12 * width + 20;
    const source = Buffer.alloc(width * height * 4, 93);
    const prediction = Buffer.alloc(source.length, 201);
    const mask = new Uint8Array(width * height);
    mask[center] = 255;
    const outerDot = (center + 4 * width + 4) * 4;
    prediction.fill(105, outerDot, outerDot + 3);
    const result = compositeQwenArtwork(
      source,
      prediction,
      mask,
      width,
      height,
    );
    expect(result[center * 4]).toBe(201);
    expect(result[(center + 5) * 4]).toBe(147);
    expect(result[outerDot]).toBe(source[outerDot]);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x - 20, y - 12) < 6) continue;
        const p = 4 * (y * width + x);
        expect(result.subarray(p, p + 4)).toEqual(source.subarray(p, p + 4));
      }
    expect(result[center * 4 + 3]).toBe(93);
    const coverage = new Float32Array(mask.length);
    coverage[center] = 0.25;
    expect(
      compositeQwenArtwork(source, prediction, mask, width, height, coverage)[
        center * 4
      ],
    ).toBe(120);
  });
  it("clears a single printed mark only when Qwen reconstructed its interior as paper", () => {
    const width = 86,
      height = 76;
    const source = Buffer.alloc(width * height * 4, 255);
    const prediction = Buffer.from(source),
      mask = new Uint8Array(width * height);
    for (let y = 28; y < 43; y++)
      for (let x = 37; x < 52; x++) {
        const i = y * width + x;
        mask[i] = 255;
        source.fill(33, i * 4, i * 4 + 3);
        prediction.fill(245, i * 4, i * 4 + 3);
      }
    const result = refineQwenPrintedContours(
      source,
      mask,
      prediction,
      width,
      height,
    );
    expect(result?.[4 * (34 * width + 43)]).toBe(255);
    for (let i = 0; i < mask.length; i++)
      if (mask[i]) prediction.fill(174, i * 4, i * 4 + 3);
    expect(
      refineQwenPrintedContours(source, mask, prediction, width, height),
    ).toBeUndefined();
  });

  it.each(["gray", "textured"])(
    "retains a %s original substrate when Qwen proposes white paper",
    (kind) => {
      const width = 56,
        height = 50,
        source = Buffer.alloc(width * height * 4, 255),
        mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const letter = x >= 22 && x < 30 && y >= 20 && y < 33;
          const gray = kind === "gray" ? 231 : (x + y) % 3 === 0 ? 221 : 255;
          source.fill(letter ? 30 : gray, i * 4, i * 4 + 3);
          mask[i] = Number(letter);
        }
      expect(
        refineQwenPrintedContours(
          source,
          mask,
          Buffer.alloc(source.length, 255),
          width,
          height,
        ),
      ).toBeUndefined();
    },
  );
  it("removes a decoded shadow inside printed strokes on independently verified paper", () => {
    const w = 98,
      h = 70,
      source = Buffer.alloc(w * h * 4, 255),
      estimate = Buffer.from(source);
    const mask = new Uint8Array(w * h);
    for (const x of [34, 52])
      for (let u = x; u < x + 7; u++)
        for (let y = 23; y < 42; y++) {
          const i = w * y + u;
          source.fill(19, 4 * i, 4 * i + 3);
          estimate.fill(173, 4 * i, 4 * i + 3);
          mask[i] = 255;
        }
    const result = refineQwenPrintedContours(source, mask, estimate, w, h);
    expect(result?.[4 * (w * 31 + 54)]).toBe(255);
    // The unselected end of a frame enters the far reference ring.
    for (let y = 35; y < 65; y++)
      for (let x = 68; x < 71; x++) {
        const p = 4 * (y * w + x);
        source.fill(67, p, p + 3);
        estimate.fill(70, p, p + 3);
      }
    const besideFrame = refineQwenPrintedContours(source, mask, estimate, w, h);
    expect(besideFrame?.[4 * (w * 31 + 54)]).toBe(255);
    expect(besideFrame?.[4 * (w * 41 + 69)]).toBe(67);
    expect(
      refineQwenPrintedContours(
        source,
        mask,
        Buffer.alloc(estimate.length, 173),
        w,
        h,
      ),
    ).toBeUndefined();
  });
  it("keeps a partially selected balloon enclosing separate printed marks", () => {
    const width = 118,
      height = 96;
    const source = Buffer.alloc(4 * width * height, 255);
    const prediction = Buffer.from(source);
    const mask = new Uint8Array(width * height);
    const ink = (x: number, y: number, selected: boolean, output: number) => {
      const i = y * width + x;
      source.fill(31, 4 * i, 4 * i + 3);
      prediction.fill(output, 4 * i, 4 * i + 3);
      if (selected) mask[i] = 255;
    };
    for (let x = 22; x <= 93; x++) {
      ink(x, 18, x >= 41 && x <= 71, 31);
      ink(x, 76, false, 31);
    }
    for (let y = 19; y < 76; y++) {
      ink(22, y, false, 31);
      ink(93, y, false, 31);
    }
    for (const start of [43, 63])
      for (let x = start; x < start + 8; x++)
        for (let y = 36; y < 54; y++) ink(x, y, true, 242);
    const result = refineQwenPrintedContours(
      source,
      mask,
      prediction,
      width,
      height,
    );
    expect(result?.[4 * (44 * width + 46)]).toBe(255);
    expect(result?.[4 * (18 * width + 53)]).toBe(31);
  });
  it("clears a detached pale compression shoulder without shortening a light pen stroke", () => {
    const w = 90,
      h = 64,
      source = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    const draw = (x: number, y: number, value: number) =>
      source.fill(value, 4 * (y * w + x), 4 * (y * w + x) + 3);
    for (let y = 24; y < 41; y++)
      for (let x = 38; x < 44; x++) {
        draw(x, y, 30);
        mask[y * w + x] = 1;
      }
    draw(48, 30, 235);
    // The non-collinear alternating pixels are JPEG residue. A straight
    // diagonal at the same contrast and distance is a separate pen stroke.
    for (const [x, y] of [
      [32, 24],
      [34, 24],
      [33, 25],
    ])
      draw(x, y, 220);
    for (const [x, y] of [
      [47, 36],
      [48, 37],
      [49, 38],
    ])
      draw(x, y, 220);
    for (let x = 12; x < 50; x++) draw(x, 19, 233);
    const clean = Buffer.from(source);
    mask.forEach((on, i) => {
      if (on) clean.fill(255, 4 * i, 4 * i + 3);
    });
    clearQwenPaperRinging(source, clean, mask, w, h);
    expect(clean[4 * (30 * w + 48)]).toBe(255);
    expect(clean[4 * (25 * w + 33)]).toBe(255);
    expect(clean[4 * (37 * w + 48)]).toBe(220);
    expect(clean[4 * (19 * w + 40)]).toBe(233);
    expect(source[4 * (30 * w + 48)]).toBe(235);
  });
  it("separates a glyph's compression fringe from a neighboring connected pen line", () => {
    const w = 85,
      h = 64,
      source = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    const paint = (x: number, y: number, color: number) =>
      source.fill(color, 4 * (y * w + x), 4 * (y * w + x) + 3);
    for (let y = 18; y <= 46; y++) {
      for (let x = 31; x <= 39; x++) {
        paint(x, y, 28);
        mask[y * w + x] = 1;
      }
      paint(44, y, 245);
    }
    for (let x = 45; x < 68; x++) paint(x, 33, 253);
    for (let y = 19; y < 53; y++) paint(68, y, 63);
    const output = Buffer.from(source);
    mask.forEach((on, i) => {
      if (on) output.fill(255, i * 4, i * 4 + 3);
    });
    clearQwenPaperRinging(source, output, mask, w, h);
    expect(output[4 * (30 * w + 44)]).toBe(255);
    expect(output[4 * (33 * w + 46)]).toBe(253);
    expect(output[4 * (33 * w + 68)]).toBe(63);
  });
  it("uses native pen samples across a lettering knockout and keeps a nearby off-axis mark", () => {
    const w = 116,
      h = 72;
    const src = Buffer.alloc(w * h * 4, 255),
      estimate = Buffer.alloc(src.length, 253);
    const mask = new Uint8Array(w * h);
    const put = (x: number, y: number, value: number, owned = false) => {
      const i = y * w + x;
      src.fill(value, i * 4, i * 4 + 3);
      if (owned) mask[i] = 255;
    };
    for (let x = 3; x < w - 3; x++) if (x < 40 || x > 49) put(x, 28, 53);
    for (const x of [39, 56])
      for (let y = 31; y < 41; y++)
        for (let u = x; u < x + 8; u++) put(u, y, 38, true);
    for (const x of [72, 77, 82])
      for (let u = x; u < x + 2; u++) put(u, 39, 63, x !== 82);
    put(82, 32, 63);
    put(83, 32, 63);
    const out = refineQwenPrintedContours(src, mask, estimate, w, h);
    expect(out).toBeDefined();
    expect(out?.[(39 * w + 82) * 4]).toBeGreaterThan(249);
    expect(out?.[(32 * w + 82) * 4]).toBe(63);
    expect(out?.[(28 * w + 44) * 4]).toBeLessThan(100);
    expect(out?.[(28 * w + 22) * 4]).toBe(53);
    expect(out?.[(36 * w + 56) * 4]).toBeGreaterThan(249);
    expect(
      refineQwenPrintedContours(src, mask, Buffer.alloc(src.length, 120), w, h),
    ).toBeUndefined();
    const textured = Buffer.from(src);
    for (let i = 0; i < mask.length; i++)
      if (!mask[i] && i % 3 === 0) textured.fill(171, i * 4, i * 4 + 3);
    expect(
      refineQwenPrintedContours(textured, mask, estimate, w, h),
    ).toBeUndefined();
    expect(
      refineQwenPrintedContours(src, new Uint8Array(w * h), estimate, w, h),
    ).toBeUndefined();
  });
  it("keeps an adjacent pen stroke when the original type has a measured white outline", () => {
    const width = 132,
      height = 90;
    const source = Buffer.alloc(width * height * 4, 255);
    const mask = new Uint8Array(width * height);
    const paint = (x: number, y: number, value: number) =>
      source.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) paint(x, y, x === 26 ? 28 : 172);
    const plain = Buffer.from(source);
    function paintLetter(x: number, y: number) {
      for (let v = y - 3; v < y + 13; v++)
        for (let u = x - 3; u < x + 9; u++) {
          const ink = u >= x && u < x + 6 && v >= y && v < y + 10;
          paint(u, v, ink ? 12 : 255);
          mask[v * width + u] = 1;
          if (ink) plain.fill(12, (v * width + u) * 4, (v * width + u) * 4 + 3);
        }
    }
    for (const x of [34, 56, 78, 100])
      for (const y of [22, 51]) paintLetter(x, y);
    const weights = qwenTextArtworkWeights(source, mask, width, height);
    expect(weights?.[25 * width + 35]).toBe(1);
    expect(weights?.[25 * width + 26]).toBe(0);
    expect(qwenTextArtworkWeights(plain, mask, width, height)).toBeUndefined();
    const inputs = { original: source, stencil: mask, width, height };
    expect(qwenCropCompositeWeights(inputs, true)).toEqual(weights);
    const artwork = qwenCropCompositeWeights(inputs, false, {
      sourceReference: true,
    });
    expect(artwork).toEqual(Float32Array.from(mask));
    expect(qwenCropCompositeWeights(inputs, false)).toBeUndefined();
  });

  it("uses the closed paper field to recover small ruby while protecting the frame and nearby drawing", () => {
    const w = 116,
      h = 96,
      input = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    function paint(x: number, y: number, value: number, selected = false) {
      const i = y * w + x;
      input.fill(value, 4 * i, 4 * i + 3);
      if (selected) mask[i] = 255;
    }
    for (let x = 12; x < 106; x++) {
      paint(x, 8, 25);
      paint(x, 85, 25);
    }
    for (let y = 8; y <= 85; y++) {
      paint(12, y, 25);
      paint(105, y, 25);
    }
    for (let y = 47; y < 62; y++) paint(24, y, 151);
    const clean = Buffer.from(input);
    for (const y of [26, 43, 60]) {
      for (let v = y; v < y + 8; v++)
        for (let x = 52; x < 61; x++) paint(x, v, 17, x <= 57);
    }
    for (let y = 43; y < 47; y++)
      for (let x = 62; x < 65; x++) paint(x, y, 62, true);
    for (let y = 48; y < 51; y++) for (let x = 62; x < 65; x++) paint(x, y, 76);
    expect(restoreEnclosedQwenPaper(input, mask, w, h)).toEqual(clean);
    // The two ends of an open border cannot prove where the balloon stops.
    for (let y = 20; y < 64; y++) paint(12, y, 255);
    expect(restoreEnclosedQwenPaper(input, mask, w, h)).toBeUndefined();
  });

  it("recognizes a lone exclamation on enclosed white stock without a speech label", () => {
    const w = 138,
      h = 130;
    const source = Buffer.alloc(w * h * 4, 255);
    const mask = new Uint8Array(w * h);
    const ink = (x: number, y: number, value: number) =>
      source.fill(value, 4 * (y * w + x), 4 * (y * w + x) + 3);
    for (let x = 10; x < 128; x++) {
      ink(x, 8, 31);
      ink(x, 122, 31);
    }
    for (let y = 8; y <= 122; y++) {
      ink(10, y, 31);
      ink(127, y, 31);
    }
    const clean = Buffer.from(source);
    for (let y = 49; y < 71; y++) {
      const left = 65 - Math.floor((y - 49) / 6);
      for (let x = left; x < left + 6; x++) {
        ink(x, y, 15);
        mask[y * w + x] = 255;
      }
    }
    for (let y = 74; y < 80; y++)
      for (let x = 60; x < 66; x++) {
        ink(x, y, 15);
        mask[y * w + x] = 255;
      }
    expect(restoreEnclosedQwenPunctuation(source, mask, w, h)).toEqual(clean);
    mask.fill(0, 58 * w, 59 * w);
    expect(restoreEnclosedQwenPunctuation(source, mask, w, h)).toEqual(clean);
    for (let y = 35; y < 97; y++) ink(10, y, 255);
    expect(restoreEnclosedQwenPunctuation(source, mask, w, h)).toBeUndefined();
    for (let y = 35; y < 97; y++) ink(10, y, 31);
    for (let y = 74; y < 80; y++) mask.fill(0, y * w + 60, y * w + 66);
    expect(restoreEnclosedQwenPunctuation(source, mask, w, h)).toBeUndefined();
  });

  it.each(["exclamation", "ellipsis"] as const)(
    "recovers a small blurred %s from off-centre samples only on enclosed paper",
    (shape) => {
      const w = 88,
        h = 91,
        mask = new Uint8Array(w * h);
      const source = Buffer.alloc(w * h * 4, 255);
      const ink = (x: number, y: number, value: number) =>
        source.fill(value, 4 * (y * w + x), 4 * (y * w + x) + 3);
      for (let x = 17; x < 71; x++) {
        ink(x, 9, 28);
        ink(x, 81, 28);
      }
      for (let y = 9; y <= 81; y++) {
        ink(17, y, 28);
        ink(70, y, 28);
      }
      ink(51, 42, 120);
      const clean = Buffer.from(source);
      const glyph = (top: number, height: number) => {
        for (let y = top - 1; y <= top + height; y++)
          for (let x = 37; x <= 42; x++) {
            const edge = x === 37 || x === 42 || y < top || y >= top + height;
            ink(x, y, edge ? 235 : 104);
            if (x === 41 && !edge) mask[y * w + x] = 1;
          }
      };
      if (shape === "exclamation") {
        glyph(32, 10);
        glyph(45, 4);
      } else for (let i = 0; i < 6; i++) glyph(20 + 8 * i, 4);
      expect(restoreQwenPaper(source, mask, w, h, false)).toEqual(clean);
      for (let y = 18; y < 70; y++) ink(17, y, 255);
      expect(
        restoreEnclosedQwenPunctuation(source, mask, w, h),
      ).toBeUndefined();
    },
  );

  it.each([
    [130, 770],
    [932, 131],
    [128, 128],
    [12, 1400],
    [2304, 1710],
  ])("rounds the two references together for a %i by %i crop", (w, h) => {
    const size = qwenReferenceSize(w, h, 736 ** 2);
    expect(size.width % 32).toBe(0);
    expect(size.height % 32).toBe(0);
    expect(size.width * size.height).toBeLessThanOrEqual(736 ** 2);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(32);
  });
  it("installs the GGUF executable and CUDA runtime in the same dedicated directory", () => {
    const plan = nativeInferencePlan({
      engine: "qwen-image",
      backend: "cuda",
      platform: "win32",
      arch: "x64",
    });
    expect(plan.executable).toBe("sd-cli.exe");
    expect(plan.packages.map((p) => p.id)).toEqual([
      "msvc-win32",
      "qwen-image-sdcpp-win32-cuda",
      "qwen-image-cuda12-runtime",
    ]);
    expect(plan.libraries).toContain("cublasLt64_12.dll");
    expect(() =>
      nativeInferencePlan({
        engine: "qwen-image",
        backend: "cpu",
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow();
  });
  it("recognizes two columns on verified white paper when the enclosing balloon is clipped", () => {
    const w = 140,
      h = 136,
      pixels = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    function glyph(x: number, y: number) {
      for (let v = 0; v < 17; v++)
        for (let u = 0; u < 14; u++) {
          if (u >= 3 && v !== 7) continue;
          const i = (y + v) * w + x + u;
          pixels.fill(23, 4 * i, 4 * i + 3);
          mask[i] = 1;
        }
    }
    for (const x of [31, 71]) for (const y of [19, 52, 85]) glyph(x, y);
    expect(
      restoreQwenPaper(pixels, mask, w, h, false)?.[4 * (52 * w + 31)],
    ).toBe(255);
    const one = mask.map((on, i) => (i % w < 60 ? on : 0));
    expect(restoreQwenPaper(pixels, one, w, h, false)).toBeUndefined();
    for (let x = 5; x < 32; x++)
      pixels.fill(23, 4 * (59 * w + x), 4 * (59 * w + x) + 3);
    expect(restoreQwenPaper(pixels, mask, w, h, false)).toBeUndefined();
  });

  it.each([false, true])(
    "samples original stock behind a regularly spaced pause (vertical %s)",
    (vertical) => {
      const w = 230,
        h = 230;
      const pixels = Buffer.alloc(w * h * 4, 255);
      const mask = new Uint8Array(w * h);
      const index = (along: number, across: number) =>
        vertical ? along * w + across : across * w + along;
      for (let y = 78; y < 108; y++)
        for (let x = 18; x < 217; x++) mask[index(x, y)] = 1;
      for (let i = 0; i < 6; i++)
        for (let y = 0; y < 5; y++)
          for (let x = 0; x < 5; x++) {
            if (Math.hypot(x - 2, y - 2) > 2.3) continue;
            const pixel = index(22 + 37 * i + x, 94 - Math.floor(i / 2) + y);
            pixels.fill(23, 4 * pixel, 4 * pixel + 3);
          }
      const result = restoreQwenPaper(pixels, mask, w, h, false);
      expect(result?.every((v) => v === 255)).toBe(true);
      const broken = Buffer.from(pixels);
      const extraDot = index(83, 96);
      broken.fill(40, 4 * extraDot, 4 * extraDot + 3);
      expect(restoreQwenPaper(broken, mask, w, h, false)).toBeUndefined();
    },
  );

  it("recovers the paper behind a single sloping column with four separate handwritten letters", () => {
    const w = 90,
      h = 120,
      pixels = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    for (let j = 0; j < 4; j++) {
      const x = 31 + j,
        y = 18 + 20 * j;
      for (let v = 0; v < 14; v++)
        for (let u = 0; u < 11; u++) {
          if (u > 2 && v !== 7) continue;
          const i = (y + v) * w + x + u;
          pixels.fill(19, 4 * i, 4 * i + 3);
          mask[i] = 1;
        }
    }
    expect(
      restoreQwenPaper(pixels, mask, w, h, false)?.[4 * (38 * w + 32)],
    ).toBe(255);
    for (let x = 1; x < 33; x++)
      pixels.fill(19, 4 * (45 * w + x), 4 * (45 * w + x) + 3);
    expect(restoreQwenPaper(pixels, mask, w, h, false)).toBeUndefined();
  });

  it("preserves a nearby border and declines to paint a stroke connected to the drawing", () => {
    const w = 128,
      h = 100,
      pixels = Buffer.alloc(w * h * 4, 255),
      mask = new Uint8Array(w * h);
    function ink(x: number, y: number) {
      pixels.fill(28, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
    for (let y = 0; y < h; y++) ink(8, y);
    for (const x of [33, 55, 77]) {
      for (let y = 35; y < 57; y++)
        for (let u = x; u < x + 8; u++) if (u < x + 3 || y === 46) ink(u, y);
      for (let y = 31; y < 62; y++)
        for (let u = x - 3; u < x + 12; u++) mask[y * w + u] = 1;
    }
    const clean = restoreQwenPaper(pixels, mask, w, h);
    expect(clean).toBeDefined();
    expect(clean?.[(46 * w + 55) * 4]).toBe(255);
    expect(clean?.[(46 * w + 8) * 4]).toBe(28);
    expect(pixels[(46 * w + 55) * 4]).toBe(28);
    const tight = mask.map((on, i) =>
      Number(Boolean(on) && pixels[i * 4] === 28),
    );
    expect(restoreQwenPaper(pixels, tight, w, h)).toEqual(clean);
    const ringing = Buffer.from(pixels);
    for (let x = 41; x <= 48; x++) {
      const p = 4 * (46 * w + x);
      ringing.fill(244, p, p + 3);
    }
    expect(restoreQwenPaper(ringing, tight, w, h)?.[4 * (46 * w + 47)]).toBe(
      255,
    );
    for (let x = 8; x <= 33; x++) ink(x, 46);
    expect(restoreQwenPaper(pixels, mask, w, h)).toBeUndefined();
    expect(restoreQwenPaper(pixels, tight, w, h)).toBeUndefined();
  });
});
