import { describe, expect, it } from "vitest";
import {
  isUsableBubbleLayout,
  type BubbleLayout,
} from "../src/shared/bubbleLayout";
import {
  applyBubbleLayoutPadding,
  applyBubbleLayoutPaddingToBounds,
  resolveBubbleLayoutPaddingRatio,
} from "../src/shared/bubbleLayoutPadding";

describe("bubble layout padding", () => {
  it("leaves the existing safe shape untouched at zero padding", () => {
    const layout = makeLayout();

    expect(applyBubbleLayoutPadding(layout, 0)).toBe(layout);
  });

  it("uses the default 12% as a total axis reduction around each region", () => {
    const layout = applyBubbleLayoutPadding(makeLayout(), undefined);
    const span = layout.regions[0]?.spans[0];

    expect(span?.blockStart).toBeCloseTo(0.148);
    expect(span?.blockEnd).toBeCloseTo(0.852);
    expect(span?.inlineStart).toBeCloseTo(0.236);
    expect(span?.inlineEnd).toBeCloseTo(0.764);
    expect((span?.blockEnd ?? 0) - (span?.blockStart ?? 0)).toBeCloseTo(
      0.8 * 0.88,
    );
    expect((span?.inlineEnd ?? 0) - (span?.inlineStart ?? 0)).toBeCloseTo(
      0.6 * 0.88,
    );
    expect(layout.insetRatio).toBe(0.04);
  });

  it("keeps 30% of every region at the maximum 70% padding", () => {
    const layout = applyBubbleLayoutPadding(makeLayout(), 0.7);
    const span = layout.regions[0]?.spans[0];

    expect((span?.blockEnd ?? 0) - (span?.blockStart ?? 0)).toBeCloseTo(
      0.8 * 0.3,
    );
    expect((span?.inlineEnd ?? 0) - (span?.inlineStart ?? 0)).toBeCloseTo(
      0.6 * 0.3,
    );
    expect(span?.blockStart).toBeLessThan(span?.blockEnd ?? 0);
    expect(span?.inlineStart).toBeLessThan(span?.inlineEnd ?? 0);
  });

  it("rebases padded metadata while reporting its physical crop envelope", () => {
    const padded = applyBubbleLayoutPaddingToBounds(makeLayout(), 0.7);
    const span = padded.bubbleLayout.regions[0]?.spans[0];

    expect(padded.envelope.blockStart).toBeCloseTo(0.38);
    expect(padded.envelope.blockEnd).toBeCloseTo(0.62);
    expect(padded.envelope.inlineStart).toBeCloseTo(0.41);
    expect(padded.envelope.inlineEnd).toBeCloseTo(0.59);
    expect(span?.blockStart).toBeCloseTo(0);
    expect(span?.blockEnd).toBeCloseTo(1);
    expect(span?.inlineStart).toBeCloseTo(0);
    expect(span?.inlineEnd).toBeCloseTo(1);
    expect(isUsableBubbleLayout(padded.bubbleLayout)).toBe(true);
  });

  it("clamps finite values and falls back for invalid input", () => {
    expect(resolveBubbleLayoutPaddingRatio(-1)).toBe(0);
    expect(resolveBubbleLayoutPaddingRatio(1)).toBe(0.7);
    expect(resolveBubbleLayoutPaddingRatio(Number.NaN)).toBe(0.12);
  });
});

function makeLayout(): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    origin: "detected",
    modelId: "test-model",
    sourceImageRevision: "revision",
    insetRatio: 0.04,
    regions: [
      {
        spans: [
          {
            blockStart: 0.1,
            blockEnd: 0.9,
            inlineStart: 0.2,
            inlineEnd: 0.8,
          },
        ],
      },
    ],
  };
}
