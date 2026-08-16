import { describe, expect, it } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  buildGatherTextDirectFormatPatch,
  deriveGatherTextDirectFormatModel,
  isGatherTextDirectFormatPatchEmpty,
  mergeGatherTextDirectFormatPatch,
} from "../src/renderer/src/lib/gatherTextDirectFormatModel";

describe("gatherTextDirectFormatModel", () => {
  it("marks matching values as common and differing values as mixed", () => {
    const model = deriveGatherTextDirectFormatModel([
      makeBlock({ fontSizePx: 24, textAlign: "center" }),
      makeBlock({ fontSizePx: 36, textAlign: "center" }),
    ]);

    expect(model.selectionCount).toBe(2);
    expect(model.values.fontSizePx).toEqual({ kind: "mixed" });
    expect(model.values.textAlign).toEqual({
      kind: "common",
      value: "center",
    });
    expect(model.previewValues?.fontSizePx).toBe(24);
  });

  it("treats the default font id and an omitted font as the same value", () => {
    const model = deriveGatherTextDirectFormatModel([
      makeBlock({ fontFamily: "default" }),
      makeBlock({ fontFamily: undefined }),
    ]);

    expect(model.values.fontFamily).toEqual({
      kind: "common",
      value: undefined,
    });
  });

  it("normalizes optional block fields to their renderer defaults", () => {
    const model = deriveGatherTextDirectFormatModel([makeBlock()]);

    expect(model.values.bold).toEqual({ kind: "common", value: false });
    expect(model.values.autoFitText).toEqual({ kind: "common", value: true });
    expect(model.values.letterSpacing).toEqual({
      kind: "common",
      value: 0,
    });
    expect(model.values.fontWidthScale).toEqual({
      kind: "common",
      value: 1,
    });
    expect(model.values.textOpacity).toEqual({
      kind: "common",
      value: 1,
    });
    expect(model.values.wordBreak).toEqual({
      kind: "common",
      value: "break-all",
    });
  });

  it("shows the legacy wrapping behavior for each text direction", () => {
    const horizontal = deriveGatherTextDirectFormatModel([
      makeBlock({ renderDirection: "horizontal", wordBreak: undefined }),
    ]);
    const vertical = deriveGatherTextDirectFormatModel([
      makeBlock({ renderDirection: "vertical", wordBreak: undefined }),
    ]);

    expect(horizontal.values.wordBreak).toEqual({
      kind: "common",
      value: "break-all",
    });
    expect(vertical.values.wordBreak).toEqual({
      kind: "common",
      value: "break-word",
    });
  });

  it("tracks mixed wrapping modes", () => {
    const model = deriveGatherTextDirectFormatModel([
      makeBlock({ wordBreak: "keep-all" }),
      makeBlock({ wordBreak: "break-word" }),
    ]);

    expect(model.values.wordBreak).toEqual({ kind: "mixed" });
  });

  it("compares legacy and manual outline widths in rendered pixels", () => {
    const legacy = deriveGatherTextDirectFormatModel([
      makeBlock({ fontSizePx: 24, outlineWidthScale: 1 }),
    ]);
    expect(legacy.values.outlineWidthPx).toEqual({
      kind: "common",
      value: 1.3,
    });

    const pixels = deriveGatherTextDirectFormatModel([
      makeBlock({ outlineWidthPx: 8.5, outlineWidthScale: 0 }),
      makeBlock({ outlineWidthPx: 8.5, outlineWidthScale: 2 }),
    ]);
    expect(pixels.values.outlineWidthPx).toEqual({
      kind: "common",
      value: 8.5,
    });
  });

  it("preserves explicitly touched undefined values and strips other fields", () => {
    const patch = mergeGatherTextDirectFormatPatch(
      { translatedText: "ignore", fontFamily: "nanum-gothic" },
      buildGatherTextDirectFormatPatch("fontFamily", undefined),
      buildGatherTextDirectFormatPatch("bold", true),
    );

    expect(Object.hasOwn(patch, "fontFamily")).toBe(true);
    expect(patch).toEqual({ fontFamily: undefined, bold: true });
    expect(isGatherTextDirectFormatPatchEmpty(patch)).toBe(false);
    expect(isGatherTextDirectFormatPatchEmpty({ translatedText: "x" })).toBe(
      true,
    );
  });
});

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block",
    type: "nonsolid",
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    sourceText: "source",
    translatedText: "translation",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "transparent",
    opacity: 1,
    ...overrides,
  };
}
