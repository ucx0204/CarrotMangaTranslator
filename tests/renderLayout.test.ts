import { afterEach, describe, expect, it } from "vitest";
import { MIN_READABLE_FONT_SIZE_PX } from "../src/shared/readableTextBox";
import {
  resolveBlockPaddingPx,
  resolveBlockRectPx,
  resolveBlockTextLayout as resolveBlockTextLayoutWithCatalog,
  type ViewportSize,
} from "../src/renderer/src/lib/overlayLayout";
import type { TranslationBlock } from "../src/shared/textTypes";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

const originalDocument = globalThis.document;

function resolveBlockTextLayout(
  block: TranslationBlock,
  text: string,
  pageSize: ViewportSize,
  stageSize: ViewportSize,
  options?: {
    textLayoutScale?: number;
    textLayoutStageSize?: ViewportSize;
  },
) {
  return resolveBlockTextLayoutWithCatalog(
    block,
    text,
    pageSize,
    stageSize,
    DEFAULT_BLOCK_FONT_CATALOG,
    options,
  );
}

describe("render layout padding", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  });

  it("uses zero padding so text can occupy the full replacement block", () => {
    expect(
      resolveBlockPaddingPx({ left: 0, top: 0, width: 40, height: 40 }),
    ).toBe(0);
    expect(
      resolveBlockPaddingPx({ left: 0, top: 0, width: 64, height: 64 }),
    ).toBe(0);
    expect(
      resolveBlockPaddingPx({ left: 0, top: 0, width: 90, height: 90 }),
    ).toBe(0);
    expect(
      resolveBlockPaddingPx({ left: 0, top: 0, width: 240, height: 240 }),
    ).toBe(0);
  });

  it("keeps horizontal text readable while fitting a narrow block", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 40, h: 300 },
      sourceText: "가",
      translatedText: "가",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 96,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(false);
  });

  it("uses dynamic guard space so tiny blocks keep a usable fit area", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 25, h: 44 },
      sourceText: "응",
      translatedText: "응",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fitInnerWidth).toBeGreaterThan(10);
    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(false);
  });

  it("grows auto-fit text to use the available render box", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 260, h: 160 },
      sourceText: "가",
      translatedText: "가",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBeGreaterThan(12);
    expect(layout.overflow).toBe(false);
  });

  it("caps sign and title auto-fit growth at twice the preferred size", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "title-block",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 400, h: 400 },
      sourceText: "題",
      translatedText: "제목",
      fontRole: "sign_ui_title",
      fontRoleConfidence: 0.96,
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBe(40);
    expect(layout.overflow).toBe(false);
  });

  it("keeps the generic dialogue growth path unchanged", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "dialogue-block",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 400, h: 400 },
      sourceText: "話",
      translatedText: "대화",
      fontRole: "dialogue",
      fontRoleConfidence: 0.96,
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBeGreaterThan(40);
    expect(layout.overflow).toBe(false);
  });

  it("still shrinks sign and title text below the preferred size when needed", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "small-title-block",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 20, h: 20 },
      sourceText: "題",
      translatedText: "제목",
      fontRole: "sign_ui_title",
      fontRoleConfidence: 0.96,
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 40,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBeLessThan(40);
    expect(layout.overflow).toBe(false);
  });

  it("keeps manual font size when auto-fit is disabled", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 260, h: 160 },
      sourceText: "가",
      translatedText: "가",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 18,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBe(18);
  });

  it("temporarily grows source-only boxes when 10px text would otherwise overflow", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      sourceText: "",
      translatedText: "가나다",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.rect.width).toBeGreaterThan(4);
    expect(layout.rect.height).toBeGreaterThan(4);
    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
  });

  it("keeps explicit render boxes manual and marks overflow instead of auto-growing them", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      renderBbox: { x: 100, y: 100, w: 4, h: 4 },
      sourceText: "",
      translatedText: "가나다",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.rect.width).toBe(4);
    expect(layout.fontSizePx).toBe(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(true);
  });

  it("lets a narrower 장평 (fontWidthScale) auto-fit a larger font than a wider one", () => {
    installCanvasMeasureMock();

    const base: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 200 },
      sourceText: "가나다라마바사",
      translatedText: "가나다라마바사",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const narrow = resolveBlockTextLayout(
      { ...base, fontWidthScale: 0.6 },
      base.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );
    const wide = resolveBlockTextLayout(
      { ...base, fontWidthScale: 1.4 },
      base.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(narrow.fontSizePx).toBeGreaterThan(wide.fontSizePx);
    expect(narrow.overflow).toBe(false);
    expect(wide.overflow).toBe(false);
  });

  it("excludes inline markup markers from the measured text width", () => {
    installCanvasMeasureMock();

    const base: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 120, h: 60 },
      sourceText: "가나다",
      translatedText: "가나다",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const plain = resolveBlockTextLayout(
      base,
      base.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );
    const marked = resolveBlockTextLayout(
      { ...base, translatedText: "**가나다**" },
      "**가나다**",
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    // The two extra `**` pairs must not shrink the auto-fit font or trigger
    // overflow — only the three visible glyphs count.
    expect(marked.fontSizePx).toBe(plain.fontSizePx);
    expect(marked.overflow).toBe(plain.overflow);
  });

  it("preserves absolute inline size ratios through one auto-fit scale", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "inline-size",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 180, h: 100 },
      sourceText: "",
      translatedText: "[size=24]가[/size]나",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 1,
      autoFitText: true,
    };
    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );
    const runs = layout.lines?.flatMap((line) => line.runs) ?? [];

    expect(runs[0]?.renderedFontSizePx).toBe(layout.fontSizePx * 2);
    expect(runs[1]?.renderedFontSizePx).toBe(layout.fontSizePx);
  });

  it("excludes inline markup markers from automatic render-box growth", () => {
    installCanvasMeasureMock();

    const base: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      sourceText: "",
      translatedText: "가나다",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };

    const plain = resolveBlockTextLayout(
      base,
      "가나다",
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );
    const marked = resolveBlockTextLayout(
      { ...base, translatedText: "**가나다**" },
      "**가나다**",
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(marked.rect).toEqual(plain.rect);
  });

  it("places pixel-space blocks on the same scaled image plane", () => {
    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 200, y: 300, w: 100, h: 150 },
      bboxSpace: "pixels",
      sourceText: "",
      translatedText: "",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
    };

    expect(
      resolveBlockRectPx(
        block,
        { width: 1000, height: 1500 },
        { width: 500, height: 750 },
      ),
    ).toEqual({
      left: 100,
      top: 150,
      width: 50,
      height: 75,
    });
  });

  it("keeps text layout stable against the original stage while workspace zoom changes", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 100, y: 120, w: 260, h: 180 },
      sourceText: "source",
      translatedText: "가나다라마바사아자차카타파하",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };
    const pageSize = { width: 1000, height: 1500 };
    const fittedStage = { width: 500, height: 750 };

    const normal = resolveBlockTextLayout(
      block,
      block.translatedText,
      pageSize,
      fittedStage,
      { textLayoutStageSize: fittedStage },
    );
    const zoomedIn = resolveBlockTextLayout(
      block,
      block.translatedText,
      pageSize,
      { width: fittedStage.width * 2.5, height: fittedStage.height * 2.5 },
      { textLayoutStageSize: fittedStage },
    );
    const zoomedOut = resolveBlockTextLayout(
      block,
      block.translatedText,
      pageSize,
      { width: fittedStage.width * 0.4, height: fittedStage.height * 0.4 },
      { textLayoutStageSize: fittedStage },
    );

    expect(zoomedIn.fontSizePx).toBe(normal.fontSizePx);
    expect(zoomedIn.fitInnerWidth).toBe(normal.fitInnerWidth);
    expect(zoomedIn.fitInnerHeight).toBe(normal.fitInnerHeight);
    expect(lineTexts(zoomedIn)).toEqual(lineTexts(normal));
    expect(zoomedIn.textScaleX).toBeCloseTo(2.5);
    expect(zoomedIn.textScaleY).toBeCloseTo(2.5);
    expect(zoomedIn.rect.width).toBeCloseTo(normal.rect.width * 2.5);
    expect(zoomedOut.fontSizePx).toBe(normal.fontSizePx);
    expect(zoomedOut.fitInnerWidth).toBe(normal.fitInnerWidth);
    expect(zoomedOut.fitInnerHeight).toBe(normal.fitInnerHeight);
    expect(lineTexts(zoomedOut)).toEqual(lineTexts(normal));
    expect(zoomedOut.textScaleX).toBeCloseTo(0.4);
    expect(zoomedOut.textScaleY).toBeCloseTo(0.4);
    expect(zoomedOut.rect.width).toBeCloseTo(normal.rect.width * 0.4);
  });

  it("uses the selected wrapping policy for auto-fit and overflow", () => {
    installCanvasMeasureMock();
    const base: TranslationBlock = {
      id: "block-word-break",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 80, h: 80 },
      renderBbox: { x: 0, y: 0, w: 80, h: 80 },
      sourceText: "abcdefghij",
      translatedText: "abcdefghij",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };
    const pageSize = { width: 1000, height: 1000 };

    const normal = resolveBlockTextLayout(
      { ...base, wordBreak: "normal" },
      base.translatedText,
      pageSize,
      pageSize,
    );
    const breakWord = resolveBlockTextLayout(
      { ...base, wordBreak: "break-word" },
      base.translatedText,
      pageSize,
      pageSize,
    );
    const legacy = resolveBlockTextLayout(
      base,
      base.translatedText,
      pageSize,
      pageSize,
    );
    const breakAll = resolveBlockTextLayout(
      { ...base, wordBreak: "break-all" },
      base.translatedText,
      pageSize,
      pageSize,
    );

    expect(normal.fontSizePx).toBe(MIN_READABLE_FONT_SIZE_PX);
    expect(normal.overflow).toBe(true);
    expect(breakWord.fontSizePx).toBeGreaterThan(normal.fontSizePx);
    expect(breakWord.overflow).toBe(false);
    expect(legacy.fontSizePx).toBe(breakAll.fontSizePx);
    expect(legacy.overflow).toBe(breakAll.overflow);
    expect(lineTexts(legacy)).toEqual(lineTexts(breakAll));
  });

  it("renders horizontal text through centered bubble scanline slots", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "block-bubble",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 200 },
      renderBbox: { x: 0, y: 0, w: 200, h: 200 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.25,
                inlineEnd: 0.75,
              },
            ],
          },
        ],
      },
      sourceText: "가나다라마",
      translatedText: "가나다라마",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.fontSizePx).toBe(20);
    expect(layout.overflow).toBe(false);
    expect(lineTexts(layout)).toEqual(["가나다라마"]);
    expect(layout.lines?.[0]?.slot).toEqual({
      blockOffsetPx: 90,
      inlineOffsetPx: 50,
      availableWidth: 100,
      regionIndex: 0,
    });

    const bubbleLayout = block.bubbleLayout;
    if (!bubbleLayout) throw new Error("expected bubble layout fixture");
    const lowConfidenceLayout = resolveBlockTextLayout(
      {
        ...block,
        bubbleLayout: { ...bubbleLayout, confidence: 0.1 },
      },
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );
    expect(lowConfidenceLayout.lines).toEqual(layout.lines);
    expect(lowConfidenceLayout.overflow).toBe(false);
  });

  it("flows through separated horizontal regions without placing a line in the gap", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "block-bubble-separated-horizontal",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 200 },
      renderBbox: { x: 0, y: 0, w: 200, h: 200 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0.05,
                blockEnd: 0.3,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
            ],
          },
          {
            spans: [
              {
                blockStart: 0.7,
                blockEnd: 0.95,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      },
      sourceText: "abcdefghijklmnopq",
      translatedText: "abcdefghijklmnopq",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
      wordBreak: "break-all",
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(lineTexts(layout)).toEqual(["abcdefgh", "ijklmnop", "q"]);
    expect(layout.lines?.map((line) => line.slot?.regionIndex)).toEqual([
      0, 0, 1,
    ]);
    expect(layout.lines?.map((line) => line.slot?.blockOffsetPx)).toEqual([
      15, 35, 155,
    ]);
    expect(
      layout.lines?.some((line) => {
        const offset = line.slot?.blockOffsetPx ?? -1;
        return offset >= 60 && offset < 140;
      }),
    ).toBe(false);
  });

  it("uses bubble slots in the same auto-fit word-break search", () => {
    installCanvasMeasureMock();
    const base: TranslationBlock = {
      id: "block-bubble-word-break",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 200 },
      renderBbox: { x: 0, y: 0, w: 200, h: 200 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.25,
                inlineEnd: 0.75,
              },
            ],
          },
        ],
      },
      sourceText: "abcdefghij",
      translatedText: "abcdefghij",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true,
    };
    const pageSize = { width: 1000, height: 1000 };

    const normal = resolveBlockTextLayout(
      { ...base, wordBreak: "normal" },
      base.translatedText,
      pageSize,
      pageSize,
    );
    const breakWord = resolveBlockTextLayout(
      { ...base, wordBreak: "break-word" },
      base.translatedText,
      pageSize,
      pageSize,
    );

    expect(normal.fontSizePx).toBe(MIN_READABLE_FONT_SIZE_PX);
    expect(normal.lines?.every((line) => line.slot)).toBe(true);
    expect(breakWord.fontSizePx).toBeGreaterThan(normal.fontSizePx);
    expect(breakWord.lines?.every((line) => line.slot)).toBe(true);
    expect(breakWord.overflow).toBe(false);
  });

  it("renders an existing vertical block through right-to-left bubble columns", () => {
    const block: TranslationBlock = {
      id: "block-bubble-vertical",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 300 },
      renderBbox: { x: 0, y: 0, w: 200, h: 300 },
      bubbleLayout: {
        version: 1,
        direction: "vertical",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.2,
                inlineEnd: 0.8,
              },
            ],
          },
        ],
      },
      sourceText: "가나다라마",
      translatedText: "가나다라마",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "vertical",
      fontSizePx: 20,
      fontWidthScale: 0.8,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(block.renderDirection).toBe("vertical");
    expect(layout.fontSizePx).toBe(20);
    expect(layout.overflow).toBe(false);
    expect(lineTexts(layout)).toEqual(["가나다라마"]);
    expect(layout.lines?.[0]?.slot).toMatchObject({
      blockOffsetPx: 115,
      inlineOffsetPx: 60,
      regionIndex: 0,
    });
    expect(layout.lines?.[0]?.slot?.availableWidth).toBeCloseTo(180);
  });

  it("keeps fused vertical bubble regions independent while flowing text", () => {
    const block: TranslationBlock = {
      id: "block-bubble-vertical-fused",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 300 },
      renderBbox: { x: 0, y: 0, w: 200, h: 300 },
      bubbleLayout: {
        version: 1,
        direction: "vertical",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0.55,
                blockEnd: 0.95,
                inlineStart: 0.1,
                inlineEnd: 0.3,
              },
            ],
          },
          {
            spans: [
              {
                blockStart: 0.05,
                blockEnd: 0.45,
                inlineStart: 0.7,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      },
      sourceText: "abcdefghijklmnop",
      translatedText: "abcdefghijklmnop",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "vertical",
      fontSizePx: 20,
      fontWidthScale: 0.8,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
      wordBreak: "break-all",
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(lineTexts(layout)).toEqual(["abc", "def", "ghi", "jkl", "mno", "p"]);
    expect(layout.lines?.map((line) => line.slot?.regionIndex)).toEqual([
      0, 0, 0, 1, 1, 1,
    ]);
    expect(
      (layout.lines?.[0]?.slot?.blockOffsetPx ?? 0) >
        (layout.lines?.[1]?.slot?.blockOffsetPx ?? 0),
    ).toBe(true);
    expect(layout.lines?.[2]?.slot?.inlineOffsetPx).toBe(30);
    expect(layout.lines?.[3]?.slot?.inlineOffsetPx).toBe(210);
  });

  it("maps explicit lines to separate fused regions before reusing one region", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "block-bubble-explicit-regions",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 100 },
      renderBbox: { x: 0, y: 0, w: 200, h: 100 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 0.4,
                inlineStart: 0.1,
                inlineEnd: 0.4,
              },
            ],
          },
          {
            spans: [
              {
                blockStart: 0.6,
                blockEnd: 1,
                inlineStart: 0.6,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      },
      sourceText: "말했어\n말했네",
      translatedText: "말했어\n말했네",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
      wordBreak: "break-all",
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(lineTexts(layout)).toEqual(["말했어", "말했네"]);
    expect(layout.lines?.map((line) => line.slot?.regionIndex)).toEqual([0, 1]);
    expect(layout.lines?.map((line) => line.slot?.blockOffsetPx)).toEqual([
      10, 70,
    ]);
  });

  it("keeps a one-line fused-bubble translation in the first safe region", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "block-bubble-short-regions",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 100 },
      renderBbox: { x: 0, y: 0, w: 200, h: 100 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 0.4,
                inlineStart: 0.1,
                inlineEnd: 0.4,
              },
            ],
          },
          {
            spans: [
              {
                blockStart: 0.6,
                blockEnd: 1,
                inlineStart: 0.6,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      },
      sourceText: "응",
      translatedText: "응",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(lineTexts(layout)).toEqual(["응"]);
    expect(layout.lines?.[0]?.slot?.regionIndex).toBe(0);
    expect(layout.lines?.[0]?.slot?.blockOffsetPx).toBe(10);
  });

  it("falls back without changing a vertical block when bubble axes disagree", () => {
    const block: TranslationBlock = {
      id: "block-bubble-vertical-mismatch",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 300 },
      renderBbox: { x: 0, y: 0, w: 200, h: 300 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.2,
                inlineEnd: 0.8,
              },
            ],
          },
        ],
      },
      sourceText: "세로쓰기",
      translatedText: "세로쓰기",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "vertical",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(block.renderDirection).toBe("vertical");
    expect(layout.lines).toBeNull();
  });

  it("keeps curve layout ahead of bubble-aware wrapping", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      id: "block-bubble-curve",
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 200, h: 200 },
      renderBbox: { x: 0, y: 0, w: 200, h: 200 },
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.25,
                inlineEnd: 0.75,
              },
            ],
          },
        ],
      },
      curveLayout: {
        version: 1,
        alignment: "center",
        offsetEm: 0,
        orientation: "tangent",
        path: {
          type: "quadratic",
          start: { x: 0, y: 0.7 },
          control: { x: 0.5, y: 0.2 },
          end: { x: 1, y: 0.7 },
        },
      },
      sourceText: "가나다라마",
      translatedText: "가나다라마",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: false,
    };

    const layout = resolveBlockTextLayout(
      block,
      block.translatedText,
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(layout.lines).toHaveLength(1);
    expect(layout.lines?.[0]?.slot).toBeUndefined();
  });
});

function lineTexts(
  layout: ReturnType<typeof resolveBlockTextLayout>,
): string[] {
  return (
    layout.lines?.map((line) => line.runs.map((run) => run.text).join("")) ?? []
  );
}

function installCanvasMeasureMock(): void {
  const context = {
    font: "",
    measureText(text: string) {
      const match = /(\d+)px/.exec(this.font);
      const fontSize = Number(match?.[1] ?? 16);
      return { width: [...text].length * fontSize * 0.95 } as TextMetrics;
    },
  };

  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => ({
        getContext: () => context,
      }),
    },
    configurable: true,
    writable: true,
  });
}
