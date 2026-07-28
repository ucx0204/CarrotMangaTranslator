import { afterEach, describe, expect, it } from "vitest";
import { doesGeneratedBubbleQualityFit } from "../src/renderer/src/lib/bubbleBlockTextLayout";
import { resolveBlockTextLayout as resolveBlockTextLayoutWithCatalog } from "../src/renderer/src/lib/overlayLayout";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import type { BlockTextLine } from "../src/renderer/src/lib/overlayTextWrapping";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalDocument = globalThis.document;
const PAGE_SIZE = { width: 1000, height: 1000 };

afterEach(() => {
  Object.defineProperty(globalThis, "document", {
    value: originalDocument,
    configurable: true,
    writable: true,
  });
});

describe("generated bubble text do-no-harm gate", () => {
  it("keeps a generated shape when it does not worsen the baseline", () => {
    installCanvasMeasureMock();
    const block: TranslationBlock = {
      ...makeQualityGateBlock(),
      renderBbox: { x: 100, y: 100, w: 300, h: 180 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        ...makeGeneratedBubbleLayout(),
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
      },
    };
    const layout = resolveBlockTextLayout(block);

    expect(layout.rect).toEqual({
      left: 100,
      top: 100,
      width: 300,
      height: 180,
    });
    expect(layout.lines?.some((line) => line.slot)).toBe(true);
    expect(block.translatedText).toBe("이전에 쓰던 것보다 좋은 무기를 골라.");
    expect(block.wordBreak).toBe("break-word");
  });

  it("reduces only the font size when generated slots would damage Korean words", () => {
    installCanvasMeasureMock();
    const base = makeQualityGateBlock();
    const manualCandidate: TranslationBlock = {
      ...base,
      renderBbox: { x: 50, y: 50, w: 500, h: 500 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        ...makeGeneratedBubbleLayout(),
        origin: "manual",
        modelId: "manual-debug",
        sourceImageRevision: undefined,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.35,
                inlineEnd: 0.65,
              },
            ],
          },
        ],
      },
    };
    const baseline = resolveBlockTextLayout(base);
    const ungatedCandidate = resolveBlockTextLayout(manualCandidate);
    const manualBubbleLayout = manualCandidate.bubbleLayout;
    if (!manualBubbleLayout) {
      throw new Error("expected manual bubble layout");
    }
    const generated = resolveBlockTextLayout({
      ...manualCandidate,
      bubbleLayout: {
        ...manualBubbleLayout,
        origin: "detected",
        modelId: "comic-rtdetr-test",
        sourceImageRevision: "test-revision",
      },
    });

    expect(ungatedCandidate.fontSizePx).toBeGreaterThan(baseline.fontSizePx);
    expect(lineTexts(ungatedCandidate)).toEqual([
      "이전",
      "에 쓰",
      "던 것",
      "보다 ",
      "좋은 ",
      "무기",
      "를 골",
      "라.",
    ]);
    expect(ungatedCandidate.lines?.some((line) => line.slot)).toBe(true);
    expect(generated.rect).toEqual(ungatedCandidate.rect);
    expect(generated.rect).not.toEqual(baseline.rect);
    expect(generated.fontSizePx).toBeLessThan(ungatedCandidate.fontSizePx);
    expect(generated.lines?.every((line) => line.slot)).toBe(true);
    expect(manualCandidate.translatedText).toBe(base.translatedText);
    expect(manualCandidate.wordBreak).toBe(base.wordBreak);
  });

  it("does not restore the OCR bbox when a generated box reaches the page edge", () => {
    installCanvasMeasureMock();
    const baselineBlock = makeQualityGateBlock();
    const generatedBlock: TranslationBlock = {
      ...baselineBlock,
      renderBbox: { x: 940, y: 80, w: 100, h: 220 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: makeGeneratedBubbleLayout(),
    };
    const gated = resolveBlockTextLayout(generatedBlock);

    expect(gated.rect).toEqual({
      left: 940,
      top: 80,
      width: 60,
      height: 220,
    });
    expect(generatedBlock.renderBbox).toEqual({
      x: 940,
      y: 80,
      w: 100,
      h: 220,
    });
  });

  it("does not gate manual geometry or a user-disabled auto-fit layout", () => {
    installCanvasMeasureMock();
    const base = makeQualityGateBlock();
    const renderBbox = { x: 940, y: 80, w: 100, h: 220 };
    const manual: TranslationBlock = {
      ...base,
      renderBbox,
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        ...makeGeneratedBubbleLayout(),
        origin: "manual",
        modelId: "manual-shape-v1",
        sourceImageRevision: undefined,
      },
    };
    const fixedAuto: TranslationBlock = {
      ...base,
      autoFitText: false,
      renderBbox,
      renderBboxSpace: "normalized_1000",
      bubbleLayout: makeGeneratedBubbleLayout(),
    };
    const manualLayout = resolveBlockTextLayout(manual);
    const fixedLayout = resolveBlockTextLayout(fixedAuto);

    expect(manualLayout.rect.left).toBe(940);
    expect(manualLayout.rect.width).toBe(60);
    expect(fixedLayout.rect.left).toBe(940);
    expect(fixedLayout.rect.width).toBe(60);
    expect(fixedLayout.fontSizePx).toBe(fixedAuto.fontSizePx);
  });

  it("rejects severe absolute fragmentation even within the baseline budget", () => {
    const equallyFragmented = {
      plainText: "abcdefghijkl",
      baseline: {
        intraWordSplitCount: 5,
        orphanLineCount: 0,
        lineCount: 6,
        semanticGraphemeCount: 12,
        averageSemanticGraphemesPerLine: 2,
      },
    };

    expect(
      doesGeneratedBubbleQualityFit(
        ["ab", "cd", "ef", "gh", "ij", "kl"].map(makeTextLine),
        equallyFragmented,
      ),
    ).toBe(false);
  });

  it("does not over-apply the absolute gate when line density stays readable", () => {
    const readableBudget = {
      plainText: "abcdefghijkl",
      baseline: {
        intraWordSplitCount: 2,
        orphanLineCount: 0,
        lineCount: 3,
        semanticGraphemeCount: 12,
        averageSemanticGraphemesPerLine: 4,
      },
    };

    expect(
      doesGeneratedBubbleQualityFit(
        ["abcd", "efgh", "ijkl"].map(makeTextLine),
        readableBudget,
      ),
    ).toBe(true);
  });

  it("keeps adjacent ownership boxes disjoint while lowering a damaged block", () => {
    installCanvasMeasureMock();
    const first: TranslationBlock = {
      ...makeQualityGateBlock(),
      id: "sample-12-block-2",
      bbox: { x: 100, y: 100, w: 500, h: 180 },
      renderBbox: { x: 100, y: 100, w: 300, h: 500 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        ...makeGeneratedBubbleLayout(),
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.35,
                inlineEnd: 0.65,
              },
            ],
          },
        ],
      },
    };
    const second: TranslationBlock = {
      ...makeQualityGateBlock(),
      id: "sample-12-block-6",
      bbox: { x: 350, y: 100, w: 300, h: 180 },
      translatedText: "다음 말풍선입니다.",
      renderBbox: { x: 404, y: 100, w: 200, h: 240 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: makeGeneratedBubbleLayout(),
    };
    const firstLayout = resolveBlockTextLayout(first);
    const secondLayout = resolveBlockTextLayout(second);

    expect(first.bbox.x + first.bbox.w).toBeGreaterThan(
      second.renderBbox?.x ?? 0,
    );
    expect(horizontalOverlap(firstLayout.rect, secondLayout.rect)).toBe(0);
    expect(firstLayout.rect).toEqual({
      left: 100,
      top: 100,
      width: 300,
      height: 500,
    });
    expect(firstLayout.lines?.every((line) => line.slot)).toBe(true);
  });
});

