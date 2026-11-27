import { completeOutlinedWhitePrint } from "../src/main/inpainting/qwenCaptionEnvelope";
import { describeStackedEdition } from "../src/main/inpainting/qwenPrintedReference";
import {
  completeQwenDisplayInk,
  completeQwenOutlinedLettering,
} from "../src/main/inpainting/qwenOutlinedLettering";
import { assert, expect, it } from "vitest";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import {
  isIllustratedTitleGroup,
  completeMagazineLine,
  measuredIllustratedPlate,
  resolveIllustratedPrintKind,
  reserveMeasuredSounds,
  selectedPrintGroups,
  reserveDisplayNeighbours,
} from "../src/main/inpainting/qwenIllustratedPlate";

it("finishes a partly owned white radical using neighbouring outlined print", () => {
  const width = 155,
    height = 69;
  const bitmap = Buffer.alloc(4 * width * height, 255);
  const bounds = { x: 0, y: 0, w: width, h: height };
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      bitmap.fill(43, 4 * i, 4 * i + 3);
      for (const left of [24, 46, 72, 120]) {
        if (x < left || x >= left + 17 || y < 25 || y >= 42) continue;
        bitmap.fill(251, 4 * i, 4 * i + 3);
        if (left < 72 || (left === 72 && x < left + 3)) data[i] = 1;
      }
    }
  const measured = completeOutlinedWhitePrint(
    bitmap,
    width,
    { bounds, data },
    bounds,
  );
  const kept = expandWindowMaskToPage(measured, width, height);
  expect(kept[33 * width + 86]).toBeTruthy();
  expect(kept[33 * width + 90]).toBeTruthy();
  expect(kept[33 * width + 125]).toBeFalsy();
  const cropped = { x: 0, y: 0, w: 35, h: 55 };
  const narrow = {
    bounds: cropped,
    data: new Uint8Array(cropped.w * cropped.h),
  };
  expect(completeOutlinedWhitePrint(bitmap, width, narrow, cropped)).toBe(
    narrow,
  );
  for (let y = 25; y < 42; y++) data.fill(0, y * width + 46, y * width + 63);
  expect(
    completeOutlinedWhitePrint(bitmap, width, { bounds, data }, bounds).data,
  ).toBe(data);
});
import { completeSelectedCaptionColumn } from "../src/main/inpainting/qwenSelectedPrint";
import { trimWindowMask } from "../src/main/inpainting/koharuTypographyMask";
import {
  mastheadPeerInk,
  measureSpotColourPrint,
} from "../src/main/inpainting/qwenSpotColour";
import {
  isLargeIllustratedPrint,
  washedDisplayTitle,
} from "../src/main/inpainting/qwenTextArtwork";
import {
  qwenControlSampling,
  qwenSamplingSizes,
  referenceEditMode,
} from "../src/main/inpainting/qwenControlSampling";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";
import { prepareGroupedRegionWindows } from "../src/main/inpainting/patternSharedWindows";

