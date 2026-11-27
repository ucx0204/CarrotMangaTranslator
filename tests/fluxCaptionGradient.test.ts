import { describe, expect, it } from "vitest";
import { restoreVerifiedFluxCaptionGradient } from "../src/main/inpainting/fluxCaptionGradient";

function caption(across = true, lightInk = false) {
  const width = 48,
    height = 44;
  const bounds = { x: 4, y: 6, w: 36, h: 32 };
  const mask = { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
  const core = {
    bounds: { x: 14, y: 14, w: 12, h: 14 },
    data: new Uint8Array(168).fill(1),
  };
  const source = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < bounds.h; y++)
    for (let x = 0; x < bounds.w; x++) {
      const at = 4 * ((bounds.y + y) * width + bounds.x + x),
        level = lightInk
          ? 160 - (across ? x : y) * 2
          : 100 + (across ? x : y) * 2;
      source.fill(level, at, at + 3);
    }
  const clean = Buffer.from(source);
  for (let y = 15; y < 26; y++)
    for (let x = 16; x < 19; x++) {
      const at = (y * width + x) * 4;
      source.fill(lightInk ? 250 : 15, at, at + 3);
    }
  const generated = Buffer.alloc(width * height * 4, 42);
  for (let i = 3; i < generated.length; i += 4) generated[i] = 255;
  return {
    input: {
      source,
      generated,
      width,
      crop: { x: 0, y: 0, w: width, h: height },
    },
    mask,
    core,
    clean,
  };
}

describe("verified FLUX caption gradients", () => {
  it.each([
    [true, false],
    [false, true],
  ])(
    "restores printed ink only with measured paper on both sides",
    (across, lightInk) => {
      const { input, mask, core, clean } = caption(across, lightInk);
      restoreVerifiedFluxCaptionGradient(input, mask, core);
      for (let y = 0; y < 44; y++)
        for (let x = 0; x < 48; x++) {
          const at = (y * 48 + x) * 4,
            inside = x >= 4 && x < 40 && y >= 6 && y < 38;
          expect(input.generated[at]).toBe(inside ? clean[at] : 42);
          expect(input.generated[at + 3]).toBe(255);
        }
      const tile = { x: 17, y: 20, w: 5, h: 5 };
      const generated = Buffer.alloc(100, 255);
      restoreVerifiedFluxCaptionGradient(
        { ...input, crop: tile, generated },
        mask,
        core,
      );
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 5; x++)
          expect(generated[(5 * y + x) * 4]).toBe(
            clean[((y + 20) * 48 + x + 17) * 4],
          );
    },
  );
  it("keeps the model result if the ramp has an outline, holes, coloured or translucent art, or mixed ink", () => {
    for (const flaw of [
      "outline",
      "hole",
      "colour",
      "alpha",
      "mixed-ink",
      "ruled",
      "empty",
      "edge",
    ]) {
      const { input, core, mask, clean } = caption();
      const at = (13 * 48 + 22) * 4;
      if (flaw === "outline") input.source.fill(15, at, at + 3);
      if (flaw === "hole") mask.data[100] = 0;
      if (flaw === "colour") input.source[at + 2] = 200;
      if (flaw === "alpha") input.source[at + 3] = 128;
      if (flaw === "mixed-ink")
        input.source.fill(244, (18 * 48 + 20) * 4, (18 * 48 + 20) * 4 + 3);
      if (flaw === "ruled")
        input.source.fill(55, (6 * 48 + 18) * 4, (6 * 48 + 18) * 4 + 3);
      if (flaw === "empty") clean.copy(input.source);
      if (flaw === "edge") core.bounds.x = 4;
      restoreVerifiedFluxCaptionGradient(input, mask, core);
      expect(
        input.generated.every((v, i) => v === (i % 4 === 3 ? 255 : 42)),
        flaw,
      ).toBe(true);
    }
  });
});
