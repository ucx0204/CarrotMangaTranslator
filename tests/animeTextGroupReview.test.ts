import { describe, expect, it } from "vitest";

const { buildAnimeTextSpatialRelations, qualifyAnimeTextRelationRegionIds } =
  require("../src/main/runtime/semantic-ocr/anime-text-review-relations.cjs") as {
    buildAnimeTextSpatialRelations: (
      candidates: Array<Record<string, unknown>>,
    ) => {
      sharedAnimeTextRegions: Array<Record<string, unknown>>;
    };
    qualifyAnimeTextRelationRegionIds: (
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