it("measures the white falloff around grayscale cover letters and keeps an exposed pen edge", () => {
  const width = 710,
    height = 270;
  const bounds = { x: 60, y: 55, w: 575, h: 150 };
  const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h) };
  for (let y = 0; y < bounds.h; y++)
    for (let x = 0; x < bounds.w; x++)
      if (x % 79 < 44 && y >= 4 && y < 144) mask.data[y * bounds.w + x] = 1;
  const selected = expandWindowMaskToPage(mask, width, height);
  const distance = distanceToMask(selected, width, height);
  const bitmap = Buffer.alloc(4 * width * height, 255);
  for (let i = 0; i < selected.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const stripe = (x + 3 * y) % 11;
    const tone = selected[i]
      ? (x - bounds.x) % 79 < 28
        ? 43
        : 253
      : distance[i] < 5
        ? 255
        : distance[i] < 14
          ? stripe < 2
            ? 96
            : 253
          : stripe < 6
            ? 42
            : 239;
    bitmap.fill(tone, 4 * i, 4 * i + 3);
  }
  for (let y = 20; y <= 55; y++)
    for (let x = 70; x < 75; x++)
      bitmap.fill(28, 4 * (y * width + x), 4 * (y * width + x) + 3);
  const measured = washedDisplayTitle(bitmap, width, height, mask);
  assert.isDefined(measured);
  const field = expandWindowMaskToPage(measured, width, height);
  expect(field[56 * width + 90]).toBe(1);
  expect(field[53 * width + 72]).toBe(0);
  expect(field[10 * width + 90]).toBe(0);
  const reading = "長い章題：第２部";
  const ids = selectedPrintGroups(
    "title:1",
    { washedTitle: reading, speechBubble: false },
    [],
  );
  const hint = isIllustratedTitleGroup(ids);
  expect(hint).toBe("washed-title:" + reading);
  assert(hint);
  const config = {
    ...referenceEditMode(hint),
    sourceReference: true,
    registered: false,
  };
  expect(qwenSamplingSizes(config)[0]).toBe(832);
  expect(qwenControlSampling(config)).toMatchObject({
    steps: 40,
    cfg: 3.5,
    referenceSource: true,
    prompt: expect.stringContaining(reading),
  });
  const block = { ...makeBlock(), id: "chapter-heading", sourceText: reading };
  const page = { ...makePage(), width, height, blocks: [block] };
  const plan = resolvePatternFluxCompositePlan({
    page,
    block,
    width,
    height,
    bitmap,
    sourceRect: bounds,
    regionMask: mask,
    fallbackConstraint: null,
    conditionOnTypography: true,
  });
  expect(plan.washedTitle).toBe(reading.normalize("NFKC"));
  const ctx = createEmptyPatternMaskContext(width, height);
  ctx.validationBlockIds.push(block.id);
  ctx.inpaintWindows.push({ x: 0, y: 0, w: width, h: height });
  ctx.inpaintWindowMasks.push(plan.modelMask);
  ctx.inpaintCompositeMasks.push(plan.compositeMask);
  ctx.inpaintCompositeFeatherPx.push(plan.featherPx);
  ctx.inpaintWindowConstraints.push(plan.constraint);
  ctx.inpaintWindowGroupIds.push(selectedPrintGroups(block.id, plan, []));
  ctx.inpaintSpeechBubbleWindows.push(false);
  prepareGroupedRegionWindows(ctx, {
    page,
    width,
    bitmap,
    mode: "flux-region",
    conditionOnTypography: true,
  });
  expect(ctx.inpaintWindowMasks[0]).toEqual(plan.modelMask);
  const envelope = expandWindowMaskToPage(
    ctx.inpaintCompositeMasks[0],
    width,
    height,
  );
  expect(envelope[20 * width + 94]).toBe(1);
  expect(envelope[height * width - 1]).toBe(0);
  bitmap.fill(246);
  expect(washedDisplayTitle(bitmap, width, height, mask)).toBeUndefined();
});

it("reserves a nearby badge for its own erase even where its corner touches a measured title", () => {
  const area = (x: number, y: number, w: number, h: number) => ({
    bounds: { x, y, w, h },
    data: new Uint8Array(w * h).fill(1),
  });
  const face = area(20, 30, 100, 40),
    envelope = area(4, 9, 132, 82);
  const badge = area(45, 11, 17, 21),
    inside = area(75, 42, 14, 11);
  const windows = [
    face,
    badge,
    inside,
    area(150, 9, 10, 10),
    area(20, 26, 96, 50),
  ];
  const result = reserveDisplayNeighbours(face, envelope, windows, 0);
  for (const mask of [result.measured, result.envelope]) {
    const field = expandWindowMaskToPage(mask, 180, 105);
    expect(field[30 * 180 + 51]).toBe(0);
    expect(field[43 * 180 + 77]).toBe(1);
    expect(field[35 * 180 + 51]).toBe(1);
  }
  expect(face.data.every(Boolean)).toBe(true);
  expect(badge.data.every(Boolean)).toBe(true);
});
import { measuredJacketRow } from "../src/main/inpainting/qwenMagazineInsets";
import { matchCoverStock } from "../src/main/inpainting/qwenCoverStock";
import {
  isRestoredWhitePrint,
  overlappingPrintOrder,
  reconcileOverlappingPrint,
} from "../src/main/inpainting/qwenOverlappingPrint";
import { pixelsToBbox } from "../src/shared/bboxNormalization";
import { groupMagazineInsets } from "../src/main/inpainting/qwenMagazineGroups";
import { createEmptyPatternMaskContext } from "../src/main/inpainting/patternMaskContext";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";
import { survivingJacketLines } from "../src/main/inpainting/qwenJacketVerifier";

