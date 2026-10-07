import { expect, it } from "vitest";
import { PNG } from "pngjs";
import { nativePng } from "./mcpNativePng.fixture";

it("preserves pixels, alpha and crop coordinates without sharing mutable buffers", () => {
  const png = new PNG({ width: 3, height: 2 });
  png.data.set(Array.from({ length: 24 }, (_, index) => index * 10));
  const expected = Buffer.from(png.data);
  const bytes = PNG.sync.write(png);
  const image = nativePng(bytes);
  bytes.fill(0);
  expect(image.getSize()).toEqual({ width: 3, height: 2 });
  const first = image.toPNG();
  expect(first).toEqual(PNG.sync.write(png));
  first.fill(0);
  expect(PNG.sync.read(image.toPNG()).data).toEqual(expected);
  const crop = image.crop({ x: 1, y: 0, width: 2, height: 2 });
  expect(crop.getSize()).toEqual({ width: 2, height: 2 });
  const cropped = PNG.sync.read(crop.toPNG());
  expect(cropped.data).toEqual(
    Buffer.concat([expected.subarray(4, 12), expected.subarray(16, 24)]),
  );
  crop.toPNG().fill(0);
  expect(
    PNG.sync.read(crop.crop({ x: 1, y: 1, width: 1, height: 1 }).toPNG()).data,
  ).toEqual(expected.subarray(20, 24));
  expect(PNG.sync.read(image.toPNG()).data).toEqual(expected);
});
