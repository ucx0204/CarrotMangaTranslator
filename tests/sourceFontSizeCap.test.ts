import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { resolvePageSourceFontFaceFallbacks } from "../src/renderer/src/lib/sourceFontSizeMatching";
import type { TranslationBlock } from "../src/shared/textTypes";
import { MIN_READABLE_FONT_SIZE_PX } from "../src/shared/readableTextBox";

const originalDocument = globalThis.document;
const pageSize = { width: 1000, height: 1000 };

describe("source-matched font-size cap", () => {
  it.each(["", "  \n  "])(
    "keeps an untranslated generated balloon empty without overflow: %j",
    (translatedText) => {
      installCanvasMeasureMock();
      const layout = resolveLayout(
        makeBlock({
          translatedText,
          bubbleLayout: makeDetectedBubbleLayout(),
          fontSizeIntent: "source-match",
        }),
      );
      expect(layout.overflow).toBe(false);
      expect(layout.fontSizePx).toBeGreaterThanOrEqual(
        MIN_READABLE_FONT_SIZE_PX,
      );
      expect(
        (layout.lines ?? [])
          .flatMap((line) => line.runs)
          .map((run) => run.text)
          .join("")
          .trim(),
      ).toBe("");
    },
  );

  it("reports overflow at the readable minimum when no generated mask size fits", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      renderBbox: { x: 0, y: 0, w: 1, h: 1 },
      bubbleLayout: makeDetectedBubbleLayout(),
      fontSizeIntent: "source-match",
      autoFitText: false,
      translatedText: "한 글자도 들어가지 않는 말풍선",
      sourceFontFacePx: 24,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    const layout = resolveLayout(block);
    expect(layout.fontSizePx).toBe(MIN_READABLE_FONT_SIZE_PX);
    expect(layout.overflow).toBe(true);
    expect(layout.lines?.length).toBeGreaterThan(0);
  });

  it("fits automatic source text without a detected mask while preserving manual size", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      bbox: { x: 0, y: 0, w: 120, h: 75 },
      autoFitText: false,
      fontSizeIntent: "source-match",
      translatedText: "긴 외부 대사도 할당된 영역을 넘지 않아야 한다.",
      sourceFontFacePx: 35,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    expect(resolveLayout(block).overflow).toBe(false);
    expect(resolveLayout(block).fontSizePx).toBeLessThan(35);
    const manual = resolveLayout({
      ...block,
      fontSizeIntent: "manual",
      fontSizePx: 35,
    });
    expect(manual.fontSizePx).toBe(35);
    expect(manual.overflow).toBe(true);
  });
  it("matches painted ink when a font has a negative left bearing", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      translatedText: "좌우획",
      fontSizeIntent: "source-match",
      sourceFontFacePx: 24,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    const result = resolveLayout(block);
    expect(result.fontSizePx * 0.8).toBeGreaterThan(24);
    expect(result.fontSizePx * 0.8).toBeLessThan(26);
    expect(
      resolveLayout({
        ...block,
        fontSizeIntent: "manual",
        autoFitText: false,
        fontSizePx: 24,
      }).fontSizePx,
    ).toBe(24);
  });
  it("fits a complete generated balloon despite the automatic font style disabling generic autofit", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      bbox: { x: 0, y: 0, w: 130, h: 85 },
      bubbleLayout: makeDetectedBubbleLayout(),
      fontSizeIntent: "source-match",
      autoFitText: false,
      wordBreak: "keep-all-overflow",
      translatedText:
        "이 문장은 원문 크기 그대로는 말풍선 안에 들어가지 않는다.",
      sourceFontFacePx: 40,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    const result = resolveLayout(block);
    expect(result.fontSizePx).toBeLessThan(40);
    expect(result.overflow).toBe(false);
    expect(
      result.lines?.every(
        (line) => line.slot && line.width <= line.slot.availableWidth,
      ),
    ).toBe(true);
    expect(
      result.lines
        ?.map((line) => line.runs.map((run) => run.text).join(""))
        .join("")
        .replace(/\s/gu, ""),
    ).toBe(block.translatedText.replace(/\s/gu, ""));
    expect(
      resolveLayout({ ...block, fontSizeIntent: "manual", fontSizePx: 40 })
        .fontSizePx,
    ).toBe(40);
  });
  it("makes a small local adjustment to keep an automatic phrase whole", () => {
    installCanvasMeasureMock();
    const block = makeBlock({
      bbox: { x: 0, y: 0, w: 86, h: 100 },
      bubbleLayout: makeDetectedBubbleLayout(),
      fontSizeIntent: "source-match",
      autoFitText: false,
      translatedText: "너희는…",
      wordBreak: "keep-all-overflow",
      sourceFontFacePx: 24,
      sourceFontSizeConfidence: 0.9,
      sourceFontSizeMethod: "raster-core-v1",
    });
    const result = resolveLayout(block);
    expect(result.fontSizePx).toBe(22);
    expect(
      result.lines?.map((line) => line.runs.map((run) => run.text).join("")),
    ).toEqual(["너희는…"]);
    expect(
      resolveLayout({ ...block, fontSizeIntent: "manual", fontSizePx: 24 })
        .fontSizePx,
    ).toBe(24);
    expect(
      resolveLayout({ ...block, translatedText: "너희는\n…" }).fontSizePx,
    ).toBe(25);
  });

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

    expect(layout.fontSizePx).toBe(25);
    expect(layout.overflow).toBe(false);
  });

  it("converts a horizontal source face through horizontal font metrics", () => {
    installCanvasMeasureMock();
    const layout = resolveLayout(
      makeBlock({
        fontSizeIntent: "source-match",
        sourceDirection: "horizontal",
        sourceFontFacePx: 24,
        sourceFontSizeConfidence: 0.9,
        sourceFontSizeMethod: "raster-core-v1",
      }),
    );

    expect(layout.fontSizePx).toBe(25);
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

  it("rescues a missing measurement in a narrow tall vertical-source box", () => {
    installCanvasMeasureMock();
    const target = makeBlock({
      id: "narrow-tall-missing-source-face",
      bbox: { x: 196, y: 590, w: 73, h: 159 },
      bboxSpace: "normalized_1000",
      sourceText: "神の慈悲により",
      translatedText: "신의 자비로",
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontRole: "dialogue",
      fontSizePx: 12,
      fontSizeIntent: "source-match",
      autoFitText: false,
    });
    const peers = [
      makeMeasuredPeer("peer-a", 19.6, {
        fontRole: "dialogue",
        sourceDirection: "vertical",
      }),
      makeMeasuredPeer("peer-b", 20.8, {
        fontRole: "dialogue",
        sourceDirection: "vertical",
      }),
      makeMeasuredPeer("peer-c", 26.4, {
        fontRole: "dialogue",
        sourceDirection: "vertical",
      }),
    ];

    const fallback = resolvePageSourceFontFaceFallbacks(
      [target, ...peers],
      pageSize,
    ).get(target.id);
    const layout = resolveLayout(target, fallback);

    expect(fallback).toBe(20.8);
    expect(layout.fontSizePx).toBe(22);
    expect(layout.fontSizePx).toBeGreaterThan(target.fontSizePx);
    expect(layout.lines?.length).toBeGreaterThanOrEqual(2);
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

    expect(layout.fontSizePx).toBe(13);
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
      const signedBearing = /^[좌우획]+$/u.test(text);
      return {
        width: [...text].length * fontSize * 0.95,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
        actualBoundingBoxLeft: fontSize * (signedBearing ? -0.1 : 0.5),
        actualBoundingBoxRight: fontSize * (signedBearing ? 0.9 : 0.5),
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