it("recognizes overlapping white-stock erasures only after the original ink has disappeared", () => {
  const width = 26;
  const sourceBitmap = Buffer.alloc(width * 14 * 4, 255);
  const bitmap = Buffer.from(sourceBitmap);
  const contextBitmap = Buffer.from(sourceBitmap);
  const page = { width, sourceBitmap, contextBitmap, bitmap };
  const localMask = new Uint8Array(60),
    validationMask = new Uint8Array(60);
  const crop = {
    paddedBounds: { x: 3, y: 5, w: 10, h: 6 },
    localMask,
    validationMask,
  };
  const pixel = (i: number) =>
    4 * ((5 + Math.floor(i / 10)) * width + 3 + (i % 10));
  localMask.fill(255, 4, 20);
  validationMask[26] = 1;
  expect(isRestoredWhitePrint(page, crop)).toBe(false);
  for (let i = 8; i < 15; i++) sourceBitmap.fill(20, pixel(i), pixel(i) + 3);
  expect(isRestoredWhitePrint(page, crop)).toBe(true);
  const original = { bounds: crop.paddedBounds, data: localMask.slice() };
  const rimOnly = { ...crop, localMask: new Uint8Array(localMask.length) };
  expect(isRestoredWhitePrint(page, rimOnly)).toBe(false);
  expect(isRestoredWhitePrint(page, rimOnly, original)).toBe(true);
  bitmap[pixel(26) + 2] = 161;
  expect(isRestoredWhitePrint(page, crop)).toBe(false);
  bitmap[pixel(26) + 2] = 255;
  contextBitmap[pixel(11)] = 193;
  expect(isRestoredWhitePrint(page, crop)).toBe(false);
  contextBitmap[pixel(11)] = 255;
  bitmap[pixel(12) + 3] = 0;
  expect(isRestoredWhitePrint(page, crop)).toBe(false);
});

it("continues clean hair through an overlapping selected issue only when the displayed logo still carries its original spot ink", () => {
  const width = 123,
    height = 87,
    bounds = { x: 0, y: 0, w: width, h: height };
  const data = new Uint8Array(width * height),
    matte = new Uint8Array(data.length).fill(1);
  const logo = { bounds, data },
    full = { bounds, data: matte };
  const issue = {
    bounds: { x: 60, y: 24, w: 43, h: 44 },
    data: new Uint8Array(43 * 44).fill(1),
  };
  const sourceBitmap = Buffer.alloc(4 * data.length, 255),
    generated = Buffer.from(sourceBitmap);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      generated.set([173, 115, 64, 255], 4 * i);
      data[i] = Number(y > 10 && y < 58 && x > 10 && x < 94 && x % 16 < 10);
      sourceBitmap.set(
        data[i] ? [6, 124, 235, 255] : [173, 115, 64, 255],
        4 * i,
      );
    }
  const bitmap = Buffer.from(generated);
  for (let y = 32; y < 38; y++)
    for (const x of [33, 65])
      bitmap.set([15, 122, 225, 255], 4 * (y * width + x));
  const options = {
    signal: new AbortController().signal,
    windowMasks: [logo, issue],
    compositeMasks: [full, issue],
    illustratedTitleWindows: ["masthead", "edition:11 2027 NOV"] as [
      "masthead",
      "edition:11 2027 NOV",
    ],
  };
  const args = {
    index: 0,
    bitmap,
    sourceBitmap,
    width,
    runOptions: options,
    cropStrategy: "worker-resize" as const,
  };
  const crop = {
    paddedBounds: bounds,
    writeBounds: bounds,
    localMask: data,
    validationMask: data,
    processSize: { width, height },
  };
  expect(overlappingPrintOrder(options, 2)).toEqual([1, 0]);
  expect(
    overlappingPrintOrder({ ...options, windowProcessingOrder: [1, 0] }, 2),
  ).toEqual([1, 0]);
  const before = Buffer.from(bitmap);
  reconcileOverlappingPrint(
    {
      ...args,
      runOptions: {
        ...options,
        compositeConstraints: [
          full,
          { ...issue, data: new Uint8Array(issue.data.length) },
        ],
      },
    },
    crop,
    generated,
  );
  expect(bitmap.equals(before)).toBe(true);
  reconcileOverlappingPrint(args, crop, generated);
  expect([
    ...bitmap.subarray(4 * (35 * width + 65), 4 * (35 * width + 65) + 4),
  ]).toEqual([173, 115, 64, 255]);
  expect([
    ...bitmap.subarray(4 * (35 * width + 33), 4 * (35 * width + 33) + 4),
  ]).toEqual([15, 122, 225, 255]);
  const clean = Buffer.from(bitmap);
  reconcileOverlappingPrint(args, crop, generated);
  expect(bitmap.equals(clean)).toBe(true);
});

