import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalDocument = globalThis.document;
const pageSize = { width: 1000, height: 1000 };

describe("source-matched font-size cap", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  });

  it("caps automatic growth at the source-matched size", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      sourceFontFacePx: 24,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });

    const layout = resolveLayout(block);

    expect(layout.fontSizePx).toBe(24);
    expect(layout.overflow).toBe(false);
  });

  it("shrinks below the cap when a long translation does not fit", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      bbox: { x: 0, y: 0, w: 75, h: 55 },
      translatedText: "번역문이 길어서 원문 크기로는 들어가지 않습니다",
      sourceFontFacePx: 40,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });

    const layout = resolveLayout(block);

    expect(layout.fontSizePx).toBeLessThan(40);
    expect(layout.overflow).toBe(false);
  });

  it("leaves an explicitly selected manual size unchanged", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      fontSizePx: 36,
      sourceFontFacePx: 18,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
      autoFitText: false,
    });

    const layout = resolveLayout(block);

    expect(layout.fontSizePx).toBe(36);
    expect(layout.overflow).toBe(false);
  });
});

function resolveLayout(block: TranslationBlock) {
  return resolveBlockTextLayout(
    block,
    block.translatedText,
    pageSize,
    pageSize,
    DEFAULT_BLOCK_FONT_CATALOG,
  );
}

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "source-size-block",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 400, h: 400 },
    sourceText: "原文",
    translatedText: "번역",
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
    ...overrides,
  };
}

function installCanvasMeasureMock(): void {
  const context = {
    font: "",
    measureText(text: string) {
      const match = /(\d+)px/.exec(this.font);
      const fontSize = Number(match?.[1] ?? 16);
      return {
        width: [...text].length * fontSize * 0.95,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
        actualBoundingBoxLeft: fontSize * 0.5,
        actualBoundingBoxRight: fontSize * 0.5,
      } as TextMetrics;
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
