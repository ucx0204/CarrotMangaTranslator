import { describe, expect, it } from "vitest";
import {
  distinctBalloonCandidates,
  distinctUpstreamFragments,
  mangaElevenInternalPaddleCandidates,
  mangaFiveSingletonCandidates,
} from "./fixtures/animeTextDistinctCases";

const {
  buildAnimeTextSpatialRelations,
  hasPotentialAnimeTextRelation,
  qualifyAnimeTextRelationRegionIds,
  qualifySharedAnimeTextRelationRegionIds,
} =
  require("../src/main/runtime/semantic-ocr/anime-text-review-relations.cjs") as {
    buildAnimeTextSpatialRelations: (
      candidates: Array<Record<string, unknown>>,
    ) => {
      sharedAnimeTextRegions: Array<Record<string, unknown>>;
      distinctAnimeTextRegionBarriers?: Array<Record<string, unknown>>;
      paddleClassifierRecoveries?: Array<Record<string, unknown>>;
    };
    hasPotentialAnimeTextRelation: (
      candidates: Array<Record<string, unknown>>,
    ) => boolean;
    qualifyAnimeTextRelationRegionIds: (
      candidates: Array<Record<string, unknown>>,
    ) => string[];
    qualifySharedAnimeTextRelationRegionIds: (
      candidates: Array<Record<string, unknown>>,
    ) => string[];
  };
const {
  buildGroupOnlyReviewPlan,
  buildGroupOnlyReviewPrompt,
  parseGroupOnlyReviewResponse,
  reviewGroupOnlyCrop,
} = require("../src/main/runtime/semantic-ocr/group-only-review.cjs") as {
  buildGroupOnlyReviewPlan: (
    value: Record<string, unknown>,
  ) => Record<string, unknown>;
  buildGroupOnlyReviewPrompt: (value: Record<string, unknown>) => string;
  parseGroupOnlyReviewResponse: (
    value: string,
    plan: Record<string, unknown>,
  ) => {
    groups: Array<{ candidateIds: number[] }>;
  };
  reviewGroupOnlyCrop: (
    value: Record<string, unknown>,
    region: Record<string, unknown>,
    request: (
      payload: Record<string, unknown>,
    ) => Promise<{ outputText: string; rawResponse: unknown }>,
  ) => Promise<{
    labels: Array<{ group: number; role: "body" | "ruby" }>;
    requestCount: number;
    groups: Array<{
      candidateIds: number[];
      bodyCandidateIds: number[];
      rubyCandidateIds: number[];
    }>;
    rawResponse: unknown;
  }>;
};

const sharedRegion = {
  animeTextRegionId: "ATY001",
  animeTextRegionScore: 0.8443,
  animeTextRegionBbox: [1015.7, 1199.8, 1145.8, 1427.3],
  animeTextEvidenceVersion: 1,
  animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
};

function targetPageCandidates(): Array<Record<string, unknown>> {
  return [
    {
      id: 8,
      x1: 1057,
      y1: 1203,
      x2: 1107,
      y2: 1357,
      ocrText: "心を風に",
      reviewFragmentId: "B004",
      reviewStatus: "confirmed",
      reviewOrder: 1,
      animeTextContainment: 1,
      ...sharedRegion,
    },
    {
      id: 11,
      x1: 1018,
      y1: 1207,
      x2: 1059,
      y2: 1426,
      ocrText: "しているから",
      reviewFragmentId: "B004",
      reviewStatus: "confirmed",
      reviewOrder: 2,
      animeTextContainment: 1,
      ...sharedRegion,
    },
    {
      id: 7,
      x1: 1101,
      y1: 1202,
      x2: 1151,
      y2: 1256,
      ocrText: "今",
      reviewFragmentId: "D001",
      reviewStatus: "deferred",
      reviewOrder: 1,
      animeTextContainment: 0.9,
      ...sharedRegion,
    },
  ];
}

function overlappingBalloonCandidates(): Array<Record<string, unknown>> {
  return [
    [18, "B008", 1115, 1253, 1157, 1387, "あいえ"],
    [17, "B008", 1067, 1252, 1117, 1441, "ご心配なく"],
    [22, "B011", 1030, 1410, 1076, 1664, "子供扱いなんて"],
    [23, "B011", 986, 1413, 1031, 1663, "いたしませんわ"],
  ].map(([id, fragment, x1, y1, x2, y2, ocrText], index) => ({
    id,
    x1,
    y1,
    x2,
    y2,
    ocrText,
    reviewFragmentId: fragment,
    reviewStatus: "confirmed",
    reviewOrder: (index % 2) + 1,
    animeTextContainment: 1,
    animeTextRegionId: "ATY008",
    animeTextRegionScore: 0.8609,
    animeTextRegionBbox: [977.1, 1236.6, 1162.4, 1689.6],
    animeTextEvidenceVersion: 1,
    animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
  }));
}

