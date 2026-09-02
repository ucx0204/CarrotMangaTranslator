import { describe, expect, it } from "vitest";
import {
  PanelCommandSchema,
  PanelSyncStateSchema,
} from "../src/shared/panelBridgeSchemas";
import {
  buildPanelFormatSelection,
  createPanelSelectionKey,
  PANEL_FORMAT_FIELD_KEYS,
  pickPanelFormatPatch,
} from "../src/shared/panelBridgeTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { BLOCK_FORMAT_FIELD_KEYS } from "../src/shared/blockFormat";

describe("panel multi-selection format contracts", () => {
  it("creates an order-independent key for the exact selected block set", () => {
    expect(createPanelSelectionKey(["block-b", "block-a", "block-b"])).toBe(
      JSON.stringify(["block-a", "block-b"]),
    );
  });

  it("reports common format values separately from mixed values", () => {
    const effect = {
      enabled: true,
      color: "#123456",
      offsetXpx: 1,
      offsetYpx: 2,
      blurPx: 3,
      opacity: 0.5,
    };
    const selection = buildPanelFormatSelection([
      makeBlock("block-a", {
        bold: true,
        fontSizePx: 24,
        textEffect: effect,
      }),
      makeBlock("block-b", {
        bold: false,
        fontSizePx: 24,
        textEffect: { ...effect },
      }),
    ]);

    expect(selection.common).toMatchObject({
      fontSizePx: 24,
      textColor: "#111111",
      textEffect: effect,
    });
    expect(selection.mixedFields).toContain("bold");
    expect(selection.mixedFields).not.toContain("fontSizePx");
    expect(selection.mixedFields).not.toContain("textEffect");
  });

  it("reports an empty format summary when nothing is selected", () => {
    expect(buildPanelFormatSelection([])).toEqual({
      common: {},
      mixedFields: [],
    });
  });

  it("allows only formatting fields through the selection patch boundary", () => {
    const patch = pickPanelFormatPatch({
      bold: true,
      textColor: "#123456",
      translatedText: "must stay active-block only",
      bbox: { x: 1, y: 2, w: 3, h: 4 },
    });

    expect(patch).toEqual({ bold: true, textColor: "#123456" });
    expect(
      PanelCommandSchema.parse({
        type: "updateSelectionFormat",
        selectionKey: createPanelSelectionKey(["block-a"]),
        patch,
      }),
    ).toMatchObject({ type: "updateSelectionFormat", patch });
    expect(() =>
      PanelCommandSchema.parse({
        type: "updateSelectionFormat",
        selectionKey: createPanelSelectionKey(["block-a"]),
        patch: { translatedText: "rejected" },
      }),
    ).toThrow();
  });

  it("keeps every supported editor format field across the detached-panel boundary", () => {
    const glow = {
      enabled: true,
      color: "#abcdef",
      blurPx: 6,
      opacity: 0.75,
    };
    const source = makeBlock("block-a", {
      fontFamily: "default",
      fontSizePx: 32,
      autoFitText: false,
      fontSizeIntent: "manual",
      bold: true,
      italic: true,
      underline: true,
      strikethrough: true,
      emphasisMark: true,
      textAlign: "left",
      wordBreak: "keep-all",
      renderDirection: "vertical",
      lineHeight: 1.4,
      letterSpacing: 0.2,
      fontWidthScale: 0.9,
      textColor: "#123456",
      textBackgroundEnabled: true,
      textBackgroundColor: "#fff0aa",
      textOpacity: 0.8,
      backgroundColor: "#abcdef",
      opacity: 0.7,
      outlineColor: "#654321",
      outlineWidthPx: 2,
      outlineWidthScale: 1.5,
      outerOutlineColor: "#0f0f0f",
      outerOutlineWidthPx: 3,
      rotationDeg: 12,
      textEffect: {
        enabled: true,
        color: "#000000",
        offsetXpx: 1,
        offsetYpx: 2,
        blurPx: 3,
        opacity: 0.5,
      },
      textGlow: glow,
    });
    const patch = pickPanelFormatPatch(source);

    expect(Object.keys(patch).sort()).toEqual(
      [...PANEL_FORMAT_FIELD_KEYS].sort(),
    );
    expect(
      PanelCommandSchema.parse({
        type: "updateSelectionFormat",
        selectionKey: createPanelSelectionKey([source.id]),
        patch,
      }),
    ).toMatchObject({ patch });
  });

  it("relays every field owned by the block-format registry", () => {
    expect(
      BLOCK_FORMAT_FIELD_KEYS.filter(
        (key) => !PANEL_FORMAT_FIELD_KEYS.includes(key),
      ),
    ).toEqual([]);
  });

  it("validates the synchronized selection summary and text-tab token", () => {
    const selectionKey = createPanelSelectionKey(["block-a", "block-b"]);
    expect(
      PanelSyncStateSchema.parse({
        areaTranslateAvailable: false,
        areaTranslateSelecting: false,
        blockStylePresets: [],
        disableChapterApply: false,
        editorDisabled: false,
        editorTextTabRequestToken: 3,
        formatSelection: {
          common: { textColor: "#111111" },
          mixedFields: ["fontSizePx"],
        },
        selectedBlock: makeBlock("block-a"),
        selectedBlockCount: 2,
        selectedBlockSourceFontFaceFallbackPx: 31.5,
        selectedPageSize: { width: 1200, height: 1600 },
        selectionKey,
        transformMode: "select",
      }),
    ).toMatchObject({
      editorTextTabRequestToken: 3,
      selectedBlockSourceFontFaceFallbackPx: 31.5,
      selectionKey,
    });
  });
});

function makeBlock(
  id: string,
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 1,
    autoFitText: false,
    ...patch,
  };
}
