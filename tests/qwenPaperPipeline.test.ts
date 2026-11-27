import { expect, it } from "vitest";
import {
  createEmptyPatternMaskContext,
  collectPaperGradient,
  finalizeMeasuredPaper,
  pasteMeasuredPaper,
} from "../src/main/inpainting/patternMaskContext";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import { pixelsToBbox } from "../src/shared/geometry";
import type { PixelRect } from "../src/main/inpainting/maskGeometry";
import { makePage } from "./koharuTypographyMask.fixture";

const width = 90,
  height = 80;
function input(rect: PixelRect, text: string) {
  const original = makePage(),
    size = { width, height },
    box = pixelsToBbox(rect, size.width, size.height);
  const block = {
      ...original.blocks[0],
      bbox: box,
      textRole: "ordinary" as const,
      sourceText: text,
    },
    page = { ...original, ...size, blocks: [block] };
  return {
    width,
    height,
    page,
    bitmap: Buffer.alloc(width * height * 4, 255),
    mode: "flux-region" as const,
    conditionOnTypography: true,
    blockIds: [block.id],
    typographySegmentation: {
      imageWidth: width,
      imageHeight: height,
      detections: [],
    },
  };
}

it("finishes measured gradients in the normal page mask and skips the model window", () => {
  const r = { x: 16, y: 18, w: 55, h: 43 },
    opts = input(r, "文字");
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      opts.bitmap.set(
        [252, 202 + Math.floor(y / 5), 168 + Math.floor(y / 4), 255],
        4 * (y * width + x),
      );
  const clean = Buffer.from(opts.bitmap);
  for (let y = 23; y < 51; y++)
    for (let x = 22; x < 63; x += 12)
      opts.bitmap.fill(45, 4 * (y * width + x), 4 * (y * width + x) + 3);
  const ctx = buildPatternPageMask(opts);
  expect(ctx.measuredPaper?.length).toBe(1);
  expect(ctx.blocksErased).toBe(1);
  expect(ctx.inpaintWindows).toHaveLength(0);
  pasteMeasuredPaper(ctx, opts.bitmap, width);
  expect(opts.bitmap).toEqual(clean);
});

it("keeps the paired reading on the native model route and preserves its explicit stencil", () => {
  const r = { x: 22, y: 24, w: 18, h: 26 },
    opts = input(r, "ふぁ…"),
    [block] = opts.page.blocks;
  const edge = {
    bounds: r,
    data: new Uint8Array(r.w * r.h).fill(1),
    outlinedReading: { bounds: r, data: new Uint8Array(r.w * r.h).fill(1) },
  };
  const ctx = buildPatternPageMask({
    ...opts,
    sourceEraseConstraintsByBlock: { [block.id]: edge },
  });
  expect(ctx.measuredPaper).toBeUndefined();
  expect(ctx.inpaintWindowGroupIds.flat().join(" ")).toContain(
    "balloon-edge-reading",
  );
});
it("removes a remaining colored letter only within the selected source component", () => {
  const r = { x: 36, y: 13, w: 15, h: 54 },
    opts = input(r, "手書き"),
    [block] = opts.page.blocks;
  for (let i = 0; i < width * height; i++)
    opts.bitmap.set([246, 246, 246, 255], 4 * i);
  for (const top of [16, 30, 45, 58])
    for (let y = top; y < top + 7; y++)
      for (let x = 39; x < 44; x++)
        opts.bitmap.set([62, 60, 240, 255], 4 * (y * width + x));
  const ctx = createEmptyPatternMaskContext(width, height);
  collectPaperGradient(opts, block, r, ctx);
  expect(ctx.supplementalPaper).toHaveLength(1);
  finalizeMeasuredPaper(ctx, width);
  pasteMeasuredPaper(ctx, opts.bitmap, width);
  expect(opts.bitmap[4 * (17 * width + 40)]).toBe(246);
});
it.each([false, true])(
  "retains a neighboring owner's punctuation when its centre overlaps (%s)",
  (overlap) => {
    const r = { x: 28, y: 8, w: 27, h: 60 },
      opts = input(r, "あ!"),
      [block] = opts.page.blocks;
    const peer = {
      ...block,
      id: "another",
      bbox: pixelsToBbox(
        { x: overlap ? 34 : 75, y: 55, w: 6, h: 6 },
        opts.width,
        opts.height,
      ),
    };
    const page = { ...opts.page, blocks: [block, peer] };
    for (let i = 0; i < width * height; i++)
      opts.bitmap.set([248, 248, 248, 255], 4 * i);
    for (let y = 44; y < 59; y++)
      for (let x = 34; x < 37; x++)
        if (y < 54 || y >= 56)
          opts.bitmap.fill(40, 4 * (y * width + x), 4 * (y * width + x) + 3);
    const owner = {
      bounds: { x: 0, y: 0, w: width, h: height },
      data: new Uint8Array(width * height).fill(1),
    };
    const ctx = createEmptyPatternMaskContext(width, height);
    collectPaperGradient(
      { ...opts, page, sourceEraseConstraintsByBlock: { [block.id]: owner } },
      block,
      r,
      ctx,
    );
    expect(ctx.supplementalPaper).toHaveLength(1);
    for (let y = 44; y < 54; y++)
      for (let x = 34; x < 37; x++)
        opts.bitmap.fill(248, 4 * (y * width + x), 4 * (y * width + x) + 3);
    pasteMeasuredPaper(ctx, opts.bitmap, width);
    expect(opts.bitmap[4 * (57 * width + 35)]).toBe(overlap ? 40 : 248);
  },
);
