import { describe, expect, it } from "vitest";
import { resolveCompletionAfterBlockMutation } from "../src/main/libraryStore/translationCompletionInvalidation";
import type { TranslationBlock } from "../src/shared/textTypes";

const COMPLETED_ERASE = {
  workflow: "erase-original" as const,
  status: "completed" as const,
};

describe("translation completion invalidation", () => {
  it("invalidates a completed receipt when a source target is added", () => {
    const block = makeBlock("block-1");

    expect(
      resolveCompletionAfterBlockMutation(
        COMPLETED_ERASE,
        [block],
        [block, makeBlock("block-2")],
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("invalidates a completed receipt when a source box moves", () => {
    const block = makeBlock("block-1");

    expect(
      resolveCompletionAfterBlockMutation(
        COMPLETED_ERASE,
        [block],
        [{ ...block, bbox: { ...block.bbox, x: 300 } }],
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("clears partial erased block ids when source target state changes", () => {
    const block = makeBlock("block-1");

    expect(
      resolveCompletionAfterBlockMutation(
        {
          workflow: "erase-original",
          status: "pending",
          erasedBlockIds: [block.id],
        },
        [block],
        [{ ...block, bbox: { ...block.bbox, x: 300 } }],
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("keeps erase completion for a translation-text-only edit", () => {
    const block = makeBlock("block-1");

    expect(
      resolveCompletionAfterBlockMutation(
        COMPLETED_ERASE,
        [block],
        [{ ...block, translatedText: "manual edit" }],
      ),
    ).toEqual(COMPLETED_ERASE);
  });
});

function makeBlock(id: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#ffffff",
    backgroundColor: "transparent",
    opacity: 1,
  };
}