it("matches exposed gray paper at a printed title edge only when the original ink is monochrome", () => {
  const width = 112,
    height = 112;
  const bounds = { x: 0, y: 0, w: width, h: height };
  const data = new Uint8Array(width * height);
  const source = Buffer.alloc(data.length * 4, 160);
  for (let y = 30; y < 82; y++)
    for (let x = 30; x < 82; x++) {
      const at = y * width + x;
      data[at] = 1;
      source.fill(x % 8 < 3 ? 38 : 252, at * 4, at * 4 + 3);
    }
  const generated = Buffer.alloc(source.length, 150);
  const example = 4 * (55 * width + 31);
  matchCoverStock(source, width, generated, bounds, { bounds, data });
  expect(generated[example]).toBeGreaterThan(150);
  expect(generated[example]).toBeLessThanOrEqual(161);
  expect(generated[4 * (55 * width + 28)]).toBe(150);
  expect(generated[4 * (55 * width + 55)]).toBe(150);
  for (let i = 0; i < data.length; i++) if (data[i]) source[4 * i + 2] = 90;
  generated.fill(150);
  matchCoverStock(source, width, generated, bounds, { bounds, data });
  expect(generated.every((value) => value === 150)).toBe(true);
});

it("revisits only text that survives inside a selected original jacket line", () => {
  const selected = { x: 3, y: 5, w: 13, h: 38 };
  const illustrated = { x: 38, y: 27, w: 10, h: 9 };
  const mask = new Uint8Array(60 * 60);
  for (let y = 5; y < 43; y++) mask.fill(1, y * 60 + 3, y * 60 + 16);
  const remaining = survivingJacketLines(
    [selected, illustrated],
    [{ x: 4, y: 8, w: 12, h: 32 }, illustrated, { x: 19, y: 3, w: 10, h: 12 }],
    mask,
    60,
    60,
  );
  expect(remaining[25 * 60 + 8]).toBe(1);
  expect(remaining[30 * 60 + 42]).toBe(0);
  expect(remaining[13 * 60 + 22]).toBe(0);
  expect(survivingJacketLines([selected], [], mask, 60, 60).some(Boolean)).toBe(
    false,
  );
});

it("isolates adjacent miniature illustrations only when the original shows both frames", () => {
  const width = 600,
    height = 800,
    bitmap = Buffer.alloc(width * height * 4, 242);
  for (const x0 of [200, 281, 362]) {
    for (let y = 470; y < 576; y++)
      for (let x = x0; x < x0 + 74; x++)
        bitmap.set([65, 125, 42, 255], 4 * (y * width + x));
  }
  const titles = [202, 283, 364].map((x) => ({ x, y: 474, w: 26, h: 88 }));
  const frames = measuredJacketRow({ bitmap, width, height }, titles);
  expect(frames).toHaveLength(3);
  for (const [i, b] of frames.entries()) {
    expect(Math.abs(b.x - (200 + i * 81))).toBeLessThanOrEqual(1);
    expect(Math.abs(b.w - 74)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.h - 106)).toBeLessThanOrEqual(1);
  }
  const lines = [
    { x: 30, y: 20, w: 490, h: 100 },
    ...titles,
    { x: 206, y: 442, w: 203, h: 18 },
    { x: 206, y: 583, w: 213, h: 14 },
    { x: 25, y: 430, w: 123, h: 22 },
  ];
  const page = {
    ...makePage(),
    width,
    height,
    blocks: lines.map((bbox, i) => ({
      ...makeBlock(),
      bbox: pixelsToBbox(bbox, width, height),
      id: String(i),
      bboxSpace: "normalized_1000" as const,
      sourceText: "誌面" + i,
    })),
  };
  const context = createEmptyPatternMaskContext(width, height);
  for (const [i, bounds] of lines.entries()) {
    const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
    context.validationBlockIds.push(String(i));
    context.inpaintWindows.push(bounds);
    context.inpaintWindowMasks.push(mask);
    context.inpaintCompositeMasks.push(mask);
    context.inpaintWindowConstraints.push(null);
    context.inpaintWindowGroupIds.push(i === 0 ? ["qwen-masthead:0"] : []);
    context.inpaintSpeechBubbleWindows.push(false);
  }
  groupMagazineInsets(context, { page, bitmap, width });
  expect(context.inpaintWindows.slice(1, 4)).toEqual(frames);
  for (let i = 1; i <= 3; i++) {
    const stencil = expandWindowMaskToPage(
      context.inpaintWindowMasks[i],
      width,
      height,
    );
    expect(stencil[480 * width + titles[i - 1].x + 1]).toBe(1);
    expect(stencil[480 * width + titles[i - 1].x + 50]).toBe(0);
    expect(context.inpaintWindowConstraints[i]).toBe(
      context.inpaintCompositeMasks[i],
    );
  }
  expect(
    context.inpaintWindowGroupIds
      .slice(1)
      .map((group) => group[0]?.split(":")[0]),
  ).toEqual([
    "qwen-jacket",
    "qwen-jacket",
    "qwen-jacket",
    "qwen-jacket-promo",
    "qwen-jacket-strap",
    undefined,
  ]);
  expect(
    measuredJacketRow({ bitmap, width, height }, titles.slice(0, 1)),
  ).toEqual([]);
  expect(
    measuredJacketRow(
      { bitmap: Buffer.alloc(bitmap.length, 180), width, height },
      titles,
    ),
  ).toEqual([]);
  expect(
    isIllustratedTitleGroup(["qwen-sound:effect:id", "qwen-jacket:A%20B:id"]),
  ).toBe("jacket:A B");
  expect(referenceEditMode("cover-columns:見出し").material.kind).toBe(
    "glowing-print",
  );
});

