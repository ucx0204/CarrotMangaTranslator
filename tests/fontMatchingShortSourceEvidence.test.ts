import { describe, expect, it } from "vitest";
import { makePixelWinnerInference } from "./helpers/automaticFontMatchingV2Fixtures";
import {
  inferFontExpressionPage,
  loadFontExpressionModel,
} from "../src/main/pipeline/fontMatchingExpressionRuntime";
import {
  inferFontTexturePage,
  loadFontTextureModel,
} from "../src/main/pipeline/fontMatchingTextureRuntime";
import { resolveAutomaticFontExpression } from "../src/main/pipeline/automaticFontMatchingExpression";
import type { FontMatchingPageInferenceBlock } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";

describe("single-component source evidence", () => {
  it("keeps a short non-prose region in both analyses without accepting a font from that evidence alone", async () => {
    const raster = {
      width: 64,
      height: 64,
      bgra: new Uint8Array(64 * 64 * 4).fill(255),
    };
    for (let y = 20; y < 44; y++)
      for (let x = 20; x < 44; x++) {
        const offset = (y * 64 + x) * 4;
        raster.bgra.fill(0, offset, offset + 3);
      }
    const block: FontMatchingPageInferenceBlock = {
      blockId: "short",
      item: {
        id: 1,
        type: "nonsolid",
        direction: "horizontal",
        fontRole: "sfx_motion",
        bbox: { x: 0, y: 0, w: 1000, h: 1000 },
        jp: "口",
        ko: "소리",
      },
    };
    const row = makePixelWinnerInference("nanum-myeongjo", block.blockId);
    const expression = await loadFontExpressionModel();
    try {
      const texture = await loadFontTextureModel();
      try {
        const options = {
          blocks: [block],
          rows: new Map([[block.blockId, row]]),
          raster,
        };
        const expressive = await inferFontExpressionPage({
          ...options,
          session: expression,
        });
        const textured = await inferFontTexturePage({
          ...options,
          rows: expressive,
          session: texture,
        });
        const actual = textured.get(block.blockId);
        expect(actual?.sourceExpression?.componentCount).toBe(1);
        expect(actual?.sourceTexture?.patchCount).toBe(1);
        expect(
          actual?.sourceExpression?.probabilities.every(Number.isFinite),
        ).toBe(true);
        expect(
          actual?.sourceTexture?.probabilities.every(Number.isFinite),
        ).toBe(true);
        expect(actual?.crossScriptProxy).toBeUndefined();
        expect(resolveAutomaticFontExpression(actual ?? null, [])).toBeNull();
      } finally {
        await texture.release();
      }
    } finally {
      await expression.release();
    }
  });
});
