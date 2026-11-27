import { groupIllustratedTitleLines } from "../src/main/inpainting/qwenIllustratedTitleGroups";
import { describe, expect, it } from "vitest";
import {
  contextualTextTargets,
  refineContextualText,
} from "../src/main/inpainting/qwenContextualTypography";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import type { InpaintingWindowMask } from "../src/main/inpainting/inpaintingEngine";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { createEmptyPatternMaskContext } from "../src/main/inpainting/patternMaskContext";
import { measureCreatorCaptions } from "../src/main/inpainting/qwenPrintGlow";
import {
  coalesceSharedConstrainedWindows,
  prepareGroupedRegionWindows,
} from "../src/main/inpainting/patternSharedWindows";
import { runPatternInpaintingEngine } from "../src/main/inpainting/patternEngineRunner";
import {
  isIllustratedTitleGroup,
  selectedPrintGroups,
} from "../src/main/inpainting/qwenIllustratedPlate";
import { measureLayeredTitle } from "../src/main/inpainting/qwenCaptionEnvelope";
import { protectUnselectedFluxPlan } from "../src/main/inpainting/patternBlockEligibility";
import { normalizeBboxTo1000 } from "../src/shared/bboxNormalization";

it("pastes a measured colour glow beyond the letter core while reserving adjacent unselected art", () => {
  const width = 260,
    height = 180;
  const rect = { x: 65, y: 78, w: 102, h: 17 };
  const mask = { bounds: rect, data: new Uint8Array(rect.w * rect.h).fill(1) };
  const blocks = [rect, { x: 49, y: 65, w: 12, h: 39 }].map((b, i) => ({
    ...makeBlock(),
    id: String(i),
    bbox: normalizeBboxTo1000(b, { width, height }, "pixels"),
  }));
  const page = { ...makePage(), width, height, blocks };
  const ctx = createEmptyPatternMaskContext(width, height);
  ctx.validationBlockIds.push("0");
  ctx.inpaintWindows.push({ x: 0, y: 0, w: width, h: height });
  ctx.inpaintWindowMasks.push(mask);
  ctx.inpaintCompositeMasks.push(mask);
  ctx.inpaintWindowConstraints.push(mask);
  ctx.inpaintWindowGroupIds.push(
    selectedPrintGroups(
      "0",
      {
        colouredCaption: "作者",
        speechBubble: false,
      },
      [],
    ),
  );
  ctx.inpaintSpeechBubbleWindows.push(false);
  ctx.inpaintCompositeFeatherPx.push(0);
  prepareGroupedRegionWindows(ctx, {
    bitmap: Buffer.alloc(4 * width * height, 255),
    page,
    width,
    blockIds: ["0"],
    mode: "flux-region",
    conditionOnTypography: true,
  });
  const read = (m: InpaintingWindowMask) =>
    expandWindowMaskToPage(m, width, height);
  const mid = 84 * width;
  expect(read(ctx.inpaintWindowMasks[0])[mid + 185]).toBe(0);
  const constraint = ctx.inpaintWindowConstraints[0];
  expect.assert(constraint);
  for (const m of [ctx.inpaintCompositeMasks[0], constraint]) {
    const coverage = read(m);
    expect(coverage[mid + 185]).toBe(1);
    expect(coverage[mid + 55]).toBe(0);
    expect(coverage[mid + 232]).toBe(0);
  }
});

