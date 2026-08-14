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
const { readDistinctPairGeometry } =
  require("../src/main/runtime/semantic-ocr/anime-text-distinct-region-geometry.cjs") as {
    readDistinctPairGeometry: (
      left: Record<string, unknown>,
      right: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  };
const { hasPotentialSharedAnimeTextRelation } =
  require("../src/main/runtime/semantic-ocr/anime-text-review-relations.cjs") as {
    hasPotentialSharedAnimeTextRelation: (
      candidates: Record<string, unknown>[],
    ) => boolean;
  };
const { isNearHostHan } =
  require("../src/main/runtime/semantic-ocr/group-only-review-deferred-ruby-geometry.cjs") as {
    isNearHostHan: (
      satellite: Box,
      hosts: Array<Record<string, unknown>>,
      mode: "vertical" | "horizontal",
    ) => boolean;
  };
const { orderReviewCandidatesByGeometry } =
  require("../src/main/runtime/semantic-ocr/group-only-review-reading-order.cjs") as {
    orderReviewCandidatesByGeometry: <T extends { id: number; bbox: Box }>(
      candidates: T[],
    ) => T[];
  };
const { requiresRelationFreeRoleBaseline } =
  require("../src/main/runtime/semantic-ocr/group-only-review-role-policy.cjs") as {
    requiresRelationFreeRoleBaseline: (
      plan: Record<string, unknown>,
      projection: Record<string, unknown>,
    ) => boolean;
  };
const { integerArray, normalizeFragments, pixelBox } =
  require("../src/main/runtime/semantic-ocr/group-only-review-values.cjs") as {
    integerArray: (value: unknown, label: string) => number[];
    normalizeFragments: (
      value: unknown,
      ids: number[],
    ) => Array<Record<string, unknown>>;
    pixelBox: (value: unknown, label: string) => Box;
  };
const { compareRegions, normalizeCandidateBox } =
  require("../src/main/runtime/semantic-ocr/group-review-crop-geometry.cjs") as {
    compareRegions: (
      left: Record<string, unknown>,
      right: Record<string, unknown>,
    ) => number;
    normalizeCandidateBox: (
      candidate: Record<string, unknown>,
      id: number,
    ) => Box;
  };
const {
  buildPaddleClassifierRecoveryRelations,
  canRecoverCompleteTwoCandidatePaddleGroup,
} =
  require("../src/main/runtime/semantic-ocr/paddle-classifier-recovery.cjs") as {
    buildPaddleClassifierRecoveryRelations: (value: unknown) => unknown[];
    canRecoverCompleteTwoCandidatePaddleGroup: (
      confirmed: Record<string, unknown>,
      deferred: Record<string, unknown>,
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

  it("keeps extracted review helpers fail-closed at their geometry boundaries", () => {
    const horizontalLeft = {
      bbox: { x1: 0, y1: 0, x2: 40, y2: 10 },
      candidates: [{ x1: 0, y1: 0, x2: 40, y2: 10 }],
    };
    const horizontalRight = {
      bbox: { x1: 60, y1: 20, x2: 100, y2: 30 },
      candidates: [{ x1: 60, y1: 20, x2: 100, y2: 30 }],
    };
    expect(
      readDistinctPairGeometry(horizontalLeft, horizontalRight),
    ).toMatchObject({ writingMode: "horizontal" });
    expect(hasPotentialSharedAnimeTextRelation([{}])).toBe(false);
    expect(
      isNearHostHan(
        { x1: 0, y1: 0, x2: 5, y2: 20 },
        [
          {
            text: "かな",
            bbox: { x1: 10, y1: 0, x2: 30, y2: 40 },
          },
        ],
        "vertical",
      ),
    ).toBe(false);

    const single = { id: 1, bbox: { x1: 0, y1: 0, x2: 10, y2: 30 } };
    expect(orderReviewCandidatesByGeometry([single])).toEqual([single]);
    expect(
      orderReviewCandidatesByGeometry([
        single,
        { id: 2, bbox: { x1: 0, y1: 40, x2: 10, y2: 70 } },
        { id: 3, bbox: { x1: 1, y1: 32, x2: 9, y2: 40 } },
      ]).map((candidate) => candidate.id),
    ).toEqual([1, 3, 2]);

    expect(
      requiresRelationFreeRoleBaseline(
        {
          candidates: [
            {
              text: "漢字",
              bbox: { x1: 0, y1: 0, x2: 100, y2: 20 },
              hint: { reviewStatus: "confirmed" },
            },
            {
              text: "かんじ",
              bbox: { x1: 0, y1: 22, x2: 50, y2: 27 },
              hint: { reviewStatus: "confirmed" },
            },
          ],
        },
        {
          labels: [
            { group: 1, role: "body" },
            { group: 1, role: "ruby" },
          ],
        },
      ),
    ).toBe(false);
  });

  it("preserves extracted input validation and deterministic fallback contracts", () => {
    expect(normalizeFragments(undefined, [7])).toEqual([
      {
        fragment: "F001",
        status: "confirmed",
        candidateIds: [7],
      },
    ]);
    expect(() => normalizeFragments([{ ids: [7] }], [7, 8])).toThrow(
      "Fragments must cover every candidate exactly once",
    );
    expect(() => pixelBox([0, 0, 0, 1], "candidate")).toThrow("invalid bbox");
    expect(() => integerArray([1, 1], "candidate ids")).toThrow(
      "unique positive integers",
    );

    const region = (fragmentId: string) => ({
      cropBbox: { x1: 0, y1: 0, x2: 10, y2: 10 },
      fragments: [{ fragmentId }],
    });
    expect(compareRegions(region("F001"), region("F002"))).toBeLessThan(0);
    expect(() => normalizeCandidateBox({ bbox: [0, 0, 1] }, 1)).toThrow(
      "must contain four coordinates",
    );
    expect(() => normalizeCandidateBox({ bbox: [2, 0, 1, 1] }, 2)).toThrow(
      "invalid coordinate order",
    );

    expect(buildPaddleClassifierRecoveryRelations(null)).toEqual([]);
    expect(
      canRecoverCompleteTwoCandidatePaddleGroup(
        { candidates: [] },
        { candidates: [{}], reasons: [] },
      ),
    ).toBe(false);
  });
});
