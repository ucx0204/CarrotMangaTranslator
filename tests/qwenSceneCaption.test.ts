import {
  completeSelectedPrintPlan,
  selectedInkPlan,
} from "../src/main/inpainting/qwenSelectedPlan";
import { makePage, makeBlock } from "./unifiedInpaintingUiFixtures";
import { expect, it } from "vitest";
import { keylinedSceneCaption } from "../src/main/inpainting/qwenCaptionEnvelope";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";

function scene(rim = 4.5, stock = 155, count = 4) {
  const width = 130,
    height = 275;
  const selected = { x: 35, y: 34, w: 55, h: 211 };
  const data = new Uint8Array(width * height);
  for (let row = 0; row < count; row++) {
    for (let y = 46 + 52 * row; y < 75 + 52 * row; y++) {
      data.fill(1, y * width + 48, y * width + 54);
      data.fill(1, y * width + 66, y * width + 75);
    }
  }
  const bounds = { x: 0, y: 0, w: width, h: height };
  const bitmap = Buffer.alloc(width * height * 4, 255);
  distanceToMask(data, width, height).forEach((d, i) =>
    bitmap.fill(d === 0 ? 15 : d <= rim ? 250 : stock, 4 * i, 4 * i + 3),
  );
  const ink = { bounds, data };
  const measure = (rect = selected) =>
    keylinedSceneCaption(bitmap, { width, height }, rect, ink);
  return { measure, width, height, bitmap, selected, ink };
}

it("removes the source-measured white printing with the ink on a midtone scene", () => {
  const mask = scene().measure();
  if (!mask) throw new Error("Expected the outlined caption");
  const value = (x: number, y: number) =>
    mask.data[(y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x];
  expect(value(50, 60)).toBe(1);
  expect(value(44, 60)).toBe(1);
  expect(value(59, 60)).toBe(0);
});

it("requires both printed edges and independent artwork beside every part of the caption", () => {
  expect(scene(2).measure()).toBeUndefined();
  expect(scene(7.8).measure()).toBeUndefined();
  expect(scene(14).measure()).toBeUndefined();
  expect(scene(4.5, 247).measure()).toBeUndefined();
  expect(scene(4.5, 155, 2).measure()).toBeUndefined();
  expect(scene().measure({ x: 3, y: 4, w: 90, h: 62 })).toBeUndefined();
});

it("sends the measured lettering to the native restoration through the Qwen selection plan", () => {
  const { width, height, bitmap, selected, ink } = scene();
  const block = {
    ...makeBlock(),
    sourceText: "回想三年前",
    textRole: "ordinary" as const,
  };
  const page = { ...makePage(), width, height, blocks: [block] };
  const options = {
    bitmap,
    width,
    height,
    block,
    page,
    sourceRect: selected,
    regionMask: ink,
    fallbackConstraint: null,
    conditionOnTypography: true,
    segmentation: { imageWidth: width, imageHeight: height, detections: [] },
  };
  const plan = completeSelectedPrintPlan(
    options,
    selectedInkPlan(ink),
    block.sourceText,
  );
  expect(plan?.isolatedTitleStock).toBe(true);
  expect(plan?.modelMask).toEqual(plan?.constraint);
});
