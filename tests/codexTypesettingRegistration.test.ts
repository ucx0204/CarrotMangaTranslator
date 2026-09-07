import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  compositeRegisteredPatch,
  registerTypesettingPatch,
} from "../src/main/pipeline/codexTypesettingRegistration";

const erase = { x: 43, y: 34, w: 38, h: 47 };

function drawing(dx = 0, dy = 0, scale = 1) {
  const image = new PNG({ width: 128, height: 112 });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sx = (x - 63.5 - dx) / scale + 63.5;
      const sy = (y - 55.5 - dy) / scale + 55.5;
      const diagonal = Math.abs(sx + sy * 0.71 - 81);
      const other = Math.abs(sx * 0.2 - sy + 31);
      const circle = Math.abs(Math.hypot(sx - 91, sy - 73) - 22);
      const ink = Math.max(
        0,
        Math.min(1, 2 - Math.min(diagonal, other, circle)),
      );
      const at = (y * image.width + x) * 4;
      image.data.fill(Math.round(255 * (1 - ink)), at, at + 3);
      image.data[at + 3] = 255;
    }
  }
  return image;
}

describe("generated background registration", () => {
  it("rejects drift at internal mask gaps that passes the old rectangular boundary", () => {
    const source = drawing();
    const generated = drawing();
    const permission = new Uint8Array(128 * 112);
    for (let y = 34; y < 81; y++) {
      for (let x = 43; x < 81; x++) {
        if (x < 55 || x >= 70) permission[y * 128 + x] = 1;
        else if (y > 40 && y < 75)
          generated.data.fill(0, (y * 128 + x) * 4, (y * 128 + x) * 4 + 3);
      }
    }
    expect(registerTypesettingPatch(source, generated, erase).accepted).toBe(
      true,
    );
    const result = registerTypesettingPatch(
      source,
      generated,
      erase,
      permission,
    );
    expect(result.accepted).toBe(false);
    expect(result.maskBoundary?.worst).toBeGreaterThan(0.12);
    expect(result.contextErrorAfter).toBe(0);
  });

  it("accepts matching real mask boundaries after authorized lettering removal and preserves every unmasked pixel", () => {
    const source = drawing();
    const generated = drawing();
    const permission = new Uint8Array(128 * 112);
    for (let y = 40; y < 65; y++)
      for (let x = 48; x < 58; x++) {
        permission[y * 128 + x] = 1;
        source.data.fill(0, (y * 128 + x) * 4, (y * 128 + x) * 4 + 3);
      }
    const result = registerTypesettingPatch(
      source,
      generated,
      erase,
      permission,
    );
    expect(result.accepted).toBe(true);
    expect(result.maskBoundary?.mean).toBe(0);
    const before = Buffer.from(source.data);
    compositeRegisteredPatch(
      source,
      generated,
      erase,
      { x: 0, y: 0 },
      result.transform,
      permission,
    );
    for (let at = 0; at < permission.length; at++) {
      expect(source.data.subarray(at * 4, at * 4 + 4)).toEqual(
        (permission[at] ? generated.data : before).subarray(at * 4, at * 4 + 4),
      );
    }
  });

  it("rejects malformed or unverifiable masks", () => {
    expect(() =>
      registerTypesettingPatch(drawing(), drawing(), erase, new Uint8Array(2)),
    ).toThrow("마스크");
    for (const fill of [0, 1])
      expect(
        registerTypesettingPatch(
          drawing(),
          drawing(),
          erase,
          new Uint8Array(128 * 112).fill(fill),
        ).accepted,
      ).toBe(false);
    expect(() =>
      registerTypesettingPatch(
        drawing(),
        new PNG({ width: 1, height: 1 }),
        erase,
      ),
    ).toThrow("해상도");
  });
  it("recovers a shifted/scaled drawing using context outside the edited region", () => {
    const source = drawing();
    const generated = drawing(3, -2, 1.01);
    // Original lettering is intentionally absent from the generated background.
    for (let y = 43; y < 60; y++) {
      for (let x = 53; x < 63; x++)
        source.data.fill(0, (y * 128 + x) * 4, (y * 128 + x) * 4 + 3);
    }
    const result = registerTypesettingPatch(source, generated, erase);
    expect(result.accepted).toBe(true);
    expect(result.transform.dx).toBeCloseTo(3, 0);
    expect(result.transform.dy).toBeCloseTo(-2, 0);
    expect(result.transform.scale).toBeCloseTo(1.01, 2);
    expect(result.contextErrorAfter).toBeLessThan(
      result.contextErrorBefore / 4,
    );
  });

  it("rejects locally redrawn boundary lines even when most context is identical", () => {
    const source = drawing();
    const generated = drawing();
    for (let y = 29; y < 84; y++) {
      for (let x = 36; x < 43; x++)
        generated.data.fill(0, (y * 128 + x) * 4, (y * 128 + x) * 4 + 3);
    }
    const result = registerTypesettingPatch(source, generated, erase);
    expect(result.accepted).toBe(false);
    expect(result.boundary.worst).toBeGreaterThan(0.12);
  });

  it("preserves every pixel outside the permitted source coordinates", () => {
    const source = drawing();
    const generated = drawing(3, -2);
    const before = Buffer.from(source.data);
    compositeRegisteredPatch(
      source,
      generated,
      erase,
      { x: 0, y: 0 },
      { dx: 3, dy: -2, scale: 1 },
    );
    for (let y = 0; y < 112; y++) {
      for (let x = 0; x < 128; x++) {
        if (x >= 43 && x < 81 && y >= 34 && y < 81) continue;
        const offset = (y * 128 + x) * 4;
        expect(source.data.subarray(offset, offset + 4)).toEqual(
          before.subarray(offset, offset + 4),
        );
      }
    }
  });

  it("fails closed when no unedited context is available", () => {
    expect(
      registerTypesettingPatch(drawing(), drawing(), {
        x: 0,
        y: 0,
        w: 128,
        h: 112,
      }).accepted,
    ).toBe(false);
  });
});

it.each([
  { x: 0, y: 0, w: 60, h: 50 },
  { x: 70, y: 0, w: 58, h: 50 },
  { x: 0, y: 60, w: 60, h: 52 },
  { x: 70, y: 60, w: 58, h: 52 },
])(
  "constrains alignment to preserve complete coverage for clipped edge %j",
  (edge) => {
    const source = drawing();
    const generated = drawing(-3, -2, 0.985);
    const fit = registerTypesettingPatch(source, generated, edge);
    expect(fit.supported).toBe(true);
    expect(fit.opaque).toBe(true);
    const before = Buffer.from(source.data);
    compositeRegisteredPatch(
      source,
      generated,
      edge,
      { x: 0, y: 0 },
      fit.transform,
    );
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++)
        if (
          x < edge.x ||
          x >= edge.x + edge.w ||
          y < edge.y ||
          y >= edge.y + edge.h
        ) {
          const offset = (y * source.width + x) * 4;
          expect(source.data.subarray(offset, offset + 4)).toEqual(
            before.subarray(offset, offset + 4),
          );
        }
  },
);