it("identifies the printed colour and position of an issue separately from the date", () => {
  const width = 88,
    height = 110;
  const bitmap = Buffer.alloc(4 * width * height, 235);
  const mask = new Uint8Array(width * height);
  for (let y = 12; y < 95; y++)
    for (let x = 15; x < 70; x++) {
      const i = width * y + x;
      if (x % 13 > 5) continue;
      mask[i] = 1;
      bitmap.set(y < 65 ? [223, 98, 99, 255] : [22, 22, 22, 255], 4 * i);
    }
  const source = { getSize: () => ({ width, height }), toBitmap: () => bitmap };
  const description = describeStackedEdition(source, mask, "12 2027 DEC");
  expect(description).toContain("蓝色大号的「12」");
  expect(description).toContain("小号黑色「2027」「DEC」");
  expect(describeStackedEdition(source, mask, "DEC 2027")).toBeUndefined();
  bitmap.fill(200);
  expect(describeStackedEdition(source, mask, "12 2027 DEC")).toBeUndefined();
});

it("recovers disconnected white title ink within the selected print line", () => {
  const width = 180,
    height = 120,
    bounds = { x: 25, y: 30, w: 100, h: 60 };
  const bitmap = Buffer.alloc(4 * width * height, 100);
  const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h) };
  mask.data[20 * bounds.w + 7] = 1;
  expect(completeMagazineLine(bitmap, width, height, mask)).toBe(mask);
  for (const x of [70, 150])
    bitmap.fill(244, 4 * (50 * width + x), 4 * (50 * width + x) + 3);
  const result = expandWindowMaskToPage(
    completeMagazineLine(bitmap, width, height, mask),
    width,
    height,
  );
  expect(result[50 * width + 70]).toBe(1);
  expect(result[50 * width + 79]).toBe(1);
  expect(result[50 * width + 150]).toBe(0);
});

it("uses the actual selected issue number and month when removing coloured cover lettering", () => {
  const w = 130,
    h = 142;
  const bitmap = Buffer.alloc(4 * w * h, 255);
  const mask = { bounds: { x: 0, y: 0, w, h }, data: new Uint8Array(w * h) };
  for (let y = 22; y < 111; y++)
    for (let x = 15; x < 99; x++) {
      const i = y * w + x;
      mask.data[i] = 1;
      if (x % 19 < 8) bitmap.set([183, 94, 92, 255], 4 * i);
    }
  const page = { bitmap, width: w, page: { height: h } };
  const read = {
    sourceText: "１１ ２０２７ NOV",
    textRole: "ordinary" as const,
  };
  const ids: string[] = [];
  const hint = resolveIllustratedPrintKind(ids, false, mask, page, read);
  expect(hint).toBe("edition:11 2027 NOV");
  expect(isIllustratedTitleGroup(ids)).toBe(hint);
  if (!hint) throw Error("Missing edition hint");
  const config = {
    ...referenceEditMode(hint),
    sourceReference: true,
    registered: false,
  };
  expect(qwenSamplingSizes(config)[0]).toBe(832);
  expect(qwenControlSampling(config)).toMatchObject({
    referenceSource: true,
    referenceEdit: true,
    steps: 40,
    cfg: 3.5,
    prompt: expect.stringContaining("11 2027 NOV"),
  });
  expect(resolveIllustratedPrintKind([], true, mask, page, read)).toBe(false);
  bitmap.fill(250);
  expect(resolveIllustratedPrintKind([], false, mask, page, read)).not.toBe(
    hint,
  );
});
import { continuePublisherGlow } from "../src/main/inpainting/qwenPublisherGlow";
import { enclosedPublisherStock } from "../src/main/inpainting/qwenPublisherRows";

