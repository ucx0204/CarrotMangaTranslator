import { describe, expect, it } from "vitest";
import type {
  BubbleLayout,
  BubbleShapeRegion,
} from "../src/shared/bubbleLayout";
import {
  MIN_BUBBLE_TEXT_LAYOUT_CONFIDENCE,
  resolveBubbleRegionLineInterval,
  resolveBubbleTextSlotPlans,
} from "../src/renderer/src/lib/bubbleTextLayout";
import { assessWrappedTextQuality } from "../src/renderer/src/lib/bubbleTextWrapping";
import type { BlockTextLine } from "../src/renderer/src/lib/overlayTextWrapping";

describe("bubble text slot geometry", () => {
  it("intersects every scanline band touched by the full line height", () => {
    const region: BubbleShapeRegion = {
      spans: [
        {
          blockStart: 0.2,
          blockEnd: 0.4,
          inlineStart: 0.1,
          inlineEnd: 0.9,
        },
        {
          blockStart: 0.4,
          blockEnd: 0.6,
          inlineStart: 0.25,
          inlineEnd: 0.75,
        },
      ],
    };

    expect(resolveBubbleRegionLineInterval(region, 0.3, 0.5)).toEqual({
      inlineStart: 0.25,
      inlineEnd: 0.75,
    });
  });

  it("rejects a line band when shape scanlines leave a coverage gap", () => {
    const region: BubbleShapeRegion = {
      spans: [
        {
          blockStart: 0.2,
          blockEnd: 0.39,
          inlineStart: 0.1,
          inlineEnd: 0.9,
        },
        {
          blockStart: 0.41,
          blockEnd: 0.6,
          inlineStart: 0.2,
          inlineEnd: 0.8,
        },
      ],
    };

    expect(resolveBubbleRegionLineInterval(region, 0.3, 0.5)).toBeNull();
  });

  it("flows centered slot plans through fused regions in reading order", () => {
    const plans = resolveBubbleTextSlotPlans(
      makeLayout([makeRegion(0.1, 0.45), makeRegion(0.55, 0.9)]),
      {
        blockExtentPx: 100,
        inlineExtentPx: 200,
        fontWidthScale: 1,
        lineHeightPx: 50,
        renderDirection: "horizontal",
      },
    );

    expect(plans.map((plan) => plan.length)).toEqual([1, 2, 2, 3, 3, 4]);
    expect(plans[0]?.[0]).toMatchObject({
      blockOffsetPx: 25,
      inlineOffsetPx: 20,
      availableWidth: 70,
      regionIndex: 0,
    });
    expect(plans[1]?.map((slot) => slot.regionIndex)).toEqual([0, 1]);
    expect(plans[1]?.at(-1)).toMatchObject({
      blockOffsetPx: 25,
      availableWidth: 70,
      regionIndex: 1,
    });
    expect(plans[1]?.at(-1)?.inlineOffsetPx).toBeCloseTo(110);
  });

  it("keeps slots from legacy overlapping generated regions disjoint", () => {
    const plans = resolveBubbleTextSlotPlans(
      {
        ...makeLayout([makeRegion(0.05, 0.6), makeRegion(0.4, 0.95)]),
        origin: "detected",
        modelId: "comic-rtdetr-bubble-v1",
        sourceImageRevision: "revision-1",
      },
      {
        blockExtentPx: 100,
        inlineExtentPx: 200,
        fontWidthScale: 1,
        lineHeightPx: 50,
        renderDirection: "horizontal",
      },
    );
    const twoRegionPlan = plans.find(
      (plan) =>
        plan.length === 2 &&
        plan[0]?.regionIndex === 0 &&
        plan[1]?.regionIndex === 1,
    );
    const first = twoRegionPlan?.[0];
    const second = twoRegionPlan?.[1];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(
      (first?.inlineOffsetPx ?? 0) + (first?.availableWidth ?? 0),
    ).toBeLessThanOrEqual(second?.inlineOffsetPx ?? 0);
    expect(
      (second?.inlineOffsetPx ?? 0) -
        ((first?.inlineOffsetPx ?? 0) + (first?.availableWidth ?? 0)),
    ).toBeCloseTo(4);
  });

  it("builds vertical columns right-to-left in the unscaled bubble plane", () => {
    const plans = resolveBubbleTextSlotPlans(
      {
        ...makeLayout([
          {
            spans: [
              {
                blockStart: 0.5,
                blockEnd: 1,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
            ],
          },
        ]),
        direction: "vertical",
      },
      {
        blockExtentPx: 200,
        inlineExtentPx: 300,
        fontWidthScale: 0.8,
        lineHeightPx: 40,
        renderDirection: "vertical",
      },
    );

    expect(plans.map((plan) => plan.length)).toEqual([1, 2]);
    expect(plans[0]?.[0]).toEqual({
      blockOffsetPx: 162.5,
      inlineOffsetPx: 30,
      availableWidth: 240,
      regionIndex: 0,
    });
    expect(plans[1]?.map((slot) => slot.blockOffsetPx)).toEqual([187.5, 137.5]);
  });

  it("falls back for low-confidence or direction-mismatched metadata", () => {
    const base = makeLayout([makeRegion(0.1, 0.9)]);
    const input = {
      blockExtentPx: 100,
      inlineExtentPx: 200,
      fontWidthScale: 1,
      lineHeightPx: 20,
      renderDirection: "horizontal" as const,
    };

    expect(
      resolveBubbleTextSlotPlans(
        { ...base, confidence: MIN_BUBBLE_TEXT_LAYOUT_CONFIDENCE - 0.01 },
        input,
      ),
    ).toEqual([]);
    expect(
      resolveBubbleTextSlotPlans({ ...base, direction: "vertical" }, input),
    ).toEqual([]);
    expect(
      resolveBubbleTextSlotPlans(
        { ...base, direction: "vertical" },
        { ...input, renderDirection: "vertical" },
      ),
    ).not.toEqual([]);
  });

  it("counts Korean intra-word splits and one-grapheme orphan lines", () => {
    const text = "이전에 이런 일이 있었습니다";
    const baseline = [
      makeTextLine("이전에 "),
      makeTextLine("이런 일이 "),
      makeTextLine("있었습니다"),
    ];
    const damaged = [
      makeTextLine("이전"),
      makeTextLine("에 "),
      makeTextLine("이런 "),
      makeTextLine("일"),
      makeTextLine("이 있었습"),
      makeTextLine("니다"),
    ];

    expect(assessWrappedTextQuality(text, baseline)).toEqual({
      intraWordSplitCount: 0,
      orphanLineCount: 0,
      lineCount: 3,
      semanticGraphemeCount: 12,
      averageSemanticGraphemesPerLine: 4,
    });
    expect(assessWrappedTextQuality(text, damaged)).toEqual({
      intraWordSplitCount: 3,
      orphanLineCount: 2,
      lineCount: 6,
      semanticGraphemeCount: 12,
      averageSemanticGraphemesPerLine: 2,
    });
  });

  it("does not count an explicit newline as an intra-word split", () => {
    expect(
      assessWrappedTextQuality("좋은 무기를\n골라.", [
        makeTextLine("좋은 무기를"),
        makeTextLine("골라."),
      ]),
    ).toEqual({
      intraWordSplitCount: 0,
      orphanLineCount: 0,
      lineCount: 2,
      semanticGraphemeCount: 7,
      averageSemanticGraphemesPerLine: 3.5,
    });
  });
});

function makeLayout(regions: BubbleShapeRegion[]): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    insetRatio: 0.04,
    regions,
  };
}

function makeRegion(inlineStart: number, inlineEnd: number): BubbleShapeRegion {
  return {
    spans: [
      {
        blockStart: 0,
        blockEnd: 1,
        inlineStart,
        inlineEnd,
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
