import { expect, it } from "vitest";
import type { ImageRedactionStroke } from "../src/shared/imageRedaction";
import {
  copyRedactionStrokes,
  redactionStrokeBounds,
} from "../src/shared/imageRedactionEditing";
import { redactionCopyProblem } from "../src/shared/imageRedactionCopyPolicy";

const brush: ImageRedactionStroke = {
  shape: "square",
  size: 8,
  points: [{ x: 10, y: 10 }],
  isolation: [1],
};
const source = { width: 20, height: 20 };
it("rejects nonuniform scaling before a copied mask can shrink or expose a region", () => {
  const target = { width: 40, height: 20 };
  const strokes = [brush, { ...brush, operation: "restore" as const }];
  expect(redactionCopyProblem(strokes, source, target, "proportional")).toBe(
    "aspect",
  );
  expect(() =>
    copyRedactionStrokes(strokes, source, target, "proportional"),
  ).toThrow();
  expect(strokes[0]).toBe(brush);
});
it("uses one scale for coordinates, brush width and erase geometry without losing isolation", () => {
  const copy = copyRedactionStrokes(
    [brush],
    source,
    { width: 40, height: 40 },
    "proportional",
  )[0];
  expect(redactionStrokeBounds(copy)).toEqual({
    x: 12,
    y: 12,
    width: 16,
    height: 16,
  });
  expect(copy.isolation).toEqual([1]);
  expect(
    copyRedactionStrokes(
      [copy],
      { width: 40, height: 40 },
      source,
      "proportional",
    ),
  ).toEqual([brush]);
});
it.each([0.1, 501])(
  "rejects unsupported brush scaling %s instead of silently clamping",
  (factor) => {
    const target = { width: 20 * factor, height: 20 * factor };
    expect(redactionCopyProblem([brush], source, target, "proportional")).toBe(
      "brush",
    );
  },
);
it("does not constrain an irrelevant rectangle brush width and reports exact-size mismatch", () => {
  const rectangle = { ...brush, shape: "rectangle" as const, size: 1 };
  const target = { width: 10, height: 10 };
  expect(redactionCopyProblem([rectangle], source, target, "exact")).toBe(
    "size",
  );
  expect(
    copyRedactionStrokes([rectangle], source, target, "proportional")[0],
  ).toMatchObject({ size: 1, points: [{ x: 5, y: 5 }] });
  expect(
    redactionCopyProblem(
      [brush],
      source,
      { width: 0, height: 10 },
      "proportional",
    ),
  ).toBe("dimensions");
});