describe("anime-text-yolo review-only contract", () => {
  it("surfaces the actual 9.1-page shared region as a weak relation", () => {
    const candidates = targetPageCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const plan = buildGroupOnlyReviewPlan({
      candidates,
      candidateOrder: [8, 11, 7],
      upstreamFragments: [
        {
          fragment: "B004",
          status: "confirmed",
          candidateIds: [8, 11],
        },
        {
          fragment: "D001",
          status: "deferred",
          candidateIds: [7],
        },
      ],
      spatialRelations,
    });

    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual(["ATY001"]);
    expect(qualifySharedAnimeTextRelationRegionIds(candidates)).toEqual([
      "ATY001",
    ]);
    expect(spatialRelations.sharedAnimeTextRegions).toEqual([
      expect.objectContaining({
        kind: "shared_anime_text_region",
        strength: "auxiliary_review_hint",
        basis: "detector_plus_aligned_reading_start",
        recommendedAction: "merge_unless_visible_separator",
        regionId: "ATY001",
        candidateIds: [8, 11, 7],
        alignment: expect.objectContaining({
          writingMode: "vertical",
          startDeltaPx: 1,
        }),
      }),
    ]);
    expect(buildGroupOnlyReviewPrompt(plan)).toContain(
      "the listed candidateIds must share one final group",
    );
    expect(buildGroupOnlyReviewPrompt(plan)).toContain(
      "a missing shared Paddle group are not visible separators",
    );
    expect(
      parseGroupOnlyReviewResponse(
        '{"labels":[{"group":1,"role":"body"},{"group":1,"role":"body"},{"group":1,"role":"body"}]}',
        plan,
      ).groups.map((group) => group.candidateIds),
    ).toEqual([[7, 8, 11]]);
  });

  it("uses one relation-aware request when returned roles are geometrically stable", async () => {
    const candidates = targetPageCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const reviewCase = {
      candidates,
      candidateOrder: [8, 11, 7],
      upstreamFragments: [
        {
          fragment: "B004",
          status: "confirmed",
          candidateIds: [8, 11],
        },
        {
          fragment: "D001",
          status: "deferred",
          candidateIds: [7],
        },
      ],
      spatialRelations,
    };
    const requests: Array<Record<string, unknown>> = [];
    const result = await reviewGroupOnlyCrop(
      reviewCase,
      { cropBbox: { x1: 1000, y1: 1180, x2: 1170, y2: 1440 } },
      async (payload) => {
        requests.push(payload);
        return {
          outputText: JSON.stringify({
            labels: [
              { group: 1, role: "body" },
              { group: 1, role: "body" },
              { group: 1, role: "body" },
            ],
          }),
          rawResponse: { purpose: payload.reviewPurpose },
        };
      },
    );

    expect(requests.map((request) => request.reviewPurpose)).toEqual([
      "relation-aware-grouping",
    ]);
    expect(String(requests[0].prompt)).toContain("shared_anime_text_region");
    expect(result).toMatchObject({
      requestCount: 1,
      labels: [
        { group: 1, role: "body" },
        { group: 1, role: "body" },
        { group: 1, role: "body" },
      ],
      rawResponse: { purpose: "relation-aware-grouping" },
    });
    expect(result.groups).toEqual([
      expect.objectContaining({
        candidateIds: [7, 8, 11],
        bodyCandidateIds: [7, 8, 11],
        rubyCandidateIds: [],
      }),
    ]);
  });

  it("requests a relation-free role baseline for an unhosted ruby label", async () => {
    const reviewCase = rolePolicyReviewCase([
      roleCandidate(21, "育成", 764, 1270, 808, 1356, "B001"),
      roleCandidate(20, "したいか…", 728, 1266, 778, 1389, "B001"),
      roleCandidate(22, "そりゃ", 793, 1271, 837, 1361, "D001"),
    ]);
    const requests: string[] = [];
    const result = await reviewGroupOnlyCrop(
      reviewCase,
      { cropBbox: { x1: 700, y1: 1240, x2: 860, y2: 1410 } },
      async (payload) => {
        const purpose = String(payload.reviewPurpose);
        requests.push(purpose);
        return {
          outputText: JSON.stringify({
            labels:
              purpose === "relation-aware-grouping"
                ? [
                    { group: 1, role: "body" },
                    { group: 1, role: "body" },
                    { group: 1, role: "ruby" },
                  ]
                : [
                    { group: 1, role: "body" },
                    { group: 1, role: "body" },
                    { group: 1, role: "body" },
                  ],
          }),
          rawResponse: { purpose },
        };
      },
    );

    expect(requests).toEqual([
      "relation-aware-grouping",
      "relation-free-role-baseline",
    ]);
    expect(result.requestCount).toBe(2);
    expect(result.labels).toEqual([
      { group: 1, role: "body" },
      { group: 1, role: "body" },
      { group: 1, role: "body" },
    ]);
  });

  it("requests a role baseline when a long narrow reading aid is missed", async () => {
    const reviewCase = rolePolicyReviewCase([
      roleCandidate(18, "メイクが", 817, 723, 850, 841, "B001"),
      roleCandidate(17, "ぜんじだいてき", 801, 723, 823, 842, "B001"),
      roleCandidate(15, "前時代的", 774, 720, 806, 842, "B001"),
      roleCandidate(16, "過ぎるわね", 732, 721, 764, 869, "B001"),
    ]);
    const requests: string[] = [];
    const result = await reviewGroupOnlyCrop(
      reviewCase,
      { cropBbox: { x1: 700, y1: 690, x2: 880, y2: 900 } },
      async (payload) => {
        const purpose = String(payload.reviewPurpose);
        requests.push(purpose);
        return {
          outputText: JSON.stringify({
            labels: [
              { group: 1, role: "body" },
              {
                group: 1,
                role:
                  purpose === "relation-free-role-baseline" ? "ruby" : "body",
              },
              { group: 1, role: "body" },
              { group: 1, role: "body" },
            ],
          }),
          rawResponse: { purpose },
        };
      },
    );

    expect(requests).toEqual([
      "relation-aware-grouping",
      "relation-free-role-baseline",
    ]);
    expect(result.labels[1]).toEqual({ group: 1, role: "ruby" });
    expect(result.requestCount).toBe(2);
  });

  it("does not duplicate the request for a ruby with a plausible host", async () => {
    const reviewCase = rolePolicyReviewCase([
      roleCandidate(11, "倒したのか…", 834, 1068, 876, 1266, "B001"),
      roleCandidate(13, "た", 886, 1072, 921, 1112, "D001"),
    ]);
    const requests: string[] = [];
    const result = await reviewGroupOnlyCrop(
      reviewCase,
      { cropBbox: { x1: 810, y1: 1040, x2: 940, y2: 1290 } },
      async (payload) => {
        requests.push(String(payload.reviewPurpose));
        return {
          outputText:
            '{"labels":[{"group":1,"role":"body"},{"group":1,"role":"ruby"}]}',
          rawResponse: { purpose: payload.reviewPurpose },
        };
      },
    );

    expect(requests).toEqual(["relation-aware-grouping"]);
    expect(result.requestCount).toBe(1);
    expect(result.labels[1]).toEqual({ group: 1, role: "ruby" });
  });

  it("rejects a page-wide region that also contains a second confirmed fragment", () => {
    const candidates = [
      ...targetPageCandidates(),
      {
        id: 12,
        x1: 970,
        y1: 1204,
        x2: 1015,
        y2: 1390,
        ocrText: "別の吹き出し",
        reviewFragmentId: "B005",
        reviewStatus: "confirmed",
        reviewOrder: 1,
        animeTextContainment: 0.92,
        ...sharedRegion,
      },
    ];

    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(buildAnimeTextSpatialRelations(candidates)).toEqual({
      sharedAnimeTextRegions: [],
    });
  });

  it("rejects a region when only part of either fragment is annotated", () => {
    const candidates = targetPageCandidates().map((candidate) =>
      candidate.id === 11 ? withoutAnimeTextEvidence(candidate) : candidate,
    );

    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(buildAnimeTextSpatialRelations(candidates)).toEqual({
      sharedAnimeTextRegions: [],
    });
  });

  it("rejects forbidden deferred hosts before exposing a relation", () => {
    const candidates = targetPageCandidates().map((candidate) =>
      candidate.reviewStatus === "deferred"
        ? {
            ...candidate,
            reviewReasons: ["oversized_display_text"],
          }
        : candidate,
    );

    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(buildAnimeTextSpatialRelations(candidates)).toEqual({
      sharedAnimeTextRegions: [],
    });
  });

  it("treats malformed or inconsistent evidence as an optional no-op", () => {
    const candidates = targetPageCandidates().map((candidate) =>
      candidate.id === 7
        ? {
            ...candidate,
            animeTextRegionBbox: [1015.7, 1199.8, 1200, 1427.3],
          }
        : candidate,
    );

    expect(() => qualifyAnimeTextRelationRegionIds(candidates)).not.toThrow();
    expect(() => buildAnimeTextSpatialRelations(candidates)).not.toThrow();
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(buildAnimeTextSpatialRelations(candidates)).toEqual({
      sharedAnimeTextRegions: [],
    });
  });

  it("does not create a positive relation for the actual overlapping-balloon counterexample", () => {
    const candidates = overlappingBalloonCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const plan = buildGroupOnlyReviewPlan({
      candidates,
      candidateOrder: [18, 17, 22, 23],
      upstreamFragments: [
        {
          fragment: "B008",
          status: "confirmed",
          candidateIds: [18, 17],
        },
        {
          fragment: "B011",
          status: "confirmed",
          candidateIds: [22, 23],
        },
      ],
      spatialRelations,
    });

    expect(spatialRelations).toEqual({ sharedAnimeTextRegions: [] });
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(
      parseGroupOnlyReviewResponse(
        '{"labels":[{"group":1,"role":"body"},{"group":1,"role":"body"},{"group":2,"role":"body"},{"group":2,"role":"body"}]}',
        plan,
      ).groups.map((group) => group.candidateIds),
    ).toEqual([
      [18, 17],
      [22, 23],
    ]);
  });

  it("keeps the overlapping balloons separable even when one fragment is deferred and shares the YOLO region", () => {
    const candidates = overlappingBalloonCandidates().map((candidate) =>
      candidate.reviewFragmentId === "B011"
        ? {
            ...candidate,
            reviewFragmentId: "D011",
            reviewStatus: "deferred",
          }
        : candidate,
    );
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const plan = buildGroupOnlyReviewPlan({
      candidates,
      candidateOrder: [18, 17, 22, 23],
      upstreamFragments: [
        {
          fragment: "B008",
          status: "confirmed",
          candidateIds: [18, 17],
        },
        {
          fragment: "D011",
          status: "deferred",
          candidateIds: [22, 23],
        },
      ],
      spatialRelations,
    });

    expect(spatialRelations).toEqual({ sharedAnimeTextRegions: [] });
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(
      parseGroupOnlyReviewResponse(
        '{"labels":[{"group":1,"role":"body"},{"group":1,"role":"body"},{"group":2,"role":"body"},{"group":2,"role":"body"}]}',
        plan,
      ).groups.map((group) => group.candidateIds),
    ).toEqual([
      [18, 17],
      [22, 23],
    ]);
  });

  it("emits the auxiliary relation for aligned horizontal rows", () => {
    const candidates = [
      horizontalCandidate(1, "B001", "confirmed", 100, 100, 260, 130),
      horizontalCandidate(2, "D001", "deferred", 102, 135, 250, 165),
    ];

    expect(
      buildAnimeTextSpatialRelations(candidates).sharedAnimeTextRegions,
    ).toEqual([
      expect.objectContaining({
        candidateIds: [1, 2],
        alignment: expect.objectContaining({
          writingMode: "horizontal",
          startDeltaPx: 2,
        }),
      }),
    ]);
  });

  it("rejects detector coverage when horizontal reading starts are misaligned", () => {
    const candidates = [
      horizontalCandidate(1, "B001", "confirmed", 100, 100, 260, 130),
      horizontalCandidate(2, "D001", "deferred", 180, 135, 330, 165),
    ];

    expect(buildAnimeTextSpatialRelations(candidates)).toEqual({
      sharedAnimeTextRegions: [],
    });
  });

  it("emits a hard barrier for the manga (11) two-lobe counterexample", () => {
    const candidates = distinctBalloonCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const plan = buildDistinctBarrierPlan(candidates, spatialRelations);

    expect(hasPotentialAnimeTextRelation(candidates)).toBe(true);
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([
      "ATY101",
      "ATY102",
    ]);
    expect(qualifySharedAnimeTextRelationRegionIds(candidates)).toEqual([]);
    expect(spatialRelations).toEqual({
      sharedAnimeTextRegions: [],
      distinctAnimeTextRegionBarriers: [
        expect.objectContaining({
          kind: "distinct_anime_text_regions",
          strength: "conservative_merge_barrier",
          recommendedAction: "keep_fragments_separate",
          reviewContextId: "RC001",
          paddleGroupId: "G002",
          smallerRegionOverlap: 0,
          fragments: [
            expect.objectContaining({
              fragmentId: "B002",
              candidateIds: [5, 4],
              regionId: "ATY101",
            }),
            expect.objectContaining({
              fragmentId: "B003",
              candidateIds: [6, 7, 9, 8],
              regionId: "ATY102",
            }),
          ],
        }),
      ],
    });
    expect(buildGroupOnlyReviewPrompt(plan)).toContain(
      "is a hard merge barrier",
    );
    expect(buildGroupOnlyReviewPrompt(plan)).toContain(
      "must never share a final group",
    );
  });

  it("emits a hard barrier for the actual 10.2 manga (5) Paddle-less singleton fragments", () => {
    const candidates = mangaFiveSingletonCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const barrier = spatialRelations.distinctAnimeTextRegionBarriers?.[0];

    expect(hasPotentialAnimeTextRelation(candidates)).toBe(true);
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([
      "ATY501",
      "ATY502",
    ]);
    expect(spatialRelations.sharedAnimeTextRegions).toEqual([]);
    expect(barrier).toEqual(
      expect.objectContaining({
        kind: "distinct_anime_text_regions",
        strength: "conservative_merge_barrier",
        reviewContextId: "RC001",
        geometry: {
          writingMode: "vertical",
          characterScale: 51,
          startDeltaPx: 115,
          crossGapPx: 26,
          readingGapPx: 0,
        },
        fragments: [
          expect.objectContaining({
            fragmentId: "B003",
            candidateIds: [9],
            regionId: "ATY501",
            bboxPixels: [1094.7, 407.1, 1144.2, 616.8],
          }),
          expect.objectContaining({
            fragmentId: "B004",
            candidateIds: [10],
            regionId: "ATY502",
            bboxPixels: [1017.1, 520.4, 1067.9, 784.8],
          }),
        ],
      }),
    );
    expect(barrier).not.toHaveProperty("paddleGroupId");
  });

  it("does not hard-split upper and lower OCR chunks of one uninterrupted vertical column", () => {
    const candidates = [
      [1, "B001", 100, 100, 130, 220, "ATY701", [95, 95, 170, 345]],
      [2, "B001", 135, 220, 165, 340, "ATY701", [95, 95, 170, 345]],
      [3, "B002", 105, 390, 135, 510, "ATY702", [100, 385, 175, 635]],
      [4, "B002", 140, 510, 170, 630, "ATY702", [100, 385, 175, 635]],
    ].map(([id, fragment, x1, y1, x2, y2, regionId, regionBbox], index) => ({
      id,
      x1,
      y1,
      x2,
      y2,
      ocrText: `세로조각-${index}`,
      reviewFragmentId: fragment,
      reviewStatus: "confirmed",
      reviewReasons: [],
      reviewContextId: "RC001",
      paddleGroupId: "G001",
      animeTextRegionId: regionId,
      animeTextRegionScore: 0.9,
      animeTextContainment: 1,
      animeTextRegionBbox: regionBbox,
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "hard-negative-fixture",
    }));

    expect(hasPotentialAnimeTextRelation(candidates)).toBe(false);
    expect(
      buildAnimeTextSpatialRelations(candidates)
        .distinctAnimeTextRegionBarriers,
    ).toBeUndefined();
  });

  it("emits an internal split barrier for the actual 10.2 manga (11) two-Paddle-group fragment", () => {
    const candidates = mangaElevenInternalPaddleCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const barrier = spatialRelations.distinctAnimeTextRegionBarriers?.[0];

    expect(hasPotentialAnimeTextRelation(candidates)).toBe(true);
    expect(qualifyAnimeTextRelationRegionIds(candidates)).toEqual([
      "ATY601",
      "ATY602",
    ]);
    expect(spatialRelations.sharedAnimeTextRegions).toEqual([]);
    expect(barrier).toEqual(
      expect.objectContaining({
        kind: "distinct_anime_text_regions",
        strength: "conservative_split_prior",
        recommendedAction: "prefer_fragments_separate",
        sourceFragmentId: "B003",
        paddleGroupIds: ["G002", "G004"],
        geometry: {
          writingMode: "vertical",
          characterScale: 46,
          startDeltaPx: 244,
          crossGapPx: 0,
          readingGapPx: 23,
        },
        fragments: [
          expect.objectContaining({
            fragmentId: "B003::paddle::G002",
            syntheticFragmentId: "B003::paddle::G002",
            sourceFragmentId: "B003",
            paddleGroupId: "G002",
            candidateIds: [6, 7, 9, 8],
            regionId: "ATY601",
            bboxPixels: [180.7, 201.6, 355.7, 433.3],
          }),
          expect.objectContaining({
            fragmentId: "B003::paddle::G004",
            syntheticFragmentId: "B003::paddle::G004",
            sourceFragmentId: "B003",
            paddleGroupId: "G004",
            candidateIds: [12, 14, 15, 13],
            regionId: "ATY602",
            bboxPixels: [83.5, 449.4, 260.3, 648],
          }),
        ],
      }),
    );
    expect(barrier).not.toHaveProperty("reviewContextId");
    expect(barrier).not.toHaveProperty("paddleGroupId");
  });

  it("hard-splits one complete Paddle group when two clear 3-column reading bands have distinct pure detector regions", () => {
    const candidates = mangaSevenReadingBandCandidates();
    const withoutDetector = candidates.map(withoutAnimeTextEvidence);

    expect(hasPotentialAnimeTextRelation(withoutDetector)).toBe(true);
    expect(buildAnimeTextSpatialRelations(withoutDetector)).toEqual({
      sharedAnimeTextRegions: [],
    });

    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const barrier = spatialRelations.distinctAnimeTextRegionBarriers?.[0];
    expect(barrier).toEqual(
      expect.objectContaining({
        kind: "distinct_anime_text_regions",
        strength: "conservative_merge_barrier",
        recommendedAction: "keep_fragments_separate",
        sourceFragmentId: "B006",
        internalPartitionKind: "reading_start_bands",
        paddleGroupId: "G005",
        fragments: [
          expect.objectContaining({
            fragmentId: "B006::band::1",
            partitionKey: "band-1",
            candidateIds: [17, 16, 15],
            regionId: "ATY801",
          }),
          expect.objectContaining({
            fragmentId: "B006::band::2",
            partitionKey: "band-2",
            candidateIds: [23, 24, 22],
            regionId: "ATY802",
          }),
        ],
      }),
    );

    const plan = buildGroupOnlyReviewPlan({
      candidates,
      candidateOrder: candidates.map((candidate) => candidate.id),
      upstreamFragments: [
        {
          fragment: "B006",
          status: "confirmed",
          candidateIds: candidates.map((candidate) => candidate.id),
        },
      ],
      spatialRelations,
    });
    expect(plan.upstreamFragments).toEqual([
      {
        fragment: "B006::band::1",
        status: "confirmed",
        candidateIds: [17, 16, 15],
      },
      {
        fragment: "B006::band::2",
        status: "confirmed",
        candidateIds: [23, 24, 22],
      },
    ]);
    expect(() =>
      parseGroupOnlyReviewResponse(
        JSON.stringify({
          labels: candidates.map(() => ({ group: 1, role: "body" })),
        }),
        plan,
      ),
    ).toThrow(/distinct anime-text regions/i);
  });

  it("emits the exact uncertain-SFX Paddle recovery only for the candidate plan", () => {
    const candidates = [
      {
        id: 15,
        x1: 105,
        y1: 1046,
        x2: 178,
        y2: 1346,
        ocrText: "どうしたの！？",
        reviewFragmentId: "B006",
        reviewStatus: "confirmed",
        reviewReasons: [],
        paddleGroupId: "G005",
        paddleOrder: 2,
        paddleGroupSize: 2,
      },
      {
        id: 14,
        x1: 165,
        y1: 1045,
        x2: 242,
        y2: 1302,
        ocrText: "ギャ～～～！！",
        reviewFragmentId: "D001",
        reviewStatus: "deferred",
        reviewReasons: ["oversized_uncertain_sfx"],
        paddleGroupId: "G005",
        paddleOrder: 1,
        paddleGroupSize: 2,
      },
    ];
    const upstreamFragments = [
      { fragment: "B006", status: "confirmed", candidateIds: [15] },
      { fragment: "D001", status: "deferred", candidateIds: [14] },
    ];
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);

    expect(spatialRelations).toEqual({
      sharedAnimeTextRegions: [],
      paddleClassifierRecoveries: [
        {
          kind: "complete_paddle_classifier_recovery",
          strength: "exact_upstream_fragment_recovery",
          basis:
            "complete_two_candidate_paddle_group_split_only_by_uncertain_sfx_classifier",
          recommendedAction: "merge_fragments",
          paddleGroupId: "G005",
          sourceFragmentIds: ["B006", "D001"],
          targetFragmentId: "B006::paddle-recovery::G005",
          candidateIds: [15, 14],
        },
      ],
    });
    expect(
      buildGroupOnlyReviewPlan({
        candidates,
        candidateOrder: [15, 14],
        upstreamFragments,
      }).upstreamFragments,
    ).toEqual(upstreamFragments);
    expect(
      buildGroupOnlyReviewPlan({
        candidates,
        candidateOrder: [15, 14],
        upstreamFragments,
        spatialRelations,
      }).upstreamFragments,
    ).toEqual([
      {
        fragment: "B006::paddle-recovery::G005",
        status: "confirmed",
        candidateIds: [15, 14],
      },
    ]);
  });

  it("keeps the third-fragment veto for the actual 10.2 manga (5) singleton context", () => {
    const candidates = [
      ...mangaFiveSingletonCandidates(),
      {
        ...mangaFiveSingletonCandidates()[0],
        id: 11,
        x1: 930,
        y1: 640,
        x2: 980,
        y2: 840,
        reviewFragmentId: "B005",
        animeTextRegionId: "ATY503",
        animeTextRegionBbox: [925, 635, 985, 845],
      },
    ];

    expect(hasPotentialAnimeTextRelation(candidates)).toBe(false);
    expect(
      buildAnimeTextSpatialRelations(candidates)
        .distinctAnimeTextRegionBarriers,
    ).toBeUndefined();
  });

  it.each([
    [
      "a third Paddle group",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 13
            ? { ...candidate, paddleGroupId: "G005" }
            : candidate,
        ),
    ],
    [
      "a one-candidate Paddle component",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 14 || candidate.id === 15 || candidate.id === 13
            ? { ...candidate, paddleGroupId: "G002" }
            : candidate,
        ),
    ],
    [
      "missing Paddle sidecar size metadata",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 12
            ? { ...candidate, paddleGroupSize: undefined }
            : candidate,
        ),
    ],
    [
      "duplicate Paddle sidecar order metadata",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 14 ? { ...candidate, paddleOrder: 1 } : candidate,
        ),
    ],
    [
      "an impure child region",
      (candidates: Array<Record<string, unknown>>) => [
        ...candidates,
        {
          ...candidates[0],
          id: 99,
          reviewFragmentId: "B099",
          paddleGroupId: "G099",
        },
      ],
    ],
  ])("does not emit the internal split barrier for %s", (_label, mutate) => {
    const candidates = mutate(mangaElevenInternalPaddleCandidates());

    expect(
      buildAnimeTextSpatialRelations(candidates)
        .distinctAnimeTextRegionBarriers,
    ).toBeUndefined();
  });

  it("rejects a model merge across the qualified barrier and falls back to the two upstream fragments", async () => {
    const candidates = distinctBalloonCandidates();
    const spatialRelations = buildAnimeTextSpatialRelations(candidates);
    const plan = buildDistinctBarrierPlan(candidates, spatialRelations);
    const merged = JSON.stringify({
      labels: candidates.map(() => ({ group: 1, role: "body" })),
    });

    expect(() => parseGroupOnlyReviewResponse(merged, plan)).toThrow(
      "Distinct anime-text regions must remain in separate groups.",
    );

    const result = await reviewGroupOnlyCrop(
      {
        candidates,
        candidateOrder: candidates.map((candidate) => candidate.id),
        upstreamFragments: distinctUpstreamFragments(),
        spatialRelations,
      },
      { cropBbox: { x1: 80, y1: 220, x2: 440, y2: 720 } },
      async () => ({ outputText: merged, rawResponse: { merged: true } }),
    );

    expect(result).toMatchObject({
      status: "fallback",
      usedFallback: true,
      requestCount: 1,
      fallbackError: {
        code: "group-only-review-distinct-anime-text-region-merge",
      },
    });
    expect(result.groups.map((group) => group.candidateIds)).toEqual([
      [5, 4],
      [6, 7, 9, 8],
    ]);
  });

  it.each([
    [
      "a single-candidate fragment",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.filter((candidate) => candidate.id !== 4),
    ],
    [
      "a missing shared review context",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 6
            ? { ...candidate, reviewContextId: undefined }
            : candidate,
        ),
    ],
    [
      "different Paddle groups",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.reviewFragmentId === "B003"
            ? { ...candidate, paddleGroupId: "G003" }
            : candidate,
        ),
    ],
    [
      "a low detector score",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 6
            ? { ...candidate, animeTextRegionScore: 0.79 }
            : candidate,
        ),
    ],
    [
      "low candidate containment",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 7
            ? { ...candidate, animeTextContainment: 0.89 }
            : candidate,
        ),
    ],
    [
      "overlapping detector regions",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.reviewFragmentId === "B003"
            ? {
                ...candidate,
                animeTextRegionBbox: [280, 356.6, 420, 690.5],
              }
            : candidate,
        ),
    ],
    [
      "aligned vertical reading starts",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.reviewFragmentId === "B002"
            ? {
                ...candidate,
                y1: Number(candidate.y1) + 95,
                y2: Number(candidate.y2) + 95,
                animeTextRegionBbox: [316.6, 353.6, 405.3, 620.7],
              }
            : candidate,
        ),
    ],
    [
      "a sub-scale cross-axis gap",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.reviewFragmentId === "B002"
            ? {
                ...candidate,
                x1: Number(candidate.x1) - 25,
                x2: Number(candidate.x2) - 25,
                animeTextRegionBbox: [291.9, 258.6, 380.6, 525.7],
              }
            : candidate,
        ),
    ],
    [
      "deferred evidence",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.reviewFragmentId === "B003"
            ? { ...candidate, reviewStatus: "deferred" }
            : candidate,
        ),
    ],
    [
      "pre-existing ruby evidence",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 7 ? { ...candidate, reviewRole: "ruby" } : candidate,
        ),
    ],
    [
      "forbidden display-text evidence",
      (candidates: Array<Record<string, unknown>>) =>
        candidates.map((candidate) =>
          candidate.id === 7
            ? { ...candidate, reviewReasons: ["oversized_display_text"] }
            : candidate,
        ),
    ],
    [
      "an impure detector region",
      (candidates: Array<Record<string, unknown>>) => [
        ...candidates,
        {
          ...candidates[0],
          id: 20,
          reviewFragmentId: "B020",
          reviewContextId: undefined,
        },
      ],
    ],
    [
      "a third fragment in the same review context",
      (candidates: Array<Record<string, unknown>>) => [
        ...candidates,
        {
          ...candidates[0],
          id: 21,
          reviewFragmentId: "B021",
        },
      ],
    ],
  ])("does not emit the barrier for %s", (_label, mutate) => {
    const candidates = mutate(distinctBalloonCandidates());

    expect(
      buildAnimeTextSpatialRelations(candidates)
        .distinctAnimeTextRegionBarriers,
    ).toBeUndefined();
  });
});