it("follows a colour-changing title stroke to its luminous tip across dark artwork", () => {
  const width = 680,
    height = 190;
  const bitmap = Buffer.alloc(4 * width * height, 52);
  const paint = (
    x: number,
    y: number,
    w: number,
    h: number,
    colour: number[],
  ) => {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++)
        bitmap.set(colour, 4 * (row * width + col));
  };
  const paper = [255, 255, 255, 255];
  const navy = [120, 38, 21, 255];
  const gold = [24, 138, 232, 255];
  for (const x of [108, 245, 400, 556]) {
    paint(x - 10, 55, 32, 75, paper);
    paint(x, 64, 9, 55, navy);
  }
  paint(115, 87, 91, 23, paper);
  paint(115, 94, 83, 6, gold);
  paint(230, 144, 65, 5, gold);
  const mask = measureLayeredTitle(
    bitmap,
    { width, height },
    { x: 28, y: 29, w: 618, h: 126 },
  );
  expect.assert(mask);
  const on = expandWindowMaskToPage(mask, width, height);
  expect(on[97 * width + 190]).toBe(1);
  expect(on[146 * width + 287]).toBe(0);
  const rect = { x: 28, y: 29, w: 618, h: 126 };
  const block = {
    ...makeBlock(),
    sourceText: "金色の長い物語",
    bbox: normalizeBboxTo1000(rect, { width, height }, "pixels"),
  };
  const page = { ...makePage(), width, height, blocks: [block] };
  const plan = resolvePatternFluxCompositePlan({
    width,
    height,
    page,
    block,
    bitmap,
    sourceRect: rect,
    regionMask: { bounds: rect, data: new Uint8Array(rect.w * rect.h).fill(1) },
    fallbackConstraint: null,
    conditionOnTypography: true,
    segmentation: { imageWidth: width, imageHeight: height, detections: [] },
  });
  expect(plan.modelMask.bounds).toEqual(mask.bounds);
  expect(plan.featherPx).toBe(9);
  expect(isIllustratedTitleGroup(selectedPrintGroups(block.id, plan, []))).toBe(
    "isolated-title-stock",
  );
  const individual = expandWindowMaskToPage(plan.modelMask, width, height);
  expect(individual[97 * width + 190]).toBe(1);
  expect(individual[146 * width + 287]).toBe(0);
});

it.each(["credit", ""])(
  "holds original peer ink above a title when the unselected credit is %j",
  (sourceText) => {
    const width = 150,
      height = 95,
      bounds = { x: 5, y: 15, w: 138, h: 67 };
    const block = {
      ...makeBlock(),
      id: "unselected",
      bbox: normalizeBboxTo1000(
        { x: 24, y: 31, w: 102, h: 28 },
        { width, height },
        "pixels",
      ),
      sourceText,
    };
    const page = { ...makePage(), width, height, blocks: [block] };
    const bitmap = Buffer.alloc(4 * width * height, 255);
    for (const left of [30, 54, 85, 108])
      for (let y = 35; y < 55; y++)
        for (let x = left; x < left + 7; x++)
          bitmap.fill(24, 4 * (y * width + x), 4 * (y * width + x) + 3);
    const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
    const plan = {
      modelMask: mask,
      compositeMask: mask,
      constraint: mask,
      featherPx: 0,
    };
    protectUnselectedFluxPlan(
      plan,
      { page, conditionOnTypography: true, blockIds: ["selected"] },
      bitmap,
    );
    const at = (value: typeof mask, x: number, y: number) =>
      value.data[(y - bounds.y) * bounds.w + x - bounds.x];
    expect(at(plan.modelMask, 73, 43)).toBe(0);
    expect(at(plan.compositeMask, 33, 43)).toBe(0);
    expect(at(plan.constraint, 73, 43)).toBe(sourceText ? 1 : 0);
    expect(at(plan.compositeMask, 18, 40)).toBe(1);
    expect(at(mask, 33, 43)).toBe(1);
  },
);

