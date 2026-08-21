import { describe, expect, it } from "vitest";
import { normalizeTranslationBlockPatch } from "../src/renderer/src/hooks/useUpdateSelectedBlockAction";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("translation block patch geometry", () => {
  it("repositions an off-page render box when rotation would hide it", () => {
    const block = makeBlock({
      renderBbox: { x: 992, y: 400, w: 100, h: 10 },
      renderBboxSpace: "normalized_1000",
    });
    const next = normalizeTranslationBlockPatch(
      block,
      { rotationDeg: 90 },
      { width: 1000, height: 1000 },
    );

    expect(next.bbox).toEqual(block.bbox);
    expect(next.rotationDeg).toBe(90);
    expect(next.renderBbox).toEqual({ x: 947, y: 400, w: 100, h: 10 });
  });

  it("does not create render geometry for an already visible rotation", () => {
    const block = makeBlock();
    const next = normalizeTranslationBlockPatch(
      block,
      { rotationDeg: 45 },
      { width: 1000, height: 1000 },
    );

    expect(next.rotationDeg).toBe(45);
    expect(next.renderBbox).toBeUndefined();
  });

  it("clears a Gemma advisory only for an explicit selected-block direction edit", () => {
    const block = makeBlock({ layoutIntent: "vertical" });
    const directionEdited = normalizeTranslationBlockPatch(block, {
      renderDirection: "horizontal",
    });
    const unrelatedEdit = normalizeTranslationBlockPatch(block, {
      fontSizePx: 30,
    });

    expect(directionEdited.renderDirection).toBe("horizontal");
    expect(directionEdited).not.toHaveProperty("layoutIntent");
    expect(directionEdited.layoutIntentSuppressed).toBe(true);
    expect(unrelatedEdit.layoutIntent).toBe("vertical");
    expect(unrelatedEdit.layoutIntentSuppressed).toBeUndefined();
  });

  it("persists ownership when the user confirms the already-rendered direction", () => {
    const block = makeBlock();
    const confirmed = normalizeTranslationBlockPatch(block, {
      renderDirection: "horizontal",
    });

    expect(confirmed).not.toBe(block);
    expect(confirmed.renderDirection).toBe("horizontal");
    expect(confirmed.layoutIntentSuppressed).toBe(true);
  });
});

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "原文",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}
