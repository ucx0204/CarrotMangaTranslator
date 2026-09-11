import { expect, it } from "vitest";
import type { ImageRedactionStroke } from "../src/shared/imageRedaction";
import { redactionStrokesEqual } from "../src/shared/imageRedactionEditing";

it("compares values without ignoring erasers or isolation and without depending on property order", () => {
  const stroke: ImageRedactionStroke = {
    shape: "rectangle",
    size: 10,
    points: [
      { x: 10, y: 10 },
      { x: 30, y: 30 },
    ],
  };
  expect(
    redactionStrokesEqual(
      [stroke],
      [
        {
          points: stroke.points.map(({ x, y }) => ({ y, x })),
          operation: "hide",
          size: 10,
          shape: "rectangle",
        },
      ],
    ),
  ).toBe(true);
  expect(redactionStrokesEqual([stroke], [])).toBe(false);
  expect(redactionStrokesEqual([stroke], [{ ...stroke, size: 11 }])).toBe(
    false,
  );
  expect(
    redactionStrokesEqual([stroke], [{ ...stroke, operation: "restore" }]),
  ).toBe(false);
  expect(
    redactionStrokesEqual(
      [{ ...stroke, isolation: [1, 2] }],
      [{ ...stroke, isolation: [1, 3] }],
    ),
  ).toBe(false);
});
