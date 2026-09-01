import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { resolvePageSourceFontFaceFallbacks } from "../src/renderer/src/lib/sourceFontSizeMatching";
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
      fontSizeIntent: "source-match",
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
      fontSizeIntent: "source-match",
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

  it("uses a trusted page-local source size for a corner-fragment measurement", () => {
    installCanvasMeasureMock();
    const geometry = {
      bbox: { x: 540, y: 110, w: 40, h: 40 },
      bboxSpace: "normalized_1000" as const,
      renderBbox: { x: 200, y: 100, w: 400, h: 400 },
      renderBboxSpace: "normalized_1000" as const,
      bubbleLayout: makeDetectedBubbleLayout(),
      sourceText: "皆お兄様みたいにできない僕はダメだって",
      translatedText: "다들 형님처럼 해내지 못하는 나는 글렀다고",
    };
    const boxFit = resolveLayout(makeBlock(geometry));
    const suspicious = resolveLayout(
      makeBlock({
        ...geometry,
        sourceFontFacePx: 12,
        sourceFontSizeConfidence: 0.9,
        sourceFontSizeMethod: "raster-core-v1",
      }),
      18,
    );

    expect(boxFit.fontSizePx).toBeGreaterThan(18);
    expect(suspicious.fontSizePx).toBe(18);
    expect(suspicious.overflow).toBe(false);
  });

  it("derives the fallback from reliable peers with matching page typography", () => {
    const target = makeBlock({
      id: "target",
      bbox: { x: 540, y: 110, w: 40, h: 40 },
      bboxSpace: "normalized_1000",
      renderBbox: { x: 200, y: 100, w: 400, h: 400 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: makeDetectedBubbleLayout(),
      sourceText: "皆お兄様みたいにできない僕はダメだって",
      fontRole: "dialogue",
      bold: false,
      sourceFontFacePx: 8,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    const peers = [
      makeMeasuredPeer("same-weight-a", 16, {
        fontRole: "dialogue",
        bold: false,
      }),
      makeMeasuredPeer("same-weight-b", 20, {
        fontRole: "dialogue",
        bold: false,
      }),
      makeMeasuredPeer("different-weight", 40, {
        fontRole: "dialogue",
        bold: true,
      }),
      makeMeasuredPeer("different-role", 60, {
        fontRole: "narration",
        bold: false,
      }),
    ];

    const fallbacks = resolvePageSourceFontFaceFallbacks(
      [target, ...peers],
      pageSize,
    );

    expect(fallbacks.get(target.id)).toBe(18);
    expect(fallbacks.size).toBe(1);
  });

  it("keeps the source cap when the small source geometry is centered", () => {
    installCanvasMeasureMock();
    const layout = resolveLayout(
      makeBlock({
        bbox: { x: 380, y: 280, w: 40, h: 40 },
        bboxSpace: "normalized_1000",
        renderBbox: { x: 200, y: 100, w: 400, h: 400 },
        renderBboxSpace: "normalized_1000",
        bubbleLayout: makeDetectedBubbleLayout(),
        sourceText: "中央に配置された長い原文文字列です",
        translatedText: "가운데 놓인 긴 원문 문자열입니다",
        fontSizeIntent: "source-match",
        sourceFontFacePx: 12,
        sourceFontSizeConfidence: 0.9,
        sourceFontSizeMethod: "raster-core-v1",
      }),
    );

    expect(layout.fontSizePx).toBe(12);
    expect(layout.overflow).toBe(false);
  });
});

function resolveLayout(
  block: TranslationBlock,
  sourceFontFaceFallbackPx?: number,
) {
  return resolveBlockTextLayout(
    block,
    block.translatedText,
    pageSize,
    pageSize,
    DEFAULT_BLOCK_FONT_CATALOG,
    { sourceFontFaceFallbackPx },
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

function makeDetectedBubbleLayout(): NonNullable<
  TranslationBlock["bubbleLayout"]
> {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    origin: "detected",
    modelId: "koharu-layout-rfdetr-test",
    sourceImageRevision: "test-source-revision",
    insetRatio: 0,
    regions: [
      {
        spans: [
          {
            blockStart: 0,
            blockEnd: 1,
            inlineStart: 0,
            inlineEnd: 1,
          },
        ],
      },
    ],
  };
}

function makeMeasuredPeer(
  id: string,
  sourceFontFacePx: number,
  overrides: Partial<TranslationBlock>,
): TranslationBlock {
  return makeBlock({
    id,
    sourceFontFacePx,
    sourceFontSizeConfidence: 0.9,
    sourceFontSizeMethod: "raster-core-v1",
    ...overrides,
  });
}
