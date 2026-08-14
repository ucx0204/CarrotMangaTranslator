import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Box = { x1: number; y1: number; x2: number; y2: number };

const require = createRequire(import.meta.url);
const {
  axisCenter,
  axisGap,
  axisLength,
  axisOverlapRatio,
  boxArea,
  boxIntersectionArea,
  unionBoxPair,
  unionBoxes,
} = require("../src/main/runtime/semantic-ocr/box-geometry.cjs") as {
  axisCenter: (box: Box, axis: "x" | "y") => number;
  axisGap: (left: Box, right: Box, axis: "x" | "y") => number;
  axisLength: (box: Box, axis: "x" | "y") => number;
  axisOverlapRatio: (left: Box, right: Box, axis: "x" | "y") => number;
  boxArea: (box: Box) => number;
  boxIntersectionArea: (left: Box, right: Box) => number;
  unionBoxPair: (left: Box, right: Box) => Box;
  unionBoxes: (boxes: Box[]) => Box;
};
const { pairCrossesDistinctRegionBarrier } =
  require("../src/main/runtime/semantic-ocr/group-only-review-plan.cjs") as {
    pairCrossesDistinctRegionBarrier: (
      plan: Record<string, unknown>,
      leftIds: number[],
      rightIds: number[],
    ) => boolean;
  };

describe("semantic OCR geometry contracts", () => {
  it("keeps touching, one-pixel, overlap, and union boundaries exact", () => {
    const left = { x1: 0, y1: 2, x2: 1, y2: 8 };
    const touching = { x1: 1, y1: 4, x2: 5, y2: 10 };
    const overlapping = { x1: 0.5, y1: 5, x2: 2.5, y2: 7 };

    expect(axisLength(left, "x")).toBe(1);
    expect(axisCenter(left, "y")).toBe(5);
    expect(axisGap(left, touching, "x")).toBe(0);
    expect(axisOverlapRatio(left, touching, "x")).toBe(0);
    expect(boxIntersectionArea(left, touching)).toBe(0);
    expect(axisOverlapRatio(left, overlapping, "y")).toBe(1);
    expect(boxIntersectionArea(left, overlapping)).toBe(1);
    expect(boxArea(left)).toBe(6);
    expect(unionBoxPair(left, touching)).toEqual({
      x1: 0,
      y1: 2,
      x2: 5,
      y2: 10,
    });
    expect(unionBoxes([left, touching, overlapping])).toEqual({
      x1: 0,
      y1: 2,
      x2: 5,
      y2: 10,
    });
  });

  it("enforces qualified barriers forward and reverse but ignores malformed relations", () => {
    const relation = {
      kind: "distinct_anime_text_regions",
      strength: "conservative_merge_barrier",
      recommendedAction: "keep_fragments_separate",
      reviewContextId: "review-1",
      fragments: [
        {
          fragmentId: "F001",
          candidateIds: [1, 2],
          regionId: "ATY001",
        },
        {
          fragmentId: "F002",
          candidateIds: [3, 4],
          regionId: "ATY002",
        },
      ],
    };
    const plan = {
      upstreamFragments: [
        { fragment: "F001", status: "confirmed", candidateIds: [1, 2] },
        { fragment: "F002", status: "confirmed", candidateIds: [3, 4] },
      ],
      spatialRelations: { distinctAnimeTextRegionBarriers: [relation] },
    };

    expect(pairCrossesDistinctRegionBarrier(plan, [1], [4])).toBe(true);
    expect(pairCrossesDistinctRegionBarrier(plan, [3], [2])).toBe(true);
    expect(pairCrossesDistinctRegionBarrier(plan, [1], [2])).toBe(false);
    expect(
      pairCrossesDistinctRegionBarrier(
        {
          ...plan,
          spatialRelations: {
            distinctAnimeTextRegionBarriers: [
              { ...relation, fragments: [null, {}] },
            ],
          },
        },
        [1],
        [4],
      ),
    ).toBe(false);
    expect(
      pairCrossesDistinctRegionBarrier(
        {
          ...plan,
          spatialRelations: {
            distinctAnimeTextRegionBarriers: [
              { ...relation, recommendedAction: "merge_fragments" },
            ],
          },
        },
        [1],
        [4],
      ),
    ).toBe(false);
  });
});
