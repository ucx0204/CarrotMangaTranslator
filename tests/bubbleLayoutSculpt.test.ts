import { describe, expect, it } from "vitest";
import { isUsableBubbleLayout } from "../src/shared/bubbleLayout";
import type { BubbleShapeSpan } from "../src/shared/bubbleLayout";
import type { TranslationBlock } from "../src/shared/textTypes";
import { sculptBubbleLayout } from "../src/renderer/src/lib/bubbleLayoutSculpt";

describe("bubble layout sculpt", () => {
  it("ignores a detached add stroke instead of creating an island", () => {
    const block = makeBlock();

    expect(
      sculptBubbleLayout({
        block,
        strokePoints: [{ x: 600, y: 600 }],
        mode: "add",
        radius: 20,
      }),
    ).toEqual({ status: "rejected", reason: "detached" });
  });

  it("expands a connected shape, including beyond its render box", () => {
    const block = makeBlock();
    const result = sculptBubbleLayout({
      block,
      strokePoints: [
        { x: 285, y: 200 },
        { x: 360, y: 200 },
      ],
      mode: "add",
      radius: 18,
    });
    const patch = appliedPatch(result);

    expect(patch.renderBbox.x).toBeLessThanOrEqual(100);
    expect(patch.renderBbox.x + patch.renderBbox.w).toBeGreaterThan(300);
    expect(patch.renderBboxSpace).toBe("normalized_1000");
    expect(patch.bubbleLayout).toMatchObject({
      origin: "manual",
      modelId: "manual-sculpt-v1",
      direction: "horizontal",
    });
    expect(patch.bubbleLayout).not.toHaveProperty("sourceImageRevision");
    expect(isUsableBubbleLayout(patch.bubbleLayout)).toBe(true);
  });

  it("shrinks an outer edge without deleting the component", () => {
    const block = makeBlock();
    const patch = appliedPatch(
      sculptBubbleLayout({
        block,
        strokePoints: [
          { x: 100, y: 100 },
          { x: 100, y: 300 },
        ],
        mode: "subtract",
        radius: 20,
      }),
    );

    expect(patch.renderBbox.x).toBeGreaterThan(100);
    expect(patch.renderBbox.w).toBeLessThan(200);
    expect(isUsableBubbleLayout(patch.bubbleLayout)).toBe(true);
  });

  it("rejects a subtraction that cuts a bridge into two components", () => {
    const block = makeBlock([
      { blockStart: 0, blockEnd: 0.4, inlineStart: 0.1, inlineEnd: 0.9 },
      {
        blockStart: 0.4,
        blockEnd: 0.6,
        inlineStart: 0.45,
        inlineEnd: 0.55,
      },
      { blockStart: 0.6, blockEnd: 1, inlineStart: 0.1, inlineEnd: 0.9 },
    ]);

    expect(
      sculptBubbleLayout({
        block,
        strokePoints: [
          { x: 170, y: 200 },
          { x: 230, y: 200 },
        ],
        mode: "subtract",
        radius: 24,
      }),
    ).toEqual({ status: "rejected", reason: "disconnect" });
  });

  it("rejects deleting an entire existing component", () => {
    const block = makeBlock();

    expect(
      sculptBubbleLayout({
        block,
        strokePoints: [{ x: 200, y: 200 }],
        mode: "subtract",
        radius: 180,
      }),
    ).toEqual({ status: "rejected", reason: "empty" });
  });

  it("accepts a draft patch and preserves its vertical direction", () => {
    const block = makeBlock(undefined, "vertical", "manual");
    if (!block.renderBbox || !block.bubbleLayout) {
      throw new Error("test block is missing bubble layout geometry");
    }
    const draft = {
      renderBbox: block.renderBbox,
      renderBboxSpace: "normalized_1000" as const,
      bubbleLayout: block.bubbleLayout,
    };
    const patch = appliedPatch(
      sculptBubbleLayout({
        block: draft,
        strokePoints: [
          { x: 200, y: 285 },
          { x: 200, y: 340 },
        ],
        mode: "add",
        radius: 18,
      }),
    );

    expect(patch.bubbleLayout.direction).toBe("vertical");
    expect(patch.bubbleLayout.origin).toBe("manual");
    expect(isUsableBubbleLayout(patch.bubbleLayout)).toBe(true);
  });

  it("does not mutate bbox, direction, text, or word-break formatting", () => {
    const block = makeBlock();
    block.wordBreak = "keep-all";
    block.translatedText = "원문을 그대로 보존";
    const before = structuredClone(block);

    const patch = appliedPatch(
      sculptBubbleLayout({
        block,
        strokePoints: [
          { x: 285, y: 200 },
          { x: 340, y: 200 },
        ],
        mode: "add",
        radius: 18,
      }),
    );

    expect(block).toEqual(before);
    expect(Object.keys(patch).sort()).toEqual([
      "bubbleLayout",
      "renderBbox",
      "renderBboxSpace",
    ]);
    expect({ ...block, ...patch }).toMatchObject({
      bbox: before.bbox,
      renderDirection: before.renderDirection,
      translatedText: before.translatedText,
      wordBreak: before.wordBreak,
    });
  });
});

function appliedPatch(
  result: ReturnType<typeof sculptBubbleLayout>,
): Extract<typeof result, { status: "applied" }>["patch"] {
  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    throw new Error(`expected applied sculpt, got ${result.reason}`);
  }
  return result.patch;
}

function makeBlock(
  spans: BubbleShapeSpan[] = [
    { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
  ],
  direction: "horizontal" | "vertical" = "horizontal",
  origin: "detected" | "manual" = "detected",
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 130, y: 130, w: 140, h: 140 },
    bboxSpace: "normalized_1000",
    renderBbox: { x: 100, y: 100, w: 200, h: 200 },
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction,
      confidence: 0.9,
      origin,
      modelId: origin === "manual" ? "manual-shape-v1" : "comic-rtdetr-test",
      ...(origin === "detected"
        ? { sourceImageRevision: "source-revision" }
        : {}),
      insetRatio: 0.02,
      regions: [{ spans }],
    },
    sourceText: "原文",
    translatedText: "번역문",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: direction,
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.7,
    autoFitText: true,
  };
}
