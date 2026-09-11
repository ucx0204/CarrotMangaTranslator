import { expect, it } from "vitest";
import {
  imageRedactionStrokeSchema,
  type ImageRedactionStroke,
} from "../src/shared/imageRedaction";
import {
  copyRedactionStrokes,
  mergeRedactionStrokes,
} from "../src/shared/imageRedactionEditing";
import { rasterizeImageRedaction } from "../src/shared/imageRedactionRaster";
import { rasterizeImageRedaction as nativeMask } from "../src/main/imageRedactionPixels";

const hide: ImageRedactionStroke = {
  shape: "rectangle",
  size: 1,
  points: [
    { x: 1, y: 1 },
    { x: 8, y: 8 },
  ],
};
const erase: ImageRedactionStroke = {
  ...hide,
  operation: "restore",
  points: [
    { x: 4, y: 4 },
    { x: 7, y: 7 },
  ],
};
const raster = (strokes: ImageRedactionStroke[]) =>
  rasterizeImageRedaction(10, 10, strokes);

it("unions the completed copy without replaying its erasers onto the target", () => {
  const source = [hide, erase];
  const target = [{ ...erase, operation: "hide" as const }];
  const expected = raster(target).map((value, i) =>
    Math.max(value, raster(source)[i]),
  );
  const copy = copyRedactionStrokes(
    source,
    { width: 10, height: 10 },
    { width: 10, height: 10 },
    "exact",
  );
  const merged = mergeRedactionStrokes(target, copy, false);
  expect(raster(merged)).toEqual(expected);
  expect(raster(merged)[55]).toBe(255);
  expect(raster(mergeRedactionStrokes([], copy, false))[55]).toBe(0);
  expect(raster(mergeRedactionStrokes(target, copy, true))).toEqual(
    raster(source),
  );
  expect(source).toEqual([hide, erase]);
  expect(target).toEqual([{ ...erase, operation: "hide" }]);
});

it("allows new erasers after a union and preserves nested copy semantics", () => {
  const source = [
    ...mergeRedactionStrokes([hide], [hide, erase], false),
    erase,
  ];
  const target = [{ ...erase, operation: "hide" as const }];
  const merged = mergeRedactionStrokes(target, source, false);
  expect(raster(merged)).toEqual(raster([hide]));
  expect(raster([...merged, erase])[55]).toBe(0);
  const parsed = merged.map((stroke) =>
    imageRedactionStrokeSchema.parse(JSON.parse(JSON.stringify(stroke))),
  );
  expect(nativeMask(10, 10, parsed)).toEqual(raster(merged));
  expect(raster(source)[55]).toBe(0);
});

it("does not deepen a redundant outer group when copying an already isolated mask", () => {
  let copied = mergeRedactionStrokes([hide], [hide, erase], false).slice(1);
  for (let i = 0; i < 20; i++)
    copied = mergeRedactionStrokes([hide], copied, false).slice(1);
  expect(copied.every((stroke) => stroke.isolation?.length === 1)).toBe(true);
  expect(raster(copied)).toEqual(raster([hide, erase]));
  expect(mergeRedactionStrokes([hide], [], false)).toEqual([hide]);
  expect(mergeRedactionStrokes([hide], [hide], false)).toEqual([hide, hide]);
});

it("rejects excessive nesting without changing an existing document", () => {
  const source = [hide, { ...erase, isolation: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const before = JSON.stringify(source);
  expect(() => mergeRedactionStrokes([hide], source, false)).toThrow(/limit/);
  expect(JSON.stringify(source)).toBe(before);
  expect(
    imageRedactionStrokeSchema.safeParse({
      ...hide,
      isolation: Array(9).fill(1),
    }).success,
  ).toBe(false);
});