function resolveBlockTextLayout(block: TranslationBlock) {
  return resolveBlockTextLayoutWithCatalog(
    block,
    block.translatedText,
    PAGE_SIZE,
    PAGE_SIZE,
    DEFAULT_BLOCK_FONT_CATALOG,
  );
}

function lineTexts(
  layout: ReturnType<typeof resolveBlockTextLayoutWithCatalog>,
): string[] {
  return (
    layout.lines?.map((line) => line.runs.map((run) => run.text).join("")) ?? []
  );
}

function makeQualityGateBlock(): TranslationBlock {
  return {
    id: "block-bubble-quality-gate",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 180 },
    bboxSpace: "normalized_1000",
    sourceText: "以前より良い武器を選んで。",
    translatedText: "이전에 쓰던 것보다 좋은 무기를 골라.",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.1,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 1,
    autoFitText: true,
    wordBreak: "break-word",
  };
}

function makeGeneratedBubbleLayout(): NonNullable<
  TranslationBlock["bubbleLayout"]
> {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    origin: "detected",
    modelId: "comic-rtdetr-test",
    sourceImageRevision: "test-revision",
    insetRatio: 0.04,
    regions: [
      {
        spans: [
          {
            blockStart: 0,
            blockEnd: 1,
            inlineStart: 0.05,
            inlineEnd: 0.95,
          },
        ],
      },
    ],
  };
}

function makeTextLine(text: string): BlockTextLine {
  return {
    runs: [{ text, bold: false, italic: false }],
    width: text.length,
  };
}

function horizontalOverlap(
  first: { left: number; width: number },
  second: { left: number; width: number },
): number {
  return Math.max(
    0,
    Math.min(first.left + first.width, second.left + second.width) -
      Math.max(first.left, second.left),
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