it.each([0, 45])(
  "keeps a translated cover title in one edit only when its two native rows touch (%i)",
  (gap) => {
    const width = 380,
      height = 580;
    const lines = [
      ["秋の刊行", 20, 8, 150, 25],
      ["物語", 30, 39, 145, 30],
      ["Over The Mountain", 87, 290, 215, 24],
      ["花と青空", 30, 326, 325, 45],
      ["山の向こう", 34, 383 + gap, 315, 48],
    ] as const;
    const boxes = lines.map(([, x, y, w, h]) => ({ x, y, w, h }));
    const page = {
      ...makePage(),
      width,
      height,
      blocks: lines.map(([sourceText], i) => ({
        ...makeBlock(),
        id: String(i),
        sourceText,
        bbox: normalizeBboxTo1000(boxes[i], { width, height }, "pixels"),
      })),
    };
    const ctx = createEmptyPatternMaskContext(width, height);
    const bitmap = Buffer.alloc(4 * width * height, 255);
    for (const [i, block] of page.blocks.entries()) {
      const b = boxes[i],
        mask = { bounds: b, data: new Uint8Array(b.w * b.h) };
      mask.data[Math.floor(b.h / 2) * b.w + 9] = 1;
      ctx.validationBlockIds.push(block.id);
      ctx.inpaintWindows.push(b);
      ctx.inpaintWindowMasks.push(mask);
      ctx.inpaintCompositeMasks.push(mask);
      ctx.inpaintWindowConstraints.push(null);
      ctx.inpaintWindowGroupIds.push(i < 2 ? ["qwen-pigment:" + i] : []);
      ctx.inpaintSpeechBubbleWindows.push(false);
      ctx.inpaintCompositeFeatherPx.push(1);
      if (i < 2) continue;
      for (let x = b.x + 8; x < b.x + b.w - 8; x += 26) {
        for (let y = b.y + 5; y < b.y + b.h - 5; y++)
          for (let k = 0; k < 5; k++)
            bitmap.set([119, 36, 20, 255], 4 * (y * width + x + k));
      }
    }
    const measure = measureLayeredTitle(bitmap, page, boxes[3]);
    expect.assert(measure);
    expect(
      expandWindowMaskToPage(measure, width, height)[345 * width + 39],
    ).toBe(1);
    expect(
      measureLayeredTitle(Buffer.alloc(bitmap.length, 180), page, boxes[3]),
    ).toBeUndefined();
    expect(
      measureLayeredTitle(
        bitmap,
        { width: 2000, height: 1500 },
        { x: 0, y: 0, w: 1800, h: 1200 },
      ),
    ).toBeUndefined();
    prepareGroupedRegionWindows(ctx, {
      page,
      width,
      bitmap,
      mode: "flux-region",
      conditionOnTypography: true,
    });
    const hints = ctx.inpaintWindowGroupIds.map(isIllustratedTitleGroup);
    if (gap)
      expect(hints).not.toContain(
        "layered-title:Over The Mountain」「花と青空」「山の向こう",
      );
    else {
      expect(hints).toContain(
        "layered-title:Over The Mountain」「花と青空」「山の向こう",
      );
      expect(ctx.inpaintWindowMasks).toHaveLength(3);
    }
  },
);

it("groups selected masthead text and a separate cover credit without losing later block ownership", async () => {
  const lines = [
    ["上の宣伝文", 25, 8, 175, 25],
    ["月刊あお", 0, 15, 700, 135],
    ["Blue Comic", 12, 105, 91, 28],
    ["その先へ", 405, 15, 96, 20],
    ["五人の旅人", 12, 705, 380, 175],
    ["高田 原作：村上", 9, 862, 410, 55],
    ["11 2027 NOV", 603, 195, 82, 105],
  ] as const;
  const page = {
    ...makePage(),
    width: 700,
    height: 980,
    blocks: lines.map(([sourceText, x, y, w, h], i) => ({
      ...makeBlock(),
      id: String(i),
      sourceText,
      bbox: { x, y, w, h },
      bboxSpace: "pixels" as const,
    })),
  };
  const ctx = createEmptyPatternMaskContext(page.width, page.height);
  for (const [i, block] of page.blocks.entries()) {
    const bounds = block.bbox;
    const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
    ctx.validationBlockIds.push(block.id);
    ctx.inpaintWindows.push(bounds);
    ctx.inpaintWindowMasks.push(mask);
    ctx.inpaintCompositeMasks.push(mask);
    ctx.inpaintWindowConstraints.push(null);
    ctx.inpaintWindowGroupIds.push(i === 1 ? ["qwen-masthead:1"] : []);
    ctx.inpaintSpeechBubbleWindows.push(i === 3);
    ctx.inpaintCompositeFeatherPx.push(1);
  }
  const grouped = structuredClone(ctx);
  const bitmap = Buffer.alloc(4 * page.width * page.height, 255);
  prepareGroupedRegionWindows(grouped, {
    page,
    bitmap,
    width: page.width,
    conditionOnTypography: true,
    mode: "flux-region",
    blockIds: page.blocks.map((block) => block.id),
  });
  const sourceOrder = [...grouped.validationBlockIds];
  await runPatternInpaintingEngine({
    width: page.width,
    height: page.height,
    bitmap,
    maskContext: grouped,
    engine: {
      model: "qwen-image-2.1",
      backend: "cuda-native",
      runtimePath: "local",
      modelPath: "Q8",
      runRootDir: "crops",
      async inpaint(_bitmap, _width, _height, _mask, windows, options) {
        expect(windows).toHaveLength(4);
        expect(options?.illustratedTitleWindows?.[0]).toContain("masthead:");
        expect(options?.illustratedTitleWindows?.[2]).toContain("cover-title:");
        expect(options?.compositeConstraints?.[0]).toBeDefined();
        expect(options?.compositeFeatherPx?.[2]).toBe(0);
      },
      async dispose() {},
    },
  });
  expect(sourceOrder).toEqual(page.blocks.map((block) => block.id));
  groupIllustratedTitleLines(ctx, page);
  expect(coalesceSharedConstrainedWindows(ctx)).toEqual([0, 3, 4, 6]);
  expect(ctx.inpaintWindowGroupIds.map(isIllustratedTitleGroup)).toEqual([
    "masthead:月刊あお」「上の宣伝文」「Blue Comic",
    false,
    "cover-title:五人の旅人」「高田 原作:村上",
    false,
  ]);
  expect(ctx.validationBlockIds).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
});

