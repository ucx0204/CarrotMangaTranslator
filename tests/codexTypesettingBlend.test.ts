import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  createCodexBackgroundBlend,
  codexBackgroundSupportRect,
} from "../src/shared/codexTypesettingBlend";
import { compositeRegisteredPatch } from "../src/main/pipeline/codexTypesettingRegistration";
import type { CodexPageRegion } from "../src/shared/codexTypesettingTypes";
import { createCodexEraseMask } from "../src/shared/codexTypesettingMask";

const page = { width: 1000, height: 1000 };
const region: CodexPageRegion = {
  id: "word",
  action: "text",
  sourceText: "ギロ",
  translatedText: "찌릿",
  sourceBbox: { x: 400, y: 400, w: 40, h: 40 },
  renderBbox: { x: 400, y: 400, w: 40, h: 40 },
  background: "artwork",
  role: "sound",
  direction: "horizontal",
  reason: "outlined word",
  erasePolygons: [
    [
      { x: 0, y: 0 },
      { x: 250, y: 0 },
      { x: 250, y: 1000 },
      { x: 0, y: 1000 },
    ],
    [
      { x: 750, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 750, y: 1000 },
    ],
  ],
};

describe("complete source core and outer feather", () => {
  it("fully replaces gaps and source outlines, blends only beyond core, and preserves every pixel outside support", () => {
    const blend = createCodexBackgroundBlend(region, page, []),
      b = blend.bounds;
    const original = new PNG({ width: b.w, height: b.h });
    original.data.fill(200);
    const generated = new PNG({ width: b.w, height: b.h });
    generated.data.fill(0);
    for (let i = 3; i < original.data.length; i += 4) {
      original.data[i] = 255;
      generated.data[i] = 255;
    }
    const permission = Uint8Array.from(blend.data, (value) =>
      Number(value > 0),
    );
    const rect = { x: 0, y: 0, w: b.w, h: b.h };
    compositeRegisteredPatch(
      original,
      generated,
      rect,
      { x: 0, y: 0 },
      { dx: 0, dy: 0, scale: 1 },
      permission,
      blend.data,
    );
    const pixel = (x: number, y: number) =>
      original.data[((y - b.y) * b.w + x - b.x) * 4];
    expect(pixel(420, 420)).toBe(0); // Close glyph dilations meet, keeping their outlines opaque.
    expect(pixel(449, 420)).toBe(0); // Ten pixels past the last original mask pixel.
    expect(pixel(451, 420)).toBe(70); // Outer smoothstep; no source mixing in the core.
    expect(pixel(454, 420)).toBe(200);
    for (let i = 0; i < permission.length; i++)
      if (!permission[i]) expect(original.data[i * 4]).toBe(200);
  });

  it("matches Euclidean contour dilation pixel by pixel and preserves distant gaps inside the source box", () => {
    const separated = {
      ...region,
      sourceBbox: { x: 400, y: 400, w: 80, h: 80 },
      erasePolygons: [
        [
          { x: 0, y: 0 },
          { x: 150, y: 0 },
          { x: 150, y: 100 },
          { x: 0, y: 250 },
        ],
        [
          { x: 850, y: 750 },
          { x: 1000, y: 1000 },
          { x: 850, y: 1000 },
        ],
      ],
    };
    const mask = createCodexEraseMask(separated, page),
      blend = createCodexBackgroundBlend(separated, page, []);
    const seeds = Array.from(mask.data, (value, index) =>
      value
        ? {
            x: mask.bounds.x + (index % mask.bounds.w),
            y: mask.bounds.y + Math.floor(index / mask.bounds.w),
          }
        : null,
    ).filter((point) => point !== null);
    for (let i = 0; i < blend.data.length; i++) {
      const x = blend.bounds.x + (i % blend.bounds.w),
        y = blend.bounds.y + Math.floor(i / blend.bounds.w);
      const distance = Math.min(
        ...seeds.map((point) => Math.hypot(point.x - x, point.y - y)),
      );
      const t = Math.max(
        0,
        Math.min(1, (distance - blend.coreRadius) / blend.featherRadius),
      );
      expect(blend.data[i]).toBeCloseTo(1 - t * t * (3 - 2 * t), 12);
    }
    const at = (440 - blend.bounds.y) * blend.bounds.w + 440 - blend.bounds.x;
    expect(blend.data[at]).toBe(0);
    expect(() =>
      createCodexBackgroundBlend(separated, page, [
        {
          ...region,
          action: "keep",
          id: "gap",
          sourceBbox: { x: 439, y: 439, w: 2, h: 2 },
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a protected mark in the added gap or feather, not just the original glyph masks", () => {
    for (const x of [420, 451])
      expect(() =>
        createCodexBackgroundBlend(region, page, [
          {
            ...region,
            action: "keep",
            id: "protected",
            sourceBbox: { x, y: 418, w: 1, h: 1 },
          },
        ]),
      ).toThrow("보존");
  });

  it("keeps plain restoration exact and clips artwork support at physical page edges", () => {
    expect(
      codexBackgroundSupportRect({ ...region, background: "white" }, page),
    ).toEqual({ x: 400, y: 400, w: 40, h: 40 });
    expect(
      codexBackgroundSupportRect(
        { ...region, sourceBbox: { x: 0, y: 980, w: 30, h: 20 } },
        page,
      ),
    ).toEqual({ x: 0, y: 965, w: 45, h: 35 });
    expect(() =>
      createCodexBackgroundBlend({ ...region, erasePolygons: [] }, page, []),
    ).toThrow("외곽");
  });

  it("preserves legacy binary-one replacement and rejects a mismatched explicit alpha raster", () => {
    const base = new PNG({ width: 2, height: 1 }),
      generated = new PNG({ width: 2, height: 1 });
    base.data.fill(200);
    generated.data.fill(100);
    const rect = { x: 0, y: 0, w: 2, h: 1 },
      transform = { dx: 0, dy: 0, scale: 1 };
    compositeRegisteredPatch(
      base,
      generated,
      rect,
      { x: 0, y: 0 },
      transform,
      new Uint8Array([1, 0]),
    );
    expect([...base.data]).toEqual([100, 100, 100, 100, 200, 200, 200, 200]);
    expect(() =>
      compositeRegisteredPatch(
        base,
        generated,
        rect,
        { x: 0, y: 0 },
        transform,
        undefined,
        new Float64Array(1),
      ),
    ).toThrow("alpha");
  });
});