it("reserves a measured effect's complete tip where an earlier dialogue stencil overlaps it", () => {
  const dialogue = {
    bounds: { x: 5, y: 2, w: 4, h: 2 },
    data: Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1),
  };
  const effect = {
    bounds: { x: 7, y: 3, w: 3, h: 2 },
    data: Uint8Array.of(1, 0, 1, 1, 1, 1),
  };
  const context = {
    inpaintWindowMasks: [dialogue, effect, dialogue],
    inpaintWindowGroupIds: [
      ["bubble"],
      ["qwen-measured-sound-outline:s"],
      ["qwen-printed-art"],
    ],
    inpaintSpeechBubbleWindows: [true, false, false],
  };
  expect(reserveMeasuredSounds(context)).toEqual([1, 0, 2]);
  expect([...context.inpaintWindowMasks[0].data]).toEqual([
    1, 1, 1, 1, 1, 1, 0, 1,
  ]);
  expect(context.inpaintWindowMasks[1]).toBe(effect);
  expect(context.inpaintWindowMasks[2]).toBe(dialogue);
});

it("leaves a detector group fully covered by preserved artwork empty", () => {
  const mask = {
    bounds: { x: 11, y: 17, w: 28, h: 26 },
    data: new Uint8Array(28 * 26),
  };
  const input = {
    bitmap: Buffer.alloc(70 * 70 * 4),
    width: 70,
    page: { height: 70 },
  };
  expect(resolveIllustratedPrintKind([], false, mask, input)).toBe(false);
  expect(
    resolveIllustratedPrintKind(["qwen-printed-art"], false, mask, input),
  ).toBe(false);
});

it("completes a detached opaque kana stroke only when its pen and stock match three selected strokes", () => {
  const width = 192,
    height = 130;
  const bounds = { x: 0, y: 0, w: width, h: height };
  const selected = { bounds, data: new Uint8Array(width * height) };
  const bitmap = Buffer.alloc(4 * width * height, 175);
  const draw = (left: number, pen: number, mark: boolean) => {
    for (let row = 0; row < 64; row++) {
      for (let col = 0; col < 15; col++) {
        const at = (row + 30) * width + left + Math.floor(0.48 * row) + col;
        const rim = col < 2 || col >= 13 || row < 2 || row >= 62;
        bitmap.fill(rim ? pen : 251, 4 * at, 4 * at + 3);
        selected.data[at] = Number(mark);
      }
    }
  };
  const size = { width, height, sourceRect: { x: 12, y: 19, w: 165, h: 91 } };
  for (const left of [48, 76, 104]) draw(left, 73, true);
  draw(21, 73, false);
  const inferred = completeQwenOutlinedLettering(bitmap, size, selected);
  assert(inferred);
  expect(expandWindowMaskToPage(inferred, width, height)[57 * width + 40]).toBe(
    1,
  );
  const clipped = (x: number) =>
    completeQwenOutlinedLettering(
      bitmap,
      { ...size, sourceRect: { ...size.sourceRect, x, w: 177 - x } },
      selected,
    );
  expect(clipped(47)).toBeDefined();
  expect(clipped(56)).toBeUndefined();
  draw(21, 24, false);
  expect(completeQwenOutlinedLettering(bitmap, size, selected)).toBeUndefined();
});

it("follows a gradual printed white shoulder up to the exposed background", () => {
  const w = 108,
    h = 68,
    bounds = { x: 0, y: 0, w, h },
    mask = new Uint8Array(w * h);
  const gray = mask.map((_, i) => {
    const x = i % w;
    mask[i] = Number(x >= 17 && x <= 52);
    return x <= 49 ? 249 : Math.max(160, 249 - (x - 49) * 8);
  });
  const repaired = continuePublisherGlow(gray, mask, bounds);
  expect(repaired[34 * w + 58]).toBe(1);
  expect(repaired[34 * w + 70]).toBe(0);
  expect(repaired[34 * w + 13]).toBe(0);
  const abrupt = gray.map((_, i) => (i % w <= 52 ? 249 : 160));
  expect(continuePublisherGlow(abrupt, mask, bounds)).toEqual(mask);
});

