import { expect, it } from "vitest";
import { matchCodexRepairTone } from "../src/main/inpainting/codexRepairTone";
import { codexRepairDifference } from "../src/main/inpainting/codexRepairDifference";

function raster(rgb: number[]) {
  return {
    width: 40,
    height: 40,
    data: Uint8Array.from({ length: 40 * 40 * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : rgb[index % 4],
    ),
  };
}

it("corrects a small RGB cast using preserved context without changing the source", () => {
  const original = raster([130, 155, 180]),
    generated = raster([121, 162, 167]);
  const before = Uint8Array.from(original.data);
  const result = matchCodexRepairTone(
    original,
    generated,
    new Uint8Array(1600),
  );
  expect([...result.output.data.subarray(0, 4)]).toEqual([130, 155, 180, 255]);
  expect(original.data).toEqual(before);
});

it("excludes the repair area from tone calibration and keeps black and white endpoints", () => {
  const original = raster([255, 255, 255]),
    generated = raster([240, 240, 240]);
  const mask = new Uint8Array(1600);
  for (let at = 0; at < 1200; at++) {
    mask[at] = 1;
    original.data.fill(222, at * 4, at * 4 + 3);
  }
  generated.data.fill(0, 0, 3);
  generated.data.fill(255, 4, 7);
  const result = matchCodexRepairTone(original, generated, mask);
  expect(result.output.data[1500 * 4]).toBe(255);
  expect(result.output.data[0]).toBe(0);
  expect(result.output.data[4]).toBe(255);
});

it("keeps the original tone when no independent calibration samples exist", () => {
  const original = raster([80, 80, 80]),
    generated = raster([95, 95, 95]);
  const result = matchCodexRepairTone(
    original,
    generated,
    new Uint8Array(1600).fill(1),
  );
  expect([...result.output.data]).toEqual([...generated.data]);
});

it("replaces even tiny explicitly painted marks and feathers only outside their core", () => {
  const original = raster([240, 240, 240]),
    generated = raster([240, 240, 240]);
  const core = new Uint8Array(1600),
    permission = new Uint8Array(1600).fill(1);
  core[20 * 40 + 20] = 1;
  original.data.fill(10, (20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 3);
  const result = codexRepairDifference(original, generated, permission, core);
  expect(result.opacity[20 * 40 + 20]).toBe(1);
  expect(result.opacity[20 * 40 + 23]).toBeGreaterThan(
    result.opacity[20 * 40 + 25],
  );
  expect(result.opacity[20 * 40 + 25]).toBeGreaterThan(0);
  expect(result.opacity[20 * 40 + 30]).toBe(0);
});
