import { describe, expect, it } from "vitest";
import {
  assertUniqueTranslationBlockIds,
  normalizeTranslationCompletionReferences,
  remapTranslationCompletionReferences,
} from "../src/main/translationCompletionReferences";
import type { TranslationCompletionReceipt } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("translation completion references", () => {
  it("remaps valid erased block ids in receipt order", () => {
    const current = receipt("pending", ["old-b", "old-a"]);
    const blockIdMap = new Map([
      ["old-a", "new-a"],
      ["old-b", "new-b"],
    ]);

    expect(remapTranslationCompletionReferences(current, blockIdMap)).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["new-b", "new-a"],
    });
    expect(current.erasedBlockIds).toEqual(["old-b", "old-a"]);
  });

  it("supports object-prototype-looking map keys safely", () => {
    const blockIdMap = new Map([
      ["__proto__", "new-proto"],
      ["constructor", "new-constructor"],
      ["toString", "new-to-string"],
    ]);

    expect(
      remapTranslationCompletionReferences(
        receipt("pending", ["__proto__", "constructor", "toString"]),
        blockIdMap,
      ),
    ).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["new-proto", "new-constructor", "new-to-string"],
    });
  });

  it("invalidates an unknown pending reference without partial mapping", () => {
    expect(
      remapTranslationCompletionReferences(
        receipt("pending", ["known", "missing"]),
        new Map([["known", "new-known"]]),
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("invalidates an unknown failed reference back to pending", () => {
    expect(
      remapTranslationCompletionReferences(
        receipt("failed", ["missing"]),
        new Map(),
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("keeps completed status when an unknown completed reference is cleared", () => {
    expect(
      remapTranslationCompletionReferences(
        receipt("completed", ["missing"]),
        new Map(),
      ),
    ).toEqual({ workflow: "erase-original", status: "completed" });
  });

  it("does not create a completion when none exists", () => {
    expect(
      remapTranslationCompletionReferences(undefined, new Map()),
    ).toBeUndefined();
  });

  it("preserves workflow and failed status when erased ids are absent", () => {
    expect(
      remapTranslationCompletionReferences(
        { workflow: "bubble-layout", status: "failed" },
        new Map(),
      ),
    ).toEqual({ workflow: "bubble-layout", status: "failed" });
  });

  it("normalizes an empty erased id list to the optional field being absent", () => {
    expect(
      normalizeTranslationCompletionReferences(receipt("pending", []), [
        makeBlock("block-a"),
      ]),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("preserves valid failed references during normalization", () => {
    expect(
      normalizeTranslationCompletionReferences(receipt("failed", ["block-a"]), [
        makeBlock("block-a"),
      ]),
    ).toEqual({
      workflow: "erase-original",
      status: "failed",
      erasedBlockIds: ["block-a"],
    });
  });

  it("clears all normalized ids when any reference is unknown", () => {
    expect(
      normalizeTranslationCompletionReferences(
        receipt("pending", ["block-a", "legacy-b"]),
        [makeBlock("block-a")],
      ),
    ).toEqual({ workflow: "erase-original", status: "pending" });
  });

  it("rejects duplicate translation block ids", () => {
    expect(() =>
      assertUniqueTranslationBlockIds(
        [makeBlock("same"), makeBlock("same")],
        "duplicate block id",
      ),
    ).toThrow("duplicate block id");
  });

  it("does not mutate source blocks while validating uniqueness", () => {
    const blocks = [makeBlock("block-a"), makeBlock("block-b")];
    const before = structuredClone(blocks);

    assertUniqueTranslationBlockIds(blocks, "duplicate block id");

    expect(blocks).toEqual(before);
  });
});

function receipt(
  status: TranslationCompletionReceipt["status"],
  erasedBlockIds: readonly string[],
): TranslationCompletionReceipt {
  return {
    workflow: "erase-original",
    status,
    erasedBlockIds,
  };
}

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