it("recovers a clipped final column from matching strokes and preserves a passing panel rule", () => {
  const width = 148,
    height = 168,
    bounds = { x: 0, y: 0, w: width, h: height },
    original = Buffer.alloc(width * height * 4, 255),
    stencil = new Uint8Array(width * height);
  const glyph = (x: number, y: number, owned: number) => {
    for (let dy = 0; dy < 15; dy++)
      for (let dx = 0; dx < 14; dx++) {
        if (dx > 2 && (dy < 4 || dy > 6)) continue;
        const i = (y + dy) * width + x + dx;
        original.fill(20, 4 * i, 4 * i + 3);
        stencil[i] = Number(dy < owned);
      }
  };
  for (const x of [55, 80, 103]) for (const y of [19, 43, 67]) glyph(x, y, 15);
  glyph(31, 90, 3);
  glyph(30, 109, 0);
  for (let y = 0; y < height; y++)
    original.fill(8, 4 * (y * width + 22), 4 * (y * width + 22) + 3);
  const selected = trimWindowMask({ bounds, data: stencil });
  const box = { x: 19, y: 8, w: 103, h: 137 };
  const repaired = completeSelectedCaptionColumn(
    original,
    { width, height },
    box,
    selected,
  );
  assert.isDefined(repaired);
  const pixels = expandWindowMaskToPage(repaired, width, height);
  expect(pixels[115 * width + 31]).toBe(1);
  expect(pixels[93 * width + 22]).toBe(0);
  const block = {
    ...makeBlock(),
    textRole: "ordinary" as const,
    sourceText: "物語の始まりです",
  };
  const { x, y, w, h } = selected.bounds;
  const plan = resolvePatternFluxCompositePlan({
    width,
    height,
    bitmap: original,
    regionMask: selected,
    sourceRect: box,
    block,
    page: { ...makePage(), width, height, blocks: [block] },
    conditionOnTypography: true,
    fallbackConstraint: null,
    segmentation: {
      imageWidth: width,
      imageHeight: height,
      detections: [
        {
          labelId: 1,
          label: "text",
          score: 0.98,
          box: [x, y, x + w, y + h],
          mask: {
            width,
            height,
            logits: Float32Array.from(stencil, (v) => (v ? 12 : -12)),
          },
        },
      ],
    },
  });
  const actual = expandWindowMaskToPage(plan.modelMask, width, height);
  expect(actual[115 * width + 31]).toBe(1);
  expect(actual[93 * width + 22]).toBe(0);
  // With the entire detached pair unobserved, the nearby drawing is insufficient.
  stencil.fill(0, 88 * width);
  expect(
    completeSelectedCaptionColumn(
      original,
      { width, height },
      box,
      trimWindowMask({ bounds, data: stencil }),
    ),
  ).toBeUndefined();
});

it("uses the source illustration when unboxed dialogue crosses two exposed drawn contours", () => {
  const w = 198,
    h = 194;
  const bounds = { x: 70, y: 34, w: 51, h: 124 };
  const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
  const options = {
    width: w,
    page: { height: h },
    bitmap: Buffer.alloc(w * h * 4, 255),
  };
  const block = {
    textRole: "ordinary" as const,
    sourceText: "This text crosses the horizon.",
  };
  expect(resolveIllustratedPrintKind([], false, mask, options, block)).toBe(
    false,
  );
  for (const y of [53, 101])
    for (let x = 15; x < 68; x++) {
      const at = 4 * (y * w + x);
      options.bitmap.fill(40, at, at + 3);
    }
  const ids: string[] = [];
  expect(resolveIllustratedPrintKind(ids, false, mask, options, block)).toBe(
    "caption",
  );
  expect(isIllustratedTitleGroup(ids)).toBe("caption");
  expect(resolveIllustratedPrintKind([], true, mask, options, block)).toBe(
    false,
  );
});

it("includes a printed title frame and its tail only around selected lettering", () => {
  const w = 166,
    h = 79,
    gray = new Uint8Array(w * h).fill(250),
    selected = new Uint8Array(w * h);
  for (let y = 12; y <= 45; y++)
    for (let x = 16; x <= 136; x++) {
      const border = y === 12 || y === 45 || x === 16 || x === 136;
      const letter = y > 19 && y < 38 && x > 27 && x < 125 && x % 13 < 4;
      if (border || letter) gray[y * w + x] = 33;
      selected[y * w + x] = 1;
    }
  for (let i = 1; i <= 9; i++) gray[(45 + i) * w + 107 + i] = 38;
  const box = { x: 0, y: 0, w, h };
  const inspected = enclosedPublisherStock(gray, selected, box);
  expect(inspected[54 * w + 116]).toBe(1);
  expect(inspected[62 * w + 131]).toBe(0);
  selected.fill(0);
  expect(enclosedPublisherStock(gray, selected, box).some(Boolean)).toBe(false);
});

it("keeps a row of independent spot-colour letters without reserving the intervening sky", () => {
  const w = 155,
    h = 55,
    rect = { x: 0, y: 0, w, h };
  const bitmap = Buffer.alloc(4 * w * h, 255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const stroke = y > 12 && y < 36 && x > 5 && x < 143 && x % 25 < 13;
      bitmap.set(
        stroke ? [23, 113, 235] : [154, 55 + (x % 9), 27],
        4 * (y * w + x),
      );
    }
  const guarded = mastheadPeerInk(bitmap, w, rect);
  assert.isDefined(guarded);
  expect(guarded.data[21 * w + 31]).toBe(1);
  expect(guarded.data[2 * w + 31]).toBe(0);
  expect(
    mastheadPeerInk(Buffer.alloc(bitmap.length, 180), w, rect),
  ).toBeUndefined();
});