it("registers a missed small byline only with two matching baselines under independently selected names", () => {
  const size = { width: 320, height: 165 },
    rect = { x: 35, y: 65, w: 240, h: 52 };
  const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
  const known = {
    bounds: { x: 0, y: 0, w: size.width, h: size.height },
    data: new Uint8Array(size.width * size.height),
  };
  for (const start of [62, 183]) {
    for (let i = 0; i < 10; i++) {
      for (let offset = 0; offset < 3 * (6 - (i % 2)); offset++) {
        const at =
          (107 + (i % 2) + Math.floor(offset / 3)) * size.width +
          start +
          6 * i +
          (offset % 3);
        bitmap.fill(25, 4 * at, 4 * at + 3);
        if (start === 62) known.data[at] = 1;
      }
    }
    known.data.fill(1, 94 * size.width + start, 94 * size.width + start + 42);
  }
  const result = measureCreatorCaptions(
    bitmap,
    size,
    rect,
    "漫画 葵 原作 山田",
    known,
  );
  if (!result)
    throw new Error("Expected the visible creator bylines to be registered");
  const full = expandWindowMaskToPage(result, size.width, size.height);
  expect(full[110 * size.width + 210]).toBe(1);
  expect(full[110 * size.width + 150]).toBe(0);
  const block = {
    ...makeBlock(),
    bboxSpace: "pixels" as const,
    bbox: rect,
    sourceText: "漫画 葵 原作 山田",
  };
  const plan = resolvePatternFluxCompositePlan({
    ...size,
    page: { ...makePage(), ...size, blocks: [block] },
    block,
    bitmap,
    sourceRect: rect,
    regionMask: known,
    fallbackConstraint: null,
    conditionOnTypography: true,
    segmentation: {
      imageWidth: size.width,
      imageHeight: size.height,
      detections: [],
      contextualText: new Map([[block.id, known]]),
    },
  });
  const mask = expandWindowMaskToPage(plan.modelMask, size.width, size.height);
  expect(mask[110 * size.width + 210]).toBe(1);
  expect(mask[110 * size.width + 150]).toBe(0);
  expect(
    measureCreatorCaptions(bitmap, size, rect, "物語", known),
  ).toBeUndefined();
  known.data.fill(0);
  expect(
    measureCreatorCaptions(bitmap, size, rect, "漫画 葵 原作 山田", known),
  ).toBeUndefined();
});

