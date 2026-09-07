import { describe, expect, it } from "vitest";
import {
  createCodexEraseMask,
  codexSourceContextRect,
  refineCodexSourceRegion,
} from "../src/shared/codexTypesettingMask";
import type { CodexPageRegion } from "../src/shared/codexTypesettingTypes";
import { compositeRegisteredPatch } from "../src/main/pipeline/codexTypesettingRegistration";

const size = { width: 100, height: 100 };
const sourceBbox = { x: 100, y: 100, w: 100, h: 100 };
const region: CodexPageRegion = {
  id: "sfx",
  action: "text",
  sourceText: "ドン",
  translatedText: "쿵",
  sourceBbox,
  renderBbox: { x: 800, y: 800, w: 100, h: 100 },
  role: "sound",
  direction: "vertical",
  background: "artwork",
  reason: "",
  erasePolygons: [
    [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 1000 },
      { x: 0, y: 1000 },
    ],
    [
      { x: 700, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 700, y: 1000 },
    ],
  ],
};

describe("Codex glyph envelope permission", () => {
  it("protects an occluding balloon inside the source erasure envelope", () => {
    const protectedRegion = {
      ...region,
      occlusionPolygons: [
        [
          { x: 100, y: 100 },
          { x: 150, y: 100 },
          { x: 150, y: 200 },
          { x: 100, y: 200 },
        ],
      ],
    };
    const mask = createCodexEraseMask(protectedRegion, size);
    const at = (x: number, y: number) =>
      mask.data[(y - mask.bounds.y) * mask.bounds.w + x - mask.bounds.x];
    expect(at(11, 15)).toBe(0);
    expect(at(18, 15)).toBe(1);
  });
  it.each([
    { width: 836, height: 13068 },
    { width: 1530, height: 2160 },
    { width: 37, height: 51 },
  ])(
    "preserves native authorized pixels while expanding a clipped box at $width x $height",
    (page) => {
      const initial = {
        ...region,
        sourceBbox: { x: 300, y: 300, w: 120, h: 120 },
      };
      const context = codexSourceContextRect(initial, page);
      const target = {
        x: context.x + 0.25,
        y: context.y + 0.25,
        w: context.w - 0.5,
        h: context.h - 0.5,
      };
      const native = [
        { x: target.x, y: target.y },
        { x: target.x + target.w, y: target.y },
        { x: target.x + target.w, y: target.y + target.h },
        { x: target.x, y: target.y + target.h },
      ];
      const polygons = [
        native.map((point) => ({
          x: ((point.x - context.x) / context.w) * 1000,
          y: ((point.y - context.y) / context.h) * 1000,
        })),
      ];
      const refined = refineCodexSourceRegion(initial, page, polygons);
      const mask = createCodexEraseMask(refined, page);
      let count = 0;
      for (let y = 0; y < mask.bounds.h; y++)
        for (let x = 0; x < mask.bounds.w; x++) {
          const px = x + mask.bounds.x + 0.5,
            py = y + mask.bounds.y + 0.5;
          const allowed =
            px > target.x &&
            px < target.x + target.w &&
            py > target.y &&
            py < target.y + target.h;
          if (mask.data[y * mask.bounds.w + x] !== Number(allowed))
            throw new Error(`Pixel mismatch at ${px},${py}`);
          count += mask.data[y * mask.bounds.w + x];
        }
      expect(count).toBe(context.w * context.h);
      expect(refined.sourceBbox.x).toBeLessThan(initial.sourceBbox.x);
      expect(refined.renderBbox).toEqual(initial.renderBbox);
      expect(refined.sourceText).toBe(initial.sourceText);
      expect(() =>
        createCodexEraseMask(refined, page, [{ ...refined, action: "keep" }]),
      ).toThrow("보존");
    },
  );

  it("clips context at native page edges and retains an unresolvable source box", () => {
    const edge = { ...region, sourceBbox: { x: 999, y: 999, w: 1, h: 1 } };
    expect(codexSourceContextRect(edge, { width: 836, height: 13068 })).toEqual(
      { x: 811, y: 13030, w: 25, h: 38 },
    );
    expect(codexSourceContextRect(edge, { width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    for (const polygons of [
      [],
      [
        [
          { x: 0, y: 0 },
          { x: 500, y: 0 },
          { x: 1000, y: 0 },
        ],
      ],
      [
        [
          { x: 0, y: 0 },
          { x: 0, y: 500 },
          { x: 0, y: 1000 },
        ],
      ],
    ]) {
      const refined = refineCodexSourceRegion(region, size, polygons);
      expect(refined.sourceBbox).toEqual(region.sourceBbox);
      expect(refined.erasePolygons).toEqual([]);
    }
  });
  it("keeps the gap between glyphs and stays anchored when translation moves", () => {
    const mask = createCodexEraseMask(region, size);
    expect(mask.bounds).toEqual({ x: 10, y: 10, w: 10, h: 10 });
    expect(Array.from(mask.data.slice(0, 10))).toEqual([
      1, 1, 1, 0, 0, 0, 0, 1, 1, 1,
    ]);
    expect(
      createCodexEraseMask({ ...region, renderBbox: sourceBbox }, size),
    ).toEqual(mask);
  });

  it("rejects removal intersecting a protected standalone number", () => {
    const keep = {
      ...region,
      id: "number",
      action: "keep" as const,
      sourceText: "97",
    };
    expect(() => createCodexEraseMask(region, size, [keep])).toThrow("보존");
    expect(() =>
      createCodexEraseMask(region, size, [
        { ...keep, sourceBbox: { x: 130, y: 100, w: 40, h: 100 } },
      ]),
    ).not.toThrow();
  });

  it("refuses empty or degenerate removal geometry", () => {
    expect(() =>
      createCodexEraseMask({ ...region, erasePolygons: [] }, size),
    ).toThrow("외곽");
    expect(() =>
      createCodexEraseMask(
        {
          ...region,
          erasePolygons: [
            [
              { x: 0, y: 0 },
              { x: 500, y: 0 },
              { x: 1000, y: 0 },
            ],
          ],
        },
        size,
      ),
    ).toThrow("외곽");
  });

  it("composites only permission pixels even when the generated rectangle changes everywhere", () => {
    const base = { width: 10, height: 10, data: new Uint8Array(400).fill(71) };
    const generated = { ...base, data: new Uint8Array(400).fill(255) };
    const mask = createCodexEraseMask(region, size);
    compositeRegisteredPatch(
      base,
      generated,
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 0, y: 0 },
      { dx: 0, dy: 0, scale: 1 },
      mask.data,
    );
    for (let index = 0; index < 100; index++)
      expect(base.data[index * 4]).toBe(mask.data[index] ? 255 : 71);
  });
});
