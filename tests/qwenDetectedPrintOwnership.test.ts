import { describe, expect, it } from "vitest";
import {
  ownedPrintDetections,
  registerEnclosedType,
  jointlySelectedBalloonPrint,
} from "../src/main/inpainting/qwenDetectedPrintEdge";
import { makeFilledDetection, makePage } from "./koharuTypographyMask.fixture";
import { resolvePatternFluxCompositePlan } from "../src/main/inpainting/patternFluxCompositePlan";

describe("ownership of detected Qwen print", () => {
  it("coalesces selected overlapping dialogue only inside the same verified paper balloon", () => {
    const page = { ...makePage(), width: 128, height: 128 };
    const layout = {
      version: 1 as const,
      origin: "detected" as const,
      direction: "vertical" as const,
      regions: [],
      confidence: 1,
      insetRatio: 0,
    };
    const rect = { x: 25, y: 20, w: 65, h: 67 };
    const block = {
      ...page.blocks[0],
      bboxSpace: "pixels" as const,
      bbox: rect,
      bubbleLayout: layout,
    };
    const peer = {
      ...block,
      id: "second",
      bbox: { x: 46, y: 43, w: 54, h: 67 },
    };
    page.blocks = [block, peer];
    const bounds = { x: 32, y: 27, w: 59, h: 69 };
    const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h) };
    const pixels = Buffer.alloc(4 * 128 * 128, 255);
    for (const y of [29, 48, 69, 89])
      for (const x of [50, 68, 84]) {
        for (let dy = 0; dy < 5; dy++)
          for (let dx = 0; dx < 4; dx++) {
            const k = 4 * ((y + dy) * 128 + x + dx);
            pixels.fill(20, k, k + 3);
            mask.data[(y + dy - bounds.y) * bounds.w + x + dx - bounds.x] = 1;
          }
      }
    const owner = {
      bounds: { x: 8, y: 5, w: 108, h: 116 },
      data: new Uint8Array(108 * 116).fill(1),
    };
    const options = {
      page,
      block,
      sourceRect: rect,
      bitmap: pixels,
      width: 128,
      height: 128,
      selectedDialogue: new Set([block.id, peer.id]),
      segmentation: {
        imageWidth: 128,
        imageHeight: 128,
        detections: [
          makeFilledDetection("bubble", 2, [7, 4, 117, 122]),
          makeFilledDetection("text", 0, [49, 28, 90, 95]),
        ],
      },
      conditionOnTypography: true,
      fallbackConstraint: owner,
      regionMask: owner,
    };
    const joint = jointlySelectedBalloonPrint(options, mask);
    expect(joint?.ids).toEqual([block.id, peer.id]);
    expect(resolvePatternFluxCompositePlan(options).sharedDialogueIds).toEqual([
      block.id,
      peer.id,
    ]);
    expect(
      jointlySelectedBalloonPrint(
        { ...options, selectedDialogue: new Set([block.id]) },
        mask,
      ),
    ).toBeUndefined();
    expect(
      jointlySelectedBalloonPrint(
        {
          ...options,
          segmentation: { ...options.segmentation, detections: [] },
        },
        mask,
      ),
    ).toBeUndefined();
    expect(
      jointlySelectedBalloonPrint(options, {
        ...mask,
        bounds: { ...bounds, x: 10 },
      }),
    ).toBeUndefined();
    page.blocks.push({
      ...peer,
      id: "unselected",
      bbox: { x: 26, y: 90, w: 12, h: 10 },
    });
    expect(jointlySelectedBalloonPrint(options, mask)).toBeUndefined();
    page.blocks.pop();
    pixels[4 * (60 * 128 + 62) + 1] = 85;
    expect(jointlySelectedBalloonPrint(options, mask)).toBeUndefined();
  });
  it("restores detected type inside an enclosed automatic mask hole and respects open and manual cuts", () => {
    const page = makePage(),
      width = 64,
      height = 64;
    const bounds = { x: 0, y: 0, w: width, h: height };
    const data = new Uint8Array(width * height);
    const pixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 19; y < 41; y++)
      for (let x = 19; x < 41; x++) {
        if ((x >= 25 && x < 32) || (y >= 26 && y < 32)) {
          data[y * width + x] = 1;
          pixels.fill(9, 4 * (y * width + x), 4 * (y * width + x) + 3);
        }
      }
    const base = new Uint8Array(width * height).fill(1);
    for (let y = 20; y < 31; y++) base.fill(0, y * width + 21, y * width + 34);
    const owner = { bounds, data: base },
      detected = { bounds, data };
    const block = {
      ...page.blocks[0],
      bubbleLayout: {
        version: 1 as const,
        direction: "vertical" as const,
        origin: "detected" as const,
        regions: [],
        confidence: 1,
        insetRatio: 0,
      },
    };
    const options = {
      block,
      page,
      width,
      height,
      bitmap: pixels,
      conditionOnTypography: true,
      sourceRect: bounds,
      regionMask: owner,
      fallbackConstraint: owner,
    };
    const type = { instance: detected, core: detected };
    const repaired = registerEnclosedType(options, type, owner);
    expect(repaired.data[25 * width + 28]).toBe(1);
    expect(owner.data[25 * width + 28]).toBe(0);
    expect(
      registerEnclosedType(
        {
          ...options,
          block: {
            ...block,
            bubbleLayout: { ...block.bubbleLayout, origin: "manual" },
          },
        },
        type,
        owner,
      ),
    ).toBe(owner);
    base.fill(0, 25 * width, 25 * width + 24);
    expect(registerEnclosedType(options, type, owner)).toBe(owner);
  });

  it("assigns an overlapping effect to the block whose source box matches the original detection", () => {
    const page = makePage(),
      block = { ...page.blocks[0], textRole: "ordinary" as const };
    const sound = {
      ...block,
      id: "printed-sound",
      textRole: "sound" as const,
      bboxSpace: "pixels" as const,
      bbox: { x: 27, y: 20, w: 25, h: 31 },
    };
    page.blocks = [block, sound];
    const text = makeFilledDetection("text", 0, [5, 5, 35, 29]),
      effect = makeFilledDetection("onomatopoeia", 1, [27, 20, 52, 51]);
    const segmentation = {
      imageWidth: 64,
      imageHeight: 64,
      detections: [text, effect],
    };
    const bounds = { x: 5, y: 5, w: 30, h: 24 };
    const options = {
      page,
      block,
      width: 64,
      height: 64,
      segmentation,
      sourceRect: bounds,
      conditionOnTypography: true,
      fallbackConstraint: null,
      regionMask: { bounds, data: new Uint8Array(bounds.w * bounds.h) },
    };
    expect(ownedPrintDetections(options)?.detections).toEqual([text]);
    expect(ownedPrintDetections({ ...options, sourceRect: sound.bbox })).toBe(
      segmentation,
    );
    expect(
      ownedPrintDetections({ ...options, conditionOnTypography: false }),
    ).toBe(segmentation);
    const neighboringCaption = { ...sound, textRole: "ordinary" as const };
    const target = { x: 18, y: 50, w: 43, h: 13 };
    const neighbor = { ...effect, label: "text" as const };
    const competing = { ...segmentation, detections: [neighbor] };
    expect(
      ownedPrintDetections({
        ...options,
        sourceRect: target,
        page: { ...page, blocks: [block, neighboringCaption] },
        segmentation: competing,
      })?.detections,
    ).toEqual([]);
  });

  it("reclaims cut dialogue on measured white paper in a shared balloon while protecting neighboring ink", () => {
    const page = makePage(),
      bounds = { x: 6, y: 8, w: 26, h: 38 };
    const block = {
      ...page.blocks[0],
      bbox: bounds,
      bboxSpace: "pixels" as const,
      bubbleLayout: {
        version: 1 as const,
        origin: "detected" as const,
        direction: "vertical" as const,
        regions: [],
        confidence: 1,
        insetRatio: 0,
      },
    };
    const peer = {
      ...block,
      id: "neighbor",
      bbox: { x: 40, y: 11, w: 12, h: 23 },
    };
    page.blocks = [block, peer];
    const detected = new Uint8Array(bounds.w * bounds.h),
      base = detected.slice();
    const bitmap = Buffer.alloc(64 * 64 * 4, 255);
    for (const top of [4, 16, 28])
      for (let y = top; y < top + 6; y++)
        for (let x = 8; x < 16; x++) {
          detected[y * bounds.w + x] = 1;
          base[y * bounds.w + x] = Number(y >= 16);
          const pos = 4 * ((bounds.y + y) * 64 + bounds.x + x);
          bitmap.fill(22, pos, pos + 3);
        }
    const owner = { bounds, data: base },
      mask = { bounds, data: detected };
    const options = {
      page,
      block,
      width: 64,
      height: 64,
      sourceRect: bounds,
      bitmap,
      segmentation: {
        imageWidth: 64,
        imageHeight: 64,
        detections: [makeFilledDetection("bubble", 2, [1, 1, 60, 60])],
      },
      conditionOnTypography: true,
      fallbackConstraint: owner,
      regionMask: owner,
    };
    const evaluate = () =>
      registerEnclosedType(options, { core: mask, instance: mask }, owner);
    expect(evaluate().data[5 * bounds.w + 9]).toBe(1);
    expect(evaluate().data[0]).toBe(0);
    page.blocks = [block, { ...peer, bbox: bounds }];
    expect(evaluate()).toBe(owner);
    page.blocks = [block, peer];
    bitmap[(bounds.y * 64 + bounds.x) * 4] = 90;
    expect(evaluate()).toBe(owner);
  });
});