it.each([
  {
    layout: "three lines above the credit",
    boxes: [
      { x: 125, y: 35, w: 490, h: 57 },
      { x: 180, y: 600, w: 480, h: 68 },
      { x: 205, y: 679, w: 450, h: 64 },
      { x: 214, y: 757, w: 408, h: 59 },
      { x: 230, y: 830, w: 315, h: 39 },
      { x: 200, y: 560, w: 380, h: 47 },
    ],
    credit: 4,
  },
  {
    layout: "names above a full-width title and a narrow subtitle below it",
    boxes: [
      { x: 125, y: 35, w: 490, h: 57 },
      { x: 135, y: 620, w: 293, h: 47 },
      { x: 438, y: 623, w: 296, h: 42 },
      { x: 75, y: 689, w: 690, h: 191 },
      { x: 270, y: 899, w: 386, h: 27 },
      { x: 340, y: 594, w: 120, h: 50 },
    ],
    credit: 1,
  },
])(
  "groups $layout while preserving the other panel and balloon",
  ({ boxes, credit }) => {
    const page = {
      ...makePage(),
      width: 860,
      height: 1100,
      blocks: boxes.map((bbox, i) => ({
        ...makeBlock(),
        bbox,
        id: String(i),
        sourceText: i === credit ? "漫画 梨花 原作 森" : "見開き",
      })),
    };
    const context = createEmptyPatternMaskContext(page.width, page.height);
    for (const [i, bounds] of boxes.entries()) {
      const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h) };
      mask.data[19] = 1;
      context.validationBlockIds.push(String(i));
      context.inpaintWindows.push(bounds);
      context.inpaintWindowMasks.push(mask);
      context.inpaintCompositeMasks.push(mask);
      context.inpaintWindowConstraints.push(null);
      context.inpaintWindowGroupIds.push([]);
      context.inpaintSpeechBubbleWindows.push(i === 5);
      context.inpaintCompositeFeatherPx.push(1);
    }
    groupIllustratedTitleLines(context, page);
    coalesceSharedConstrainedWindows(context);
    expect(context.inpaintWindowGroupIds.map(isIllustratedTitleGroup)).toEqual([
      false,
      true,
      false,
    ]);
    expect(context.inpaintSpeechBubbleWindows).toEqual([false, false, true]);
    expect(context.inpaintCompositeMasks[1].data.reduce((a, b) => a + b)).toBe(
      4,
    );
    expect(context.validationBlockIds).toEqual(["0", "1", "2", "3", "4", "5"]);
  },
);

describe("small creator credits without a full-page text instance", () => {
  it("refines an undetected chapter caption with a title while keeping a standalone chapter number", () => {
    const rect = { x: 73, y: 1111, w: 188, h: 32 };
    const block = { ...makeBlock(), bboxSpace: "pixels" as const, bbox: rect };
    const page = { ...makePage(), width: 836, height: 1200 };
    const empty = { imageWidth: 836, imageHeight: 1200, detections: [] };
    const title = { ...block, sourceText: "第６話：最悪の出会い" };
    const withTitle = { ...page, blocks: [title] };
    expect(contextualTextTargets(withTitle, empty, [])).toHaveLength(1);
    expect(
      contextualTextTargets(
        { ...page, blocks: [{ ...block, sourceText: "第14話" }] },
        empty,
        [],
      ),
    ).toHaveLength(0);
    expect(
      contextualTextTargets(
        withTitle,
        {
          ...empty,
          detections: [
            {
              label: "text",
              labelId: 0,
              score: 0.9,
              box: [73, 1111, 261, 1143],
            },
          ],
        },
        [],
      ),
    ).toHaveLength(0);
  });
  it("requires independent local views of each line and retains the drawing between credits", async () => {
    const size = { width: 820, height: 1200 };
    const rect = { x: 72, y: 758, w: 165, h: 65 };
    const block = {
      ...makeBlock(),
      id: "credit",
      bboxSpace: "pixels" as const,
      bbox: rect,
      sourceText: "【原作】作者名 [作画] 画家名",
    };
    const page = { ...makePage(), ...size, blocks: [block] };
    const segmentation = {
      imageWidth: size.width,
      imageHeight: size.height,
      detections: [],
    };
    const targets = contextualTextTargets(page, segmentation, []);
    expect(targets.map((t) => t.id)).toEqual(["credit"]);
    expect(
      contextualTextTargets(
        { ...page, blocks: [{ ...block, sourceText: "本文" }] },
        segmentation,
        [],
      ),
    ).toHaveLength(0);
    let index = 0;
    const found = await refineContextualText(
      page,
      targets,
      async (view) => {
        const rows = index++ === 0 ? [770, 786] : [770, 801];
        return {
          imageWidth: view.width,
          imageHeight: view.height,
          detections: rows.map((y) => ({
            label: "text" as const,
            labelId: 0 as const,
            score: 0.56,
            box: [83 - view.x, y - view.y, 219 - view.x, y + 8 - view.y] as [
              number,
              number,
              number,
              number,
            ],
            mask: {
              width: 8,
              height: 8,
              logits: new Float32Array(64).fill(10),
            },
          })),
        };
      },
      new AbortController().signal,
    );
    const model = resolvePatternFluxCompositePlan({
      block,
      page,
      ...size,
      regionMask: {
        bounds: rect,
        data: new Uint8Array(rect.w * rect.h).fill(1),
      },
      bitmap: Buffer.alloc(size.width * size.height * 4, 238),
      conditionOnTypography: true,
      sourceRect: rect,
      fallbackConstraint: null,
      segmentation: { ...segmentation, contextualText: found },
    });
    const mask = expandWindowMaskToPage(
      model.modelMask,
      size.width,
      size.height,
    );
    expect(mask[773 * size.width + 123]).toBe(1);
    expect(mask[790 * size.width + 123]).toBe(0);
    expect(mask[804 * size.width + 123]).toBe(1);
  });
});

