import { describe, expect, it } from "vitest";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import { resolveDisjointBubbleLayout } from "../src/shared/bubbleLayoutDisjoint";

describe("generated bubble region overlap fallback", () => {
  it("partitions overlapping side-by-side regions with a four-pixel gutter", () => {
    const layout = detectedLayout([
      region(0, 1, 0.05, 0.6),
      region(0, 1, 0.4, 0.95),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 200,
    });

    expect(result).not.toBe(layout);
    expect(result?.regions[0]?.spans[0]).toMatchObject({
      inlineStart: 0.05,
      inlineEnd: 0.49,
    });
    expect(result?.regions[1]?.spans[0]).toMatchObject({
      inlineStart: 0.51,
      inlineEnd: 0.95,
    });
  });

  it("partitions vertically stacked regions on the physical block axis", () => {
    const layout = detectedLayout([
      region(0, 0.62, 0.1, 0.9),
      region(0.38, 1, 0.1, 0.9),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 200,
      inlineExtentPx: 100,
    });

    expect(result?.regions[0]?.spans.at(-1)?.blockEnd).toBeCloseTo(0.49);
    expect(result?.regions[1]?.spans[0]?.blockStart).toBeCloseTo(0.51);
  });

  it("normalizes the same physical gutter for vertical-writing axes", () => {
    const layout = {
      ...detectedLayout([region(0, 1, 0.05, 0.6), region(0, 1, 0.4, 0.95)]),
      direction: "vertical" as const,
    };
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 120,
      inlineExtentPx: 300,
    });
    const gapRatio =
      (result?.regions[1]?.spans[0]?.inlineStart ?? 0) -
      (result?.regions[0]?.spans[0]?.inlineEnd ?? 1);

    expect(gapRatio * 300).toBeCloseTo(4);
  });

  it("moves the contact cut by band for diagonally offset lobes", () => {
    const layout = detectedLayout([
      {
        spans: [
          {
            blockStart: 0.1,
            blockEnd: 0.5,
            inlineStart: 0.05,
            inlineEnd: 0.65,
          },
          {
            blockStart: 0.5,
            blockEnd: 0.7,
            inlineStart: 0.05,
            inlineEnd: 0.65,
          },
        ],
      },
      {
        spans: [
          {
            blockStart: 0.3,
            blockEnd: 0.5,
            inlineStart: 0.35,
            inlineEnd: 0.95,
          },
          {
            blockStart: 0.5,
            blockEnd: 0.9,
            inlineStart: 0.35,
            inlineEnd: 0.95,
          },
        ],
      },
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 200,
      inlineExtentPx: 200,
    });
    const sharedBands = result?.regions[0]?.spans.filter(
      (span) => span.blockStart >= 0.3 && span.blockEnd <= 0.7,
    );

    expect(sharedBands).toHaveLength(2);
    expect(sharedBands?.[0]?.inlineEnd).toBeGreaterThan(
      sharedBands?.[1]?.inlineEnd ?? 1,
    );
  });

  it("widens a diagonal corner contact to the requested physical gutter", () => {
    const layout = detectedLayout([
      region(0.05, 0.49, 0.05, 0.49),
      region(0.51, 0.95, 0.51, 0.95),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 100,
    });
    const first = result?.regions[0]?.spans.at(-1);
    const second = result?.regions[1]?.spans[0];
    const blockGapPx =
      ((second?.blockStart ?? 0) - (first?.blockEnd ?? 1)) * 100;
    const inlineGapPx =
      ((second?.inlineStart ?? 0) - (first?.inlineEnd ?? 1)) * 100;

    expect(Math.hypot(blockGapPx, inlineGapPx)).toBeGreaterThanOrEqual(
      4 - 1e-7,
    );
  });

  it("does not rewrite already separated generated regions", () => {
    const layout = detectedLayout([
      region(0, 1, 0.05, 0.45),
      region(0, 1, 0.55, 0.95),
    ]);

    expect(
      resolveDisjointBubbleLayout(layout, {
        blockExtentPx: 100,
        inlineExtentPx: 200,
      }),
    ).toBe(layout);
  });

  it("widens a tiny existing gap locally without cutting deep into either shape", () => {
    const layout = detectedLayout([
      region(0, 1, 0.05, 0.7),
      region(0, 1, 0.705, 0.95),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 200,
    });
    const leftEnd = result?.regions[0]?.spans[0]?.inlineEnd ?? 0;
    const rightStart = result?.regions[1]?.spans[0]?.inlineStart ?? 1;

    expect(leftEnd).toBeGreaterThan(0.68);
    expect(rightStart - leftEnd).toBeCloseTo(0.02);
  });

  it("uses reading order to split identical generated regions", () => {
    const layout = detectedLayout([
      region(0, 1, 0.2, 0.8),
      region(0, 1, 0.2, 0.8),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 200,
    });

    expect(result?.regions).toHaveLength(2);
    expect(result?.regions[0]?.spans[0]?.inlineEnd).toBeCloseTo(0.49);
    expect(result?.regions[1]?.spans[0]?.inlineStart).toBeCloseTo(0.51);
  });

  it("drops an impossible later sliver instead of restoring an overlap", () => {
    const layout = detectedLayout([
      region(0, 1, 0.49, 0.51),
      region(0, 1, 0.49, 0.51),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 100,
    });

    expect(result?.regions).toHaveLength(1);
    expect(result?.regions[0]).toEqual(layout.regions[0]);
  });

  it("leaves a real gutter between every pair of three overlapping regions", () => {
    const layout = detectedLayout([
      region(0, 1, 0, 0.5),
      region(0, 1, 0.25, 0.75),
      region(0, 1, 0.5, 1),
    ]);
    const result = resolveDisjointBubbleLayout(layout, {
      blockExtentPx: 100,
      inlineExtentPx: 200,
    });
    const intervals = (result?.regions ?? [])
      .map((item) => item.spans[0])
      .filter((span) => span !== undefined)
      .sort((left, right) => left.inlineStart - right.inlineStart);

    expect(intervals).toHaveLength(3);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(
        (intervals[index]?.inlineStart ?? 0) -
          (intervals[index - 1]?.inlineEnd ?? 1),
      ).toBeGreaterThanOrEqual(0.02 - 1e-7);
    }
  });

  it("leaves user-authored multi-region geometry untouched", () => {
    const layout: BubbleLayout = {
      ...detectedLayout([region(0, 1, 0.05, 0.6), region(0, 1, 0.4, 0.95)]),
      origin: "manual",
      modelId: "manual-shape-v1",
      sourceImageRevision: undefined,
    };

    expect(
      resolveDisjointBubbleLayout(layout, {
        blockExtentPx: 100,
        inlineExtentPx: 200,
      }),
    ).toBe(layout);
  });
});

function detectedLayout(regions: BubbleLayout["regions"]): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    origin: "detected",
    modelId: "comic-rtdetr-bubble-v1",
    sourceImageRevision: "revision-1",
    insetRatio: 0.04,
    regions,
  };
}

function region(
  blockStart: number,
  blockEnd: number,
  inlineStart: number,
  inlineEnd: number,
): BubbleLayout["regions"][number] {
  return {
    spans: [{ blockStart, blockEnd, inlineStart, inlineEnd }],
  };
}
