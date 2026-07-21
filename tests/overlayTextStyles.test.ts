import { describe, expect, it } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import { resolveOverlayTextContentStyle } from "../src/renderer/src/components/overlayTextStyles";
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
});

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
