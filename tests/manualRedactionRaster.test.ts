import { expect, it } from "vitest";
import type { ImageRedactionStroke } from "../src/shared/imageRedaction";
import { rasterizeImageRedaction } from "../src/shared/imageRedactionRaster";
import { flattenImageRedaction } from "../src/main/imageRedactionPixels";
import {
  copyRedactionStrokes,
  moveRedactionStroke,
  resizeRedactionRectangle,
} from "../src/shared/imageRedactionEditing";

const rectangle: ImageRedactionStroke = {
  shape: "rectangle",
  size: 4,
  points: [
    { x: 1, y: 1 },
    { x: 4, y: 4 },
  ],
};
it("characterizes legacy rectangle coverage and never mutates source bytes", () => {
  const mask = rasterizeImageRedaction(5, 5, [rectangle]);
  expect(Array.from(mask, (value) => (value ? 1 : 0)).join("")).toBe(
    "0000001110011100111000000",
  );
  const original = Buffer.alloc(100, 17);
  const result = flattenImageRedaction(original, mask);
  expect(original.every((value) => value === 17)).toBe(true);
  expect(result[24]).toBe(255);
  expect(result[0]).toBe(17);
});
it("restores only the masked pixels and respects ordered repainting", () => {
  const eraser: ImageRedactionStroke = {
    ...rectangle,
    operation: "restore",
    points: [
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ],
  };
  const mask = rasterizeImageRedaction(5, 5, [rectangle, eraser]);
  expect(mask[12]).toBe(0);
  expect(mask[11]).toBe(255);
  expect(
    rasterizeImageRedaction(5, 5, [rectangle, eraser, rectangle])[12],
  ).toBe(255);
});
it("preserves legacy interpolated brush footprints at page edges", () => {
  const brush: ImageRedactionStroke = {
    shape: "square",
    size: 2,
    points: [
      { x: 0, y: 1 },
      { x: 5, y: 1 },
    ],
  };
  expect([...rasterizeImageRedaction(5, 3, [brush])]).toEqual([
    ...Array(10).fill(255),
    ...Array(5).fill(0),
  ]);
  expect(
    rasterizeImageRedaction(5, 3, [{ ...brush, operation: "restore" }]).some(
      Boolean,
    ),
  ).toBe(false);
});
it("bounds manual transforms and refuses implicit cross-size copying", () => {
  expect(
    moveRedactionStroke(rectangle, 100, 100, { width: 5, height: 5 }).points,
  ).toEqual([
    { x: 2, y: 2 },
    { x: 5, y: 5 },
  ]);
  expect(
    resizeRedactionRectangle(rectangle, { x: 9, y: 9 }, { width: 5, height: 5 })
      .points[1],
  ).toEqual({ x: 5, y: 5 });
  expect(() =>
    copyRedactionStrokes(
      [rectangle],
      { width: 5, height: 5 },
      { width: 10, height: 10 },
      "exact",
    ),
  ).toThrow();
  expect(
    copyRedactionStrokes(
      [rectangle],
      { width: 5, height: 5 },
      { width: 10, height: 10 },
      "proportional",
    )[0].points[0],
  ).toEqual({ x: 2, y: 2 });
});