function rolePolicyReviewCase(
  candidates: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const fragments = new Map<string, number[]>();
  for (const candidate of candidates) {
    const fragment = String(candidate.reviewFragmentId);
    const ids = fragments.get(fragment) ?? [];
    ids.push(Number(candidate.id));
    fragments.set(fragment, ids);
  }
  return {
    candidates,
    candidateOrder: candidates.map((candidate) => candidate.id),
    upstreamFragments: [...fragments].map(([fragment, candidateIds]) => ({
      fragment,
      status: fragment.startsWith("D") ? "deferred" : "confirmed",
      candidateIds,
    })),
    spatialRelations: {
      sharedAnimeTextRegions: [
        {
          kind: "shared_anime_text_region",
          strength: "auxiliary_review_hint",
          basis: "detector_plus_aligned_reading_start",
          recommendedAction: "merge_unless_visible_separator",
          regionId: "ATY777",
          candidateIds: candidates.map((candidate) => candidate.id),
          alignment: { writingMode: "vertical", startDeltaPx: 1 },
        },
      ],
    },
  };
}

function roleCandidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  reviewFragmentId: string,
): Record<string, unknown> {
  return {
    id,
    ocrText,
    x1,
    y1,
    x2,
    y2,
    reviewFragmentId,
    reviewStatus: reviewFragmentId.startsWith("D") ? "deferred" : "confirmed",
    reviewOrder: 1,
  };
}

