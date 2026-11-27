import { describe, expect, it } from "vitest";
import { restoreFluxFlatBackground } from "../src/main/inpainting/fluxFlatBackground";

function fixture(value = 255) {
  const width = 60,
    height = 60;
  const source = Buffer.alloc(width * height * 4, value);
  const generated = Buffer.alloc(source.length, 120);
  const constraint = {
    bounds: { x: 20, y: 20, w: 20, h: 20 },
    data: new Uint8Array(400).fill(1),
  };
  for (let i = 0; i < width * height; i++) source[i * 4 + 3] = 77;
  for (let y = 24; y < 36; y++)
    for (let x = 24; x < 36; x++) {
      for (let channel = 0; channel < 3; channel++)
        source[(y * width + x) * 4 + channel] = 255 - value;
    }
  return {
    source,
    generated,
    constraint,
    width,
    height,
    crop: { x: 0, y: 0, w: width, h: height },
  };
}

describe("FLUX flat background correction", () => {
  function outlinedBubble(color = [255, 255, 255]) {
    const f = fixture();
    for (let i = 0; i < f.width * f.height; i++)
      for (let c = 0; c < 3; c++) f.source[i * 4 + c] = color[c];
    // The erasure boundary abuts an inked frame; its outside ring is not paper.
    for (let y = 19; y <= 40; y++)
      for (const x of [19, 40])
        f.source.fill(0, (y * f.width + x) * 4, (y * f.width + x) * 4 + 3);
    const core = {
      bounds: { x: 27, y: 27, w: 6, h: 6 },
      data: new Uint8Array(36).fill(1),
    };
    for (let y = 27; y < 33; y++)
      for (let x = 27; x < 33; x++)
        f.source.fill(128, (y * f.width + x) * 4, (y * f.width + x) * 4 + 3);
    return { ...f, speechBubble: true, core };
  }

  it.each([
    [255, 255, 255],
    [0, 0, 0],
    [240, 225, 180],
  ])(
    "restores framed balloon paper (%i,%i,%i) without changing source, alpha or exterior",
    (r, g, b) => {
      const f = outlinedBubble([r, g, b]);
      const source = Buffer.from(f.source);
      restoreFluxFlatBackground(f);
      expect([
        ...f.generated.subarray((30 * 60 + 30) * 4, (30 * 60 + 30) * 4 + 4),
      ]).toEqual([r, g, b, 120]);
      expect(f.generated[(30 * 60 + 19) * 4]).toBe(120);
      expect(f.source).toEqual(source);
    },
  );

  it("requires detected balloon semantics and an independently owned text core", () => {
    for (const overrides of [{ speechBubble: false }, { core: undefined }]) {
      const f = { ...outlinedBubble(), ...overrides };
      const before = Buffer.from(f.generated);
      restoreFluxFlatBackground(f);
      expect(f.generated).toEqual(before);
    }
  });

  it("restores the verified interior of a caption surrounded by a different solid colour", () => {
    for (const paper of [18, 241]) {
      const f = outlinedBubble([paper, paper, paper]);
      for (let i = 3; i < f.generated.length; i += 4) f.generated[i] = 255;
      for (let y = 0; y < f.height; y++)
        for (let x = 0; x < f.width; x++)
          if (x < 20 || x >= 40 || y < 20 || y >= 40)
            f.source.fill(
              255 - paper,
              (y * f.width + x) * 4,
              (y * f.width + x) * 4 + 3,
            );
      const context = Buffer.from(f.generated);
      restoreFluxFlatBackground({ ...f, nativeFlux: true }, context);
      const center = (30 * f.width + 30) * 4;
      expect([...f.generated.subarray(center, center + 4)]).toEqual([
        paper,
        paper,
        paper,
        255,
      ]);
      expect(context[center]).toBe(255 - paper);
      expect(f.generated[0]).toBe(120);
      // The same uniform surrounding panel is not evidence for removing interior artwork.
      f.source[(26 * f.width + 30) * 4] = 255 - paper;
      for (let i = 0; i < f.generated.length; i += 4)
        f.generated.fill(120, i, i + 3);
      restoreFluxFlatBackground({ ...f, nativeFlux: true }, context);
      expect(f.generated[center]).toBe(120);
    }
  });

  it("refuses patterned or gradient balloon interiors even with flat exterior strips", () => {
    for (const pattern of ["tone", "gradient"]) {
      const f = outlinedBubble();
      for (let y = 20; y < 40; y++)
        for (let x = 20; x < 40; x++) {
          const value = pattern === "tone" ? (x % 2 ? 255 : 100) : 100 + x * 3;
          f.source[(y * f.width + x) * 4] = value;
        }
      const before = Buffer.from(f.generated);
      restoreFluxFlatBackground(f);
      expect(f.generated).toEqual(before);
    }
  });

  it("recovers a verified gray caption ramp in the final FLUX image while retaining the worker context", () => {
    const f = outlinedBubble();
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const at = (y * f.width + x) * 4;
        const inside = x >= 20 && x < 40 && y >= 20 && y < 40;
        const ink = x >= 28 && x < 31 && y >= 28 && y < 32;
        const value = ink ? 13 : inside ? 150 + (x - 20) * 3 : 29;
        f.source.fill(value, at, at + 3);
        f.source[at + 3] = 255;
        f.generated[at + 3] = 255;
      }
    const context = Buffer.from(f.generated);
    restoreFluxFlatBackground({ ...f, nativeFlux: true }, context);
    expect(f.generated[(30 * f.width + 29) * 4]).toBe(177);
    expect(context[(30 * f.width + 29) * 4]).toBe(29);
    expect(f.generated[(19 * f.width + 29) * 4]).toBe(120);
  });

  it("rejects one-sided interior evidence", () => {
    const f = outlinedBubble();
    f.core = {
      bounds: f.constraint.bounds,
      data: Uint8Array.from({ length: 400 }, (_, i) => (i % 20 < 10 ? 1 : 0)),
    };
    const before = Buffer.from(f.generated);
    restoreFluxFlatBackground(f);
    expect(f.generated).toEqual(before);
  });

  it("keeps non-text artwork inside a flat rim instead of filling the whole balloon", () => {
    const f = outlinedBubble();
    // This mark lies deeper than the sampled rim and outside the text core.
    f.source[(26 * f.width + 30) * 4] = 0;
    const before = Buffer.from(f.generated);
    restoreFluxFlatBackground(f);
    expect(f.generated).toEqual(before);
  });

  it("recovers a small balloon when its owned core includes the paper rim", () => {
    const f = outlinedBubble();
    f.core = { ...f.constraint, data: new Uint8Array(400).fill(1) };
    restoreFluxFlatBackground(f);
    expect(f.generated[(30 * 60 + 30) * 4]).toBe(255);
    expect(f.generated[(30 * 60 + 19) * 4]).toBe(120);
  });

  it("preserves holes when an almost fully owned balloon has a flat paper rim", () => {
    const f = outlinedBubble();
    f.constraint.data[2 * 20 + 2] = 0;
    f.core = { ...f.constraint, data: new Uint8Array(400).fill(1) };
    restoreFluxFlatBackground(f);
    expect(f.generated[(22 * 60 + 22) * 4]).toBe(120);
    expect(f.generated[(30 * 60 + 30) * 4]).toBe(255);
  });

  it("vetoes unowned deep artwork even when the core owns almost all the paper", () => {
    const f = outlinedBubble();
    const data = new Uint8Array(400).fill(1);
    data[0] = 0;
    data[6 * 20 + 10] = 0;
    f.core = { ...f.constraint, data };
    f.source[(26 * 60 + 30) * 4] = 0;
    const before = Buffer.from(f.generated);
    restoreFluxFlatBackground(f);
    expect(f.generated).toEqual(before);
  });

  it("keeps tiny edge-clipped balloons without enough rim evidence unchanged", () => {
    const f = outlinedBubble();
    f.constraint = {
      bounds: { x: 0, y: 20, w: 4, h: 4 },
      data: new Uint8Array(16).fill(1),
    };
    f.core = f.constraint;
    const before = Buffer.from(f.generated);
    restoreFluxFlatBackground(f);
    expect(f.generated).toEqual(before);
  });

  it("rejects a fully owned interior without dominant paper or with an inked rim", () => {
    for (const rim of [true, false]) {
      const f = outlinedBubble();
      f.core = { ...f.constraint, data: new Uint8Array(400).fill(1) };
      for (let y = rim ? 22 : 24; y < (rim ? 23 : 36); y++)
        for (let x = rim ? 22 : 24; x < (rim ? 23 : 36); x++)
          f.source[(y * 60 + x) * 4] = 0;
      const before = Buffer.from(f.generated);
      restoreFluxFlatBackground(f);
      expect(f.generated).toEqual(before);
    }
  });

  it.each([0, 255])(
    "restores uniform %i paper instead of generated clouds; keeps mask exterior and alpha",
    (value) => {
      const f = fixture(value),
        before = Buffer.from(f.source);
      restoreFluxFlatBackground(f);
      expect(f.source).toEqual(before);
      expect([
        ...f.generated.subarray((30 * 60 + 30) * 4, (30 * 60 + 30) * 4 + 4),
      ]).toEqual([value, value, value, 120]);
      expect(f.generated[0]).toBe(120);
    },
  );
  it("keeps textured, gradient, colored-edge and border-crossing regions with FLUX", () => {
    for (const channel of [0, 1, 2]) {
      const f = fixture();
      for (let y = 0; y < f.height; y++)
        for (let x = 0; x < f.width; x++)
          f.source[(y * f.width + x) * 4 + channel] = x % 2 ? 255 : 0;
      const before = Buffer.from(f.generated);
      restoreFluxFlatBackground(f);
      expect(f.generated).toEqual(before);
    }
    const f = fixture();
    f.constraint.bounds.x = 0;
    const before = Buffer.from(f.generated);
    restoreFluxFlatBackground(f);
    expect(f.generated).toEqual(before);
  });
  it("does not paint holes, adjacent art or outside a tile", () => {
    const f = fixture();
    f.constraint.data[10 * 20 + 10] = 0;
    f.source.fill(255, (30 * 60 + 30) * 4, (30 * 60 + 30) * 4 + 3);
    restoreFluxFlatBackground(f);
    expect(f.generated[(30 * 60 + 30) * 4]).toBe(120);
    const tile = fixture();
    tile.crop = { x: 25, y: 25, w: 10, h: 10 };
    tile.generated = Buffer.alloc(400, 120);
    restoreFluxFlatBackground(tile);
    expect(tile.generated.length).toBe(400);
    expect(tile.generated[0]).toBe(255);
  });
  it("does nothing without an explicit final constraint", () => {
    const f = fixture(),
      before = Buffer.from(f.generated);
    restoreFluxFlatBackground({ ...f, constraint: null });
    expect(f.generated).toEqual(before);
  });
});
