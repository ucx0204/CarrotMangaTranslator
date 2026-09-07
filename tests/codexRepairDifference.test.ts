import { describe, expect, it } from "vitest";
import { codexRepairDifference } from "../src/main/inpainting/codexRepairDifference";
import { compositeCodexRepair } from "../src/main/inpainting/codexRepairComposite";
import type { Raster } from "../src/main/pipeline/codexTypesettingPixelSampling";

function canvas(value = 245): Raster {
  const data = Buffer.alloc(96 * 80 * 4, 255);
  for (let at = 0; at < 96 * 80; at++) data.fill(value, at * 4, at * 4 + 3);
  return { width: 96, height: 80, data };
}
function rectangle(
  image: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number[],
) {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++)
      for (let channel = 0; channel < 3; channel++)
        image.data[(row * image.width + col) * 4 + channel] = color[channel];
}
function region() {
  const permission = new Uint8Array(96 * 80);
  for (let y = 15; y < 65; y++) permission.fill(1, y * 96 + 15, y * 96 + 80);
  return permission;
}

describe("generated background differences", () => {
  it("ignores tiny tone changes while retaining a black glyph removal", () => {
    const original = canvas(),
      generated = canvas(240);
    rectangle(original, 35, 25, 10, 24, [0, 0, 0]);
    const result = codexRepairDifference(original, generated, region());
    expect(result.opacity[30 * 96 + 40]).toBe(1);
    expect(result.opacity[50 * 96 + 65]).toBe(0);
    for (let y = 15; y < 65; y++) expect(result.opacity[y * 96 + 70]).toBe(0);
  });
  it("compares RGB so a colored repair is not lost at similar luminance", () => {
    const original = canvas(100),
      generated = canvas(100);
    rectangle(original, 35, 25, 10, 24, [255, 54, 100]);
    const result = codexRepairDifference(original, generated, region());
    expect(result.opacity[30 * 96 + 40]).toBe(1);
  });
  it("does not treat a shifted fine checker pattern alone as a repair", () => {
    const original = canvas(150),
      generated = canvas(150);
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 96; x++) {
        const value = (x + y) % 2 ? 110 : 190;
        rectangle(original, x, y, 1, 1, [value, value, value]);
        rectangle(generated, x, y, 1, 1, [
          300 - value,
          300 - value,
          300 - value,
        ]);
      }
    expect(
      codexRepairDifference(original, generated, region()).changedPixels,
    ).toBe(0);
  });
  it("keeps a painted hole and every outside pixel unchanged even when the model changes them", () => {
    const original = canvas(),
      generated = canvas();
    rectangle(original, 35, 25, 10, 24, [0, 0, 0]);
    rectangle(generated, 2, 2, 6, 6, [0, 0, 0]);
    const permission = region();
    permission[30 * 96 + 40] = 0;
    const before = Buffer.from(original.data);
    const result = compositeCodexRepair(
      original,
      generated,
      { x: 15, y: 15, w: 65, h: 50 },
      permission,
      "paint",
    );
    expect(result.output.data[(35 * 96 + 40) * 4]).toBeGreaterThan(230);
    for (let at = 0; at < permission.length; at++) {
      if (permission[at]) continue;
      expect(result.output.data.slice(at * 4, at * 4 + 4)).toEqual(
        before.slice(at * 4, at * 4 + 4),
      );
    }
    expect(original.data).toEqual(before);
  });
  it("handles a fully selected crop without inventing independent noise evidence", () => {
    const original = canvas(),
      generated = canvas();
    rectangle(original, 35, 25, 10, 24, [0, 0, 0]);
    const result = compositeCodexRepair(
      original,
      generated,
      { x: 0, y: 0, w: 96, h: 80 },
      new Uint8Array(96 * 80).fill(1),
      "region",
    );
    expect(result.output.data[(30 * 96 + 40) * 4]).toBe(245);
    expect(result.difference.thresholds).toEqual({ fine: 24, coarse: 14 });
  });
  it("rejects incompatible raster or permission dimensions", () => {
    expect(() =>
      codexRepairDifference(canvas(), { ...canvas(), width: 20 }, region()),
    ).toThrow("해상도");
    expect(() =>
      codexRepairDifference(canvas(), canvas(), new Uint8Array(2)),
    ).toThrow("해상도");
  });
});