function horizontalCandidate(
  id: number,
  fragment: string,
  status: "confirmed" | "deferred",
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Record<string, unknown> {
  return {
    id,
    x1,
    y1,
    x2,
    y2,
    reviewFragmentId: fragment,
    reviewStatus: status,
    reviewOrder: 1,
    animeTextContainment: 0.95,
    animeTextRegionId: "ATY900",
    animeTextRegionScore: 0.8,
    animeTextRegionBbox: [80, 80, 350, 180],
    animeTextEvidenceVersion: 1,
    animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
  };
}

function withoutAnimeTextEvidence(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...candidate };
  delete result.animeTextRegionId;
  delete result.animeTextRegionScore;
  delete result.animeTextContainment;
  delete result.animeTextRegionBbox;
  delete result.animeTextEvidenceVersion;
  delete result.animeTextModelRevision;
  return result;
}

function buildDistinctBarrierPlan(
  candidates: Array<Record<string, unknown>>,
  spatialRelations: Record<string, unknown>,
): Record<string, unknown> {
  return buildGroupOnlyReviewPlan({
    candidates,
    candidateOrder: candidates.map((candidate) => candidate.id),
    upstreamFragments: distinctUpstreamFragments(),
    spatialRelations,
  });
}

function mangaSevenReadingBandCandidates(): Array<Record<string, unknown>> {
  const rows = [
    [17, 964, 523, 1001, 666, 1, "ATY801", [890, 510, 1010, 700]],
    [16, 928, 523, 966, 692, 2, "ATY801", [890, 510, 1010, 700]],
    [15, 896, 523, 934, 690, 3, "ATY801", [890, 510, 1010, 700]],
    [23, 908, 707, 947, 824, 4, "ATY802", [830, 700, 960, 890]],
    [24, 877, 708, 912, 824, 5, "ATY802", [830, 700, 960, 890]],
    [22, 841, 707, 881, 876, 6, "ATY802", [830, 700, 960, 890]],
  ] as const;
  return rows.map(
    ([id, x1, y1, x2, y2, paddleOrder, regionId, regionBbox]) => ({
      id,
      x1,
      y1,
      x2,
      y2,
      ocrText: `candidate-${id}`,
      reviewFragmentId: "B006",
      reviewStatus: "confirmed",
      reviewReasons: [],
      reviewOrder: paddleOrder,
      paddleGroupId: "G005",
      paddleOrder,
      paddleGroupSize: 6,
      animeTextRegionId: regionId,
      animeTextRegionScore: 0.92,
      animeTextContainment: 0.96,
      animeTextRegionBbox: regionBbox,
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    }),
  );
}
