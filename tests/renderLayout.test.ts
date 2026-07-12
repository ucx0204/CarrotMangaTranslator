import { afterEach, describe, expect, it } from "vitest";
import { MIN_READABLE_FONT_SIZE_PX } from "../src/shared/geometry";
import {
  resolveBlockPaddingPx,
  resolveBlockRectPx,
  resolveBlockTextLayout,
} from "../src/renderer/src/lib/overlayLayout";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalDocument = globalThis.document;

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