it("uses a reference edit for large reverse-outlined letters only over a textured illustration", () => {
  const width = 320,
    height = 320,
    stencil = new Uint8Array(width * height);
  const original = Buffer.alloc(4 * stencil.length, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        selected = x > 60 && x < 245 && y > 31 && y < 280 && x % 20 < 12;
      stencil[i] = Number(selected);
      const v = selected
        ? x % 20 < 6
          ? 35
          : 250
        : 105 + ((x * 3 + y * 7) % 117);
      original.fill(v, 4 * i, 4 * i + 3);
    }
  expect(isLargeIllustratedPrint({ width, height, original, stencil })).toBe(
    true,
  );
  for (let i = 0; i < stencil.length; i++)
    if (!stencil[i]) original.fill(252, 4 * i, 4 * i + 3);
  expect(isLargeIllustratedPrint({ width, height, original, stencil })).toBe(
    false,
  );
  const coloured = Buffer.from(original);
  for (let i = 0; i < stencil.length; i++) {
    if (!stencil[i]) coloured[4 * i] = 88;
    else original.fill(31, 4 * i, 4 * i + 3);
  }
  expect(
    isLargeIllustratedPrint({ width, height, original: coloured, stencil }),
  ).toBe(false);
  expect(isLargeIllustratedPrint({ width, height, original, stencil })).toBe(
    false,
  );
});

it("measures a white printed plate between its selected fragments and preserves the surrounding gray art", () => {
  const w = 220,
    h = 140,
    bounds = { x: 0, y: 0, w, h };
  const ink = new Uint8Array(w * h),
    bitmap = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x,
        inside = x >= 45 && x <= 165 && y >= 36 && y <= 100;
      const paper = inside || (x >= 42 && x <= 168 && y >= 33 && y <= 103);
      const letter = inside && x % 15 < 4 && y % 22 < 18;
      bitmap.fill(letter ? 24 : paper ? 255 : 178, 4 * p, 4 * p + 3);
      ink[p] = Number(inside && (x !== 92 || y < 42));
    }
  const measured = measuredIllustratedPlate(
    bitmap,
    w,
    { bounds, data: ink },
    bounds,
  );
  assert.isDefined(measured);
  const recovered = expandWindowMaskToPage(measured, w, h);
  expect(recovered[63 * w + 92]).toBe(1);
  expect(recovered[34 * w + 61]).toBe(1);
  expect(recovered[21 * w + 61]).toBe(0);
  expect(
    measuredIllustratedPlate(
      Buffer.alloc(bitmap.length, 160),
      w,
      { bounds, data: ink },
      bounds,
    ),
  ).toBeUndefined();
});

it("recognizes the exposed spot colour behind an occluding illustration", () => {
  const w = 480,
    h = 132,
    bounds = { x: 0, y: 0, w, h },
    ink = new Uint8Array(w * h);
  for (let y = 20; y < 95; y++)
    for (let x = 11; x < 468; x++) {
      const col = (x - 11) % 92;
      ink[y * w + x] = Number(col <= 14 || (y < 30 && col <= 61));
    }
  const dist = distanceToMask(ink, w, h);
  const bmp = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < ink.length; i++) {
    const y = Math.floor(i / w),
      glow = 0.9 * Math.exp(-0.5 * (dist[i] / 7) ** 2);
    const background = [144, 75, 41];
    const printed = ink[i]
      ? [0, 123, 240]
      : background.map((v) => Math.round(v + (255 - v) * glow));
    bmp.set(y >= 56 && y < 67 ? [55, 42, 63] : printed, 4 * i);
  }
  const result = measureSpotColourPrint(bmp, w, bounds);
  assert.isDefined(result);
  expect(result.data[30 * w + 109]).toBe(1);
  expect(result.data[61 * w + 109]).toBe(0);
  expect(result.data[123 * w + 110]).toBe(0);
  expect(
    measureSpotColourPrint(Buffer.alloc(bmp.length, 144), w, bounds),
  ).toBeUndefined();
});

it("bounds native print analysis before inspecting a large selected page", () => {
  const width = 1300,
    height = 1200;
  const bounds = { x: 0, y: 0, w: width, h: height };
  const data = new Uint8Array(width * height).fill(1);
  expect(
    completeQwenDisplayInk(
      Buffer.alloc(0),
      { width, height },
      { bounds, data },
      bounds,
    ),
  ).toBeUndefined();
});
