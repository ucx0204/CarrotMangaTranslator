import { describe, expect, it } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  resolveBlockTextOutlinePx,
  resolveOverlayTextContentStyle,
} from "../src/renderer/src/components/overlayTextStyles";
import type { BlockTextLayout } from "../src/renderer/src/lib/overlayLayout";

describe("overlay text word-break styles", () => {
  it.each([
    [undefined, "vertical", "break-word", "anywhere"],
    [undefined, "horizontal", "break-all", "normal"],
    ["normal", "vertical", "normal", "normal"],
    ["break-all", "vertical", "break-all", "normal"],
    ["keep-all", "vertical", "keep-all", "normal"],
    ["break-word", "vertical", "break-word", "anywhere"],
  ] as const)(
    "maps %s in %s text to word-break %s and overflow-wrap %s",
    (wordBreak, renderDirection, expectedWordBreak, expectedOverflowWrap) => {
      const style = resolveOverlayTextContentStyle(
        { ...BLOCK, wordBreak },
        LAYOUT,
        renderDirection,
      );

      expect(style.wordBreak).toBe(expectedWordBreak);
      expect(style.overflowWrap).toBe(expectedOverflowWrap);
    },
  );

  it("uses the full block plane for positioned bubble lines", () => {
    const style = resolveOverlayTextContentStyle(
      {
        ...BLOCK,
        renderDirection: "horizontal",
        textAlign: "left",
        fontWidthScale: 0.8,
      },
      {
        ...LAYOUT,
        textContentWidth: 125,
        lines: [
          {
            runs: [{ text: "번역", bold: false, italic: false }],
            width: 30,
            slot: {
              blockOffsetPx: 20,
              inlineOffsetPx: 12.5,
              availableWidth: 100,
              regionIndex: 0,
            },
          },
        ],
      },
      "horizontal",
    );

    expect(style.position).toBe("relative");
    expect(style.height).toBe("100px");
    expect(style.maxWidth).toBe("none");
    expect(style.flexShrink).toBe(0);
    expect(style.transform).toBe("scaleX(0.8)");
    expect(style.transformOrigin).toBe("center center");
  });

  it("gives positioned vertical bubble columns the full unscaled block plane", () => {
    const style = resolveOverlayTextContentStyle(
      {
        ...BLOCK,
        fontWidthScale: 0.8,
      },
      {
        ...LAYOUT,
        lines: [
          {
            runs: [{ text: "세로", bold: false, italic: false }],
            width: 48,
            slot: {
              blockOffsetPx: 40,
              inlineOffsetPx: 12,
              availableWidth: 76,
              regionIndex: 0,
            },
          },
        ],
      },
      "vertical",
    );

    expect(style.position).toBe("relative");
    expect(style.height).toBe("100px");
    expect(style.width).toBe("125px");
    expect(style.maxWidth).toBe("none");
    expect(style.transform).toBe("scaleX(0.8)");
  });

  it("keeps a contrasting outline on automatic dark text", () => {
    const block = makeAutomaticBlock({
      textColor: "#111111",
      outlineColor: "#111111",
      outlineWidthScale: 1,
    });
    const style = resolveOverlayTextContentStyle(block, LAYOUT, "horizontal");

    expect(style.textShadow).not.toBe("none");
    expect(style.textShadow).toContain("#ffffff");
    expect(resolveBlockTextOutlinePx(block, 10)).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps inverse automatic text white with a contrasting dark outline", () => {
    const style = resolveOverlayTextContentStyle(
      makeAutomaticBlock({
        textColor: "#f7f7f2",
        outlineColor: "#f7f7f2",
        outlineWidthScale: 1,
      }),
      LAYOUT,
      "horizontal",
    );

    expect(style.textShadow).not.toBe("none");
    expect(style.textShadow).toContain("#111111");
  });

  it("preserves a zero-width outline on automatic blocks without a minimum", () => {
    const block = makeAutomaticBlock({
      textColor: "#111111",
      outlineColor: "#111111",
      outlineWidthScale: 0,
    });
    const style = resolveOverlayTextContentStyle(block, LAYOUT, "horizontal");

    expect(style.textShadow).toBe("none");
    expect(resolveBlockTextOutlinePx(block, 10)).toBe(0);
  });

  it("preserves the explicit no-outline contract for non-automatic blocks", () => {
    const style = resolveOverlayTextContentStyle(
      { ...BLOCK, outlineWidthScale: 0 },
      LAYOUT,
      "horizontal",
    );

    expect(style.textShadow).toBe("none");
  });
});

function makeAutomaticBlock(
  overrides: Partial<TranslationBlock>,
): TranslationBlock {
  return {
    ...BLOCK,
    automaticFontMatch: {
      schemaVersion: 1,
      selectedFontId: "dohyeon",
      role: "dialogue",
      confidence: 0.9,
      source: "local_visual",
      previousStyle: {
        fontFamily: null,
        bold: null,
        italic: null,
        outlineWidthScale: 0,
      },
    },
    ...overrides,
  };
}

const BLOCK: TranslationBlock = {
  id: "block-style",
  type: "nonsolid",
  bbox: { x: 0, y: 0, w: 100, h: 100 },
  sourceText: "원문",
  translatedText: "번역",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "vertical",
  fontSizePx: 24,
  lineHeight: 1.18,
  textAlign: "center",
  textColor: "#111111",
  backgroundColor: "#ffffff",
  opacity: 1,
};

const LAYOUT: BlockTextLayout = {
  rect: { left: 0, top: 0, width: 100, height: 100 },
  paddingPx: 0,
  layoutWidth: 100,
  layoutHeight: 100,
  innerWidth: 100,
  innerHeight: 100,
  fitInnerWidth: 100,
  fitInnerHeight: 100,
  fontSizePx: 24,
  textContentWidth: 100,
  lines: null,
  textScaleX: 1,
  textScaleY: 1,
  overflow: false,
};
