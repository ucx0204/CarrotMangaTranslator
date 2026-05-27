import { afterEach, describe, expect, it } from "vitest";
import { MIN_READABLE_FONT_SIZE_PX } from "../src/shared/geometry";
import { resolveBlockPaddingPx, resolveBlockRectPx, resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import type { TranslationBlock } from "../src/shared/types";

const originalDocument = globalThis.document;

describe("render layout padding", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true
    });
  });

  it("uses zero padding so text can occupy the full replacement block", () => {
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 40, height: 40 })).toBe(0);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 64, height: 64 })).toBe(0);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 90, height: 90 })).toBe(0);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 240, height: 240 })).toBe(0);
  });

  it("keeps horizontal text readable while fitting a narrow block", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
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
      autoFitText: true
    };

    const layout = resolveBlockTextLayout(block, block.translatedText, { width: 1000, height: 1000 }, { width: 1000, height: 1000 });

    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(false);
  });

  it("uses dynamic guard space so tiny blocks keep a usable fit area", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
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
      autoFitText: true
    };

    const layout = resolveBlockTextLayout(block, block.translatedText, { width: 1000, height: 1000 }, { width: 1000, height: 1000 });

    expect(layout.fitInnerWidth).toBeGreaterThan(10);
    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(false);
  });

  it("temporarily grows source-only boxes when 10px text would otherwise overflow", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
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
      autoFitText: true
    };

    const layout = resolveBlockTextLayout(block, block.translatedText, { width: 1000, height: 1000 }, { width: 1000, height: 1000 });

    expect(layout.rect.width).toBeGreaterThan(4);
    expect(layout.rect.height).toBeGreaterThan(4);
    expect(layout.fontSizePx).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE_PX);
  });

  it("keeps explicit render boxes manual and marks overflow instead of auto-growing them", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
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
      autoFitText: true
    };

    const layout = resolveBlockTextLayout(block, block.translatedText, { width: 1000, height: 1000 }, { width: 1000, height: 1000 });

    expect(layout.rect.width).toBe(4);
    expect(layout.fontSizePx).toBe(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(true);
  });

  it("places pixel-space blocks on the same scaled image plane", () => {
    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
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
      opacity: 1
    };

    expect(resolveBlockRectPx(block, { width: 1000, height: 1500 }, { width: 500, height: 750 })).toEqual({
      left: 100,
      top: 150,
      width: 50,
      height: 75
    });
  });
});

function installCanvasMeasureMock(): void {
  const context = {
    font: "",
    measureText(text: string) {
      const match = /(\d+)px/.exec(this.font);
      const fontSize = Number(match?.[1] ?? 16);
      return { width: [...text].length * fontSize * 0.95 } as TextMetrics;
    }
  };

  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => ({
        getContext: () => context
      })
    },
    configurable: true,
    writable: true
  });
}
