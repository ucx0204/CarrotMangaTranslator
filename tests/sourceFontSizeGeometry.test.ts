import { describe, expect, it } from "vitest";
import { estimateSourceFontFace } from "../src/main/pipeline/sourceFontSizeGeometry";
import { measureComponentAffinity } from "../src/main/pipeline/sourceFontSizeComponentAffinity";
import { measureMajorAxisPitch } from "../src/main/pipeline/sourceFontSizeMajorPitch";
import type { SourceFontCoreMask } from "../src/main/pipeline/sourceFontSizeRaster";

describe("source font-size projection geometry", () => {
  it("rejects impossible glyph counts and an empty foreground mask", () => {
    const regularCore = createCore(
      46,
      168,
      (set) => fillRect(set, 13, 4, 20, 18),
      1,
    );
    const emptyCore = createCore(46, 168, () => undefined, 0);

    expect(estimateSourceFontFace(regularCore, "vertical", 1)).toBeNull();
    expect(estimateSourceFontFace(regularCore, "vertical", 161)).toBeNull();
    expect(estimateSourceFontFace(emptyCore, "vertical", 7)).toBeNull();
  });

  it("recovers three vertical columns despite a joined run and tiny edge fragment", () => {
    const core = createCore(
      105,
      189,
      (set) => {
        for (const left of [5, 35, 65]) {
          for (let glyph = 0; glyph < 5; glyph += 1) {
            fillRect(set, left, 5 + glyph * 36, 20, 24);
          }
        }
        // A thin bridge makes the second and third columns one binary run.
        fillRect(set, 55, 92, 10, 1);
        // Four low-mass pixels look like a separate fourth line to a binary run
        // detector, matching the real Hayai merged-region failure shape.
        fillRect(set, 101, 184, 4, 1);
      },
      15,
    );

    const estimate = estimateSourceFontFace(core, "vertical", 15);

    expect(estimate).not.toBeNull();
    expect(estimate?.facePx).toBeGreaterThan(19);
    expect(estimate?.facePx).toBeLessThan(25);
  });

  it("trims sparse side satellites without turning them into the font face", () => {
    const core = createCore(
      119,
      193,
      (set) => {
        for (const left of [10, 48, 86]) {
          for (let glyph = 0; glyph < 5; glyph += 1) {
            fillRect(set, left, 5 + glyph * 37, 20, 25);
          }
        }
        // Ruby-like satellites and crop residue broaden two bands but contain
        // much less projection mass than the repeated main glyph column.
        for (let glyph = 0; glyph < 3; glyph += 1) {
          fillRect(set, 3, 12 + glyph * 55, 5, 8);
          fillRect(set, 108, 20 + glyph * 54, 5, 8);
        }
      },
      15,
    );

    const estimate = estimateSourceFontFace(core, "vertical", 15);

    expect(estimate).not.toBeNull();
    expect(estimate?.facePx).toBeGreaterThan(19);
    expect(estimate?.facePx).toBeLessThan(27);
  });

  it("keeps a single body column measurable in a very narrow tall crop", () => {
    const core = createCore(
      46,
      168,
      (set) => {
        for (let glyph = 0; glyph < 7; glyph += 1) {
          fillRect(set, 13, 4 + glyph * 23, 20, 18);
        }
      },
      7,
    );

    const estimate = estimateSourceFontFace(core, "vertical", 7);

    expect(estimate).not.toBeNull();
    expect(estimate?.facePx).toBeGreaterThan(18);
    expect(estimate?.facePx).toBeLessThan(23);
  });

  it("records ruby as a secondary component scale instead of mixing it into body", () => {
    const core = createCore(
      119,
      193,
      (set) => {
        for (const left of [10, 48, 86]) {
          for (let glyph = 0; glyph < 5; glyph += 1) {
            fillRect(set, left, 5 + glyph * 37, 20, 25);
          }
        }
        for (let glyph = 0; glyph < 3; glyph += 1) {
          fillRect(set, 3, 12 + glyph * 55, 5, 8);
          fillRect(set, 108, 20 + glyph * 54, 5, 8);
        }
      },
      21,
    );

    const measurement = measureComponentAffinity(core, "vertical", 3);

    expect(measurement).not.toBeNull();
    expect(measurement?.primaryFace).toBeGreaterThan(19);
    expect(measurement?.primaryFace).toBeLessThan(22);
    expect(measurement?.secondaryFace).toBeGreaterThanOrEqual(5);
    expect(measurement?.secondaryFace).toBeLessThan(9);
  });

  it("blends a compatible component-affinity face into projection", () => {
    const core = createCore(
      105,
      189,
      (set) => {
        for (const left of [5, 35, 65]) {
          for (let glyph = 0; glyph < 5; glyph += 1) {
            fillRect(set, left, 5 + glyph * 36, 20, 24);
          }
        }
      },
      15,
    );

    const projection = estimateSourceFontFace(core, "vertical", 15);
    const componentBlend = estimateSourceFontFace(core, "vertical", 15, {
      componentAffinity: true,
    });

    expect(componentBlend).not.toBeNull();
    expect(componentBlend?.facePx).toBeGreaterThan(19);
    expect(componentBlend?.facePx).toBeLessThan(25);
    expect(componentBlend?.confidence).toBeGreaterThanOrEqual(
      projection?.confidence ?? 0,
    );
  });

  it("measures visible face from repeated writing-axis glyph runs", () => {
    const core = createCore(
      73,
      225,
      (set) => {
        for (let glyph = 0; glyph < 8; glyph += 1) {
          fillRect(set, 26, 14 + glyph * 25, 20, 20);
        }
      },
      8,
    );

    const measurement = measureMajorAxisPitch(core, "vertical", 8, 1);

    expect(measurement).not.toBeNull();
    expect(measurement?.face).toBeGreaterThan(19);
    expect(measurement?.face).toBeLessThan(21);
  });

  it("recovers a long single column only when three geometry views agree", () => {
    const core = createCore(
      73,
      225,
      (set) => {
        for (let glyph = 0; glyph < 8; glyph += 1) {
          fillRect(set, 26, 14 + glyph * 25, 20, 20);
        }
      },
      8,
    );

    const projection = estimateSourceFontFace(core, "vertical", 8);
    const consensus = estimateSourceFontFace(core, "vertical", 8, {
      geometryConsensus: true,
    });

    expect(projection).toBeNull();
    expect(consensus).not.toBeNull();
    expect(consensus?.facePx).toBeGreaterThan(19);
    expect(consensus?.facePx).toBeLessThan(22);
  });

  it("does not infer a writing-axis consensus from short text", () => {
    const core = createCore(
      73,
      225,
      (set) => {
        for (let glyph = 0; glyph < 7; glyph += 1) {
          fillRect(set, 26, 18 + glyph * 27, 20, 20);
        }
      },
      7,
    );

    const projection = estimateSourceFontFace(core, "vertical", 7);
    const consensus = estimateSourceFontFace(core, "vertical", 7, {
      geometryConsensus: true,
    });

    expect(consensus).toEqual(projection);
  });
});

function createCore(
  width: number,
  height: number,
  draw: (set: (x: number, y: number) => void) => void,
  componentCount: number,
): SourceFontCoreMask {
  const mask = new Uint8Array(width * height);
  let foreground = 0;
  draw((x, y) => {
    const offset = y * width + x;
    if (mask[offset]) return;
    mask[offset] = 1;
    foreground += 1;
  });
  return {
    componentCount,
    foregroundRatio: foreground / (width * height),
    height,
    mask,
    width,
  };
}

function fillRect(
  set: (x: number, y: number) => void,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) set(x, y);
  }
}