it("limits a selected sound absent from the full page to ink corroborated in two original crops", async () => {
  const page = makePage();
  page.width = page.height = 500;
  const selected = { x: 180, y: 140, w: 62, h: 57 };
  const block = {
    ...page.blocks[0],
    bbox: selected,
    bboxSpace: "pixels" as const,
    sourceText: "ガタ",
  };
  page.blocks = [block];
  const segmentation = { imageWidth: 500, imageHeight: 500, detections: [] };
  const targets = contextualTextTargets(page, segmentation, []);
  expect(targets).toHaveLength(1);
  const matched = {
    label: "onomatopoeia" as const,
    labelId: 1 as const,
    score: 0.91,
    box: [180, 140, 242, 197] as [number, number, number, number],
  };
  expect(
    contextualTextTargets(page, { ...segmentation, detections: [matched] }, []),
  ).toHaveLength(0);
  expect(
    contextualTextTargets(
      page,
      {
        ...segmentation,
        detections: [{ ...matched, box: [184, 145, 193, 160] }],
      },
      [],
    ),
  ).toHaveLength(1);
  expect(
    contextualTextTargets(
      { ...page, blocks: [{ ...block, sourceText: "ぐ…っ" }] },
      segmentation,
      [],
    ),
  ).toHaveLength(1);
  expect(
    contextualTextTargets(
      { ...page, blocks: [{ ...block, sourceText: "..." }] },
      segmentation,
      [],
    ),
  ).toHaveLength(0);
  for (const observations of [1, 2]) {
    let seen = 0;
    const refined = await refineContextualText(
      page,
      targets,
      async (view) => ({
        imageWidth: view.width,
        imageHeight: view.height,
        detections:
          ++seen <= observations
            ? [
                {
                  label: "onomatopoeia" as const,
                  labelId: 1 as const,
                  score: 0.99,
                  mask: {
                    logits: new Float32Array(64).fill(10),
                    width: 8,
                    height: 8,
                  },
                  box: [
                    188 - view.x,
                    150 - view.y,
                    232 - view.x,
                    186 - view.y,
                  ] as [number, number, number, number],
                },
              ]
            : [],
      }),
      new AbortController().signal,
    );
    if (observations === 1) {
      expect(refined.size).toBe(0);
      continue;
    }
    expect(refined.get(block.id)?.label).toBe("onomatopoeia");
    const plan = resolvePatternFluxCompositePlan({
      page,
      width: 500,
      height: 500,
      block,
      sourceRect: selected,
      fallbackConstraint: null,
      bitmap: Buffer.alloc(500 * 500 * 4, 255),
      conditionOnTypography: true,
      regionMask: {
        bounds: selected,
        data: new Uint8Array(selected.w * selected.h).fill(1),
      },
      segmentation: { ...segmentation, contextualText: refined },
    });
    const mask = expandWindowMaskToPage(plan.compositeMask, 500, 500);
    expect(mask[164 * 500 + 208]).toBe(1);
    expect(mask[141 * 500 + 181]).toBe(0);
  }
});
