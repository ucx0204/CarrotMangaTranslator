import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;
type ReviewPlan = JsonRecord & { candidates: JsonRecord[] };
type ReviewProjection = JsonRecord & {
  groups: Array<{
    candidateIds: number[];
    bodyCandidateIds: number[];
    rubyCandidateIds: number[];
    jp: string;
  }>;
};

const {
  applyReviewedGroupsToHints,
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  parseGroupOnlyReviewResponse,
  reviewGroupOnlyCrop,
} = require("../src/main/runtime/semantic-ocr/group-only-review.cjs") as {
  applyReviewedGroupsToHints: (
    hints: JsonRecord[],
    results: ReviewProjection[],
  ) => {
    hints: JsonRecord[];
    reviewedGroupCount: number;
  };
  buildGroupOnlyReviewFallback: (plan: ReviewPlan) => ReviewProjection;
  buildGroupOnlyReviewPlan: (
    reviewCase: JsonRecord,
    region?: JsonRecord,
  ) => ReviewPlan;
  parseGroupOnlyReviewResponse: (
    rawText: string,
    plan: ReviewPlan,
  ) => ReviewProjection;
  reviewGroupOnlyCrop: (
    reviewCase: JsonRecord,
    region: JsonRecord,
    request: () => Promise<string>,
  ) => Promise<ReviewProjection & { status: string; usedFallback: boolean }>;
};

describe("group-only strong-lineage stabilization", () => {
  it("weakly reunites the observed vertical composition and removes its ruby from JP", () => {
    const candidates = [
      candidate(13, "ぜんりょうしゅさま", 891, 171, 911, 300, 1, "B003"),
      candidate(12, "『前領主様が", 860, 146, 895, 329, 2, "B003"),
      candidate(3, "りょうしゅだいこう", 845, 93, 864, 223, 3, "B001"),
      candidate(2, "領主代行として", 813, 92, 849, 314, 4, "B001"),
      candidate(4, "ぜんけん", 798, 94, 818, 162, 5, "B001"),
      {
        ...candidate(14, "元", 800, 192, 814, 215, 6, "D001"),
        score: 0.5734,
        reviewStatus: "deferred",
        reviewContextId: undefined,
        reviewReasons: ["small_low_confidence_text"],
      },
      candidate(1, "全権を得て』", 764, 92, 803, 272, 7, "B001"),
    ];
    const plan = buildPlan(candidates, [
      { fragment: "B003", status: "confirmed", ids: [13, 12] },
      { fragment: "B001", status: "confirmed", ids: [3, 2, 4, 1] },
      { fragment: "D001", status: "deferred", ids: [14] },
    ]);
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 3, role: "body" },
          { group: 3, role: "body" },
          { group: 1, role: "body" },
          { group: 1, role: "body" },
          { group: 1, role: "body" },
          { group: 2, role: "body" },
          { group: 1, role: "body" },
        ],
      }),
      plan,
    );
    const expected = expect.objectContaining({
      bodyCandidateIds: [12, 2, 1],
      rubyCandidateIds: [13, 3, 4, 14],
      jp: "『前領主様が領主代行として全権を得て』",
    });

    expect(projected.groups).toEqual([expected]);
    expect(buildGroupOnlyReviewFallback(plan).groups).toEqual([expected]);
  });

  it("keeps a legitimate split when shared lineage lacks reading-axis overlap", () => {
    const candidates = [
      candidate(1, "第一段", 100, 100, 140, 250, 1, "B001"),
      candidate(2, "第二段", 135, 280, 175, 430, 2, "B002"),
    ];
    const plan = buildPlan(candidates, confirmedFragments(candidates));
    const projected = parseGroupOnlyReviewResponse(
      '{"labels":[{"group":1,"role":"body"},{"group":2,"role":"body"}]}',
      plan,
    );

    expect(projected.groups.map((group) => group.candidateIds)).toEqual([
      [1],
      [2],
    ]);
  });

  it("recognizes one-character ruby only with a unique aligned same-lineage Han host", () => {
    const candidates = [
      candidate(1, "漢", 100, 100, 140, 220, 1, "B001"),
      candidate(2, "か", 140, 110, 155, 160, 2, "B002"),
    ];
    const projected = parseAllBody(candidates);

    expect(projected.groups).toEqual([
      expect.objectContaining({
        bodyCandidateIds: [1],
        rubyCandidateIds: [2],
        jp: "漢",
      }),
    ]);
  });

  it("replays the page-10 complete deferred Paddle ruby run without duplicating its reading", () => {
    const candidates = [
      deferredCandidate(
        34,
        "じ",
        796,
        977,
        812,
        992,
        "D003",
        ["dense_page_single_glyph"],
        3,
        5,
      ),
      deferredCandidate(
        33,
        "う",
        783,
        977,
        798,
        992,
        "D004",
        ["dense_page_single_glyph"],
        2,
        5,
      ),
      deferredCandidate(
        32,
        "お",
        772,
        977,
        788,
        991,
        "D005",
        ["dense_page_single_glyph"],
        1,
        5,
      ),
      deferredCandidate(
        35,
        "アレクシス王女侍女",
        648,
        985,
        875,
        1020,
        "D006",
        ["ordinary_axis_candidate"],
        4,
        5,
      ),
      deferredCandidate(
        36,
        "ヘレナ",
        704,
        1019,
        815,
        1062,
        "D006",
        ["ordinary_axis_candidate"],
        5,
        5,
      ),
    ];
    const plan = buildPlan(candidates, deferredFragments(candidates));
    const rawLabels = [1, 2, 3, 4, 4].map((group) => ({
      group,
      role: "body",
    }));
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({ labels: rawLabels }),
      plan,
    );
    const expected = expect.objectContaining({
      bodyCandidateIds: [35, 36],
      rubyCandidateIds: expect.arrayContaining([32, 33, 34]),
      jp: "アレクシス王女侍女ヘレナ",
    });

    expect(projected.groups).toHaveLength(1);
    expect(projected.groups[0]).toEqual(expected);
    expect(projected.groups[0].candidateIds.sort((a, b) => a - b)).toEqual([
      32, 33, 34, 35, 36,
    ]);
    expect(buildGroupOnlyReviewFallback(plan).groups).toEqual([expected]);
  });

  it("merges the page-10 ruby run after production review regions are projected separately", () => {
    const candidates = [
      deferredCandidate(
        34,
        "じ",
        796,
        977,
        812,
        992,
        "D003",
        ["dense_page_single_glyph"],
        3,
        5,
      ),
      deferredCandidate(
        33,
        "う",
        783,
        977,
        798,
        992,
        "D004",
        ["dense_page_single_glyph"],
        2,
        5,
      ),
      deferredCandidate(
        32,
        "お",
        772,
        977,
        788,
        991,
        "D005",
        ["dense_page_single_glyph"],
        1,
        5,
      ),
      deferredCandidate(
        35,
        "アレクシス王女侍女",
        648,
        985,
        875,
        1020,
        "D006",
        ["ordinary_axis_candidate"],
        4,
        5,
      ),
      deferredCandidate(
        36,
        "ヘレナ",
        704,
        1019,
        815,
        1062,
        "D006",
        ["ordinary_axis_candidate"],
        5,
        5,
      ),
    ];
    const rubyRegion = projectCrop(candidates.slice(0, 3), [1, 2, 3]);
    const hostRegion = projectCrop(candidates.slice(3), [1, 1]);

    const applied = applyReviewedGroupsToHints(candidates, [
      rubyRegion,
      hostRegion,
    ]);
    const byId = new Map(applied.hints.map((hint) => [hint.id, hint]));

    expect(applied.reviewedGroupCount).toBe(1);
    expect(applied.hints.map((hint) => hint.groupId)).toEqual(
      Array.from({ length: 5 }, () => "G001"),
    );
    expect(
      [35, 36, 34, 33, 32].map((id) => byId.get(id)?.orderInGroup),
    ).toEqual([1, 2, 3, 4, 5]);
    expect([35, 36].map((id) => byId.get(id)?.reviewRole)).toEqual([
      "body",
      "body",
    ]);
    expect([32, 33, 34].map((id) => byId.get(id)?.reviewRole)).toEqual([
      "ruby",
      "ruby",
      "ruby",
    ]);
  });

  it("does not treat a complete deferred kana run over the non-Han name span as ruby", () => {
    const candidates = [
      deferredCandidate(
        1,
        "お",
        772,
        977,
        788,
        991,
        "D001",
        ["dense_page_single_glyph"],
        1,
        4,
      ),
      deferredCandidate(
        2,
        "う",
        783,
        977,
        798,
        992,
        "D002",
        ["dense_page_single_glyph"],
        2,
        4,
      ),
      deferredCandidate(
        3,
        "王女アレクシス",
        648,
        985,
        875,
        1020,
        "D003",
        ["ordinary_axis_candidate"],
        3,
        4,
      ),
      deferredCandidate(
        4,
        "ヘレナ",
        704,
        1019,
        815,
        1062,
        "D003",
        ["ordinary_axis_candidate"],
        4,
        4,
      ),
    ];

    expect(
      parseAllBodyWithFragments(
        candidates,
        deferredFragments(candidates),
      ).groups.flatMap((group) => group.rubyCandidateIds),
    ).toEqual([]);
  });

  it("replays page 7 by absorbing the unique ruby above 聞 but preserving the large kana below", () => {
    const candidates = [
      deferredCandidate(2, "き", 449, 423, 474, 452, "D002", [
        "dense_page_single_glyph",
      ]),
      deferredCandidate(3, "聞こえてますか!?", 429, 436, 806, 508, "D003", [
        "ordinary_axis_candidate",
      ]),
      deferredCandidate(5, "か", 431, 522, 495, 589, "D004", [
        "dense_page_single_glyph",
      ]),
    ];
    const plan = buildPlan(candidates, deferredFragments(candidates));
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: candidates.map((_, index) => ({
          group: index + 1,
          role: "body",
        })),
      }),
      plan,
    );

    expect(projected.groups).toEqual([
      expect.objectContaining({
        candidateIds: [3, 2],
        bodyCandidateIds: [3],
        rubyCandidateIds: [2],
        jp: "聞こえてますか!?",
      }),
      expect.objectContaining({
        candidateIds: [5],
        bodyCandidateIds: [5],
        rubyCandidateIds: [],
        jp: "か",
      }),
    ]);
  });

  it("merges only page-7 き after three production review regions are projected", () => {
    const candidates = [
      deferredCandidate(2, "き", 449, 423, 474, 452, "D002", [
        "dense_page_single_glyph",
      ]),
      deferredCandidate(3, "聞こえてますか!?", 429, 436, 806, 508, "D003", [
        "ordinary_axis_candidate",
      ]),
      deferredCandidate(5, "か", 431, 522, 495, 589, "D004", [
        "dense_page_single_glyph",
      ]),
    ];
    const cropResults = candidates.map((candidate) =>
      projectCrop([candidate], [1]),
    );

    const applied = applyReviewedGroupsToHints(candidates, cropResults);
    const byId = new Map(applied.hints.map((hint) => [hint.id, hint]));

    expect(applied.reviewedGroupCount).toBe(2);
    expect(byId.get(3)).toMatchObject({
      groupId: "G001",
      orderInGroup: 1,
      groupSize: 2,
      reviewRole: "body",
    });
    expect(byId.get(2)).toMatchObject({
      groupId: "G001",
      orderInGroup: 2,
      groupSize: 2,
      reviewRole: "ruby",
    });
    expect(byId.get(5)).toMatchObject({ reviewRole: "body" });
    expect(byId.get(5)).not.toHaveProperty("groupId");
  });

  it("replays the actual page-7 C002 ruby-only failure through fallback and global application", async () => {
    const candidates = [
      deferredCandidate(2, "き", 449, 423, 474, 452, "D002", [
        "dense_page_single_glyph",
      ]),
      deferredCandidate(3, "聞こえてますか!?", 429, 436, 806, 508, "D003", [
        "ordinary_axis_candidate",
      ]),
      deferredCandidate(5, "か", 431, 522, 495, 589, "D004", [
        "dense_page_single_glyph",
      ]),
    ];
    const result = await reviewGroupOnlyCrop(
      {
        candidates,
        upstreamFragments: deferredFragments(candidates),
      },
      { cropId: "C002", cropBbox: { x1: 380, y1: 400, x2: 820, y2: 600 } },
      async () =>
        JSON.stringify({
          labels: [
            { group: 1, role: "ruby" },
            { group: 2, role: "body" },
            { group: 3, role: "body" },
          ],
        }),
    );

    expect(result).toMatchObject({
      status: "fallback",
      source: "upstream-fallback",
      usedFallback: true,
    });
    expect(result.groups).toEqual([
      expect.objectContaining({
        candidateIds: [3, 2],
        bodyCandidateIds: [3],
        rubyCandidateIds: [2],
        jp: "聞こえてますか!?",
      }),
      expect.objectContaining({
        candidateIds: [5],
        bodyCandidateIds: [5],
        rubyCandidateIds: [],
        jp: "か",
      }),
    ]);

    const applied = applyReviewedGroupsToHints(candidates, [result]);
    const byId = new Map(applied.hints.map((hint) => [hint.id, hint]));
    expect(byId.get(2)).toMatchObject({
      groupId: "G001",
      orderInGroup: 2,
      reviewRole: "ruby",
    });
    expect(byId.get(3)).toMatchObject({
      groupId: "G001",
      orderInGroup: 1,
      reviewRole: "body",
    });
    expect(byId.get(5)).not.toHaveProperty("groupId");
  });

  it("replays holdout page 11 by removing the confirmed ruby run and its deferred orphan from JP", async () => {
    const candidates = holdoutPage11RubyCandidates();
    const upstreamFragments = [
      { fragment: "B001", status: "confirmed", ids: [3, 4, 1] },
      { fragment: "D001", status: "deferred", ids: [2] },
    ];
    const plan = buildGroupOnlyReviewPlan(
      { candidates, upstreamFragments },
      { cropBbox: { x1: 0, y1: 0, x2: 1115, y2: 1600 } },
    );
    const expected = expect.objectContaining({
      candidateIds: [1, 3, 4, 2],
      bodyCandidateIds: [1],
      rubyCandidateIds: [3, 4, 2],
      jp: "世界の危機！",
    });

    const fallback = buildGroupOnlyReviewFallback(plan);
    expect(fallback.groups).toEqual([expected]);

    const reviewed = await reviewGroupOnlyCrop(
      { candidates, upstreamFragments },
      { cropId: "C001", cropBbox: { x1: 830, y1: 150, x2: 980, y2: 620 } },
      async () =>
        JSON.stringify({
          labels: [
            { group: 1, role: "ruby" },
            { group: 2, role: "ruby" },
            { group: 3, role: "body" },
            { group: 3, role: "ruby" },
          ],
        }),
    );
    expect(reviewed).toMatchObject({
      status: "fallback",
      source: "upstream-fallback",
      usedFallback: true,
    });
    expect(reviewed.groups).toEqual([expected]);

    const applied = applyReviewedGroupsToHints(candidates, [reviewed]);
    const byId = new Map(applied.hints.map((hint) => [hint.id, hint]));
    expect(applied.reviewedGroupCount).toBe(1);
    expect(byId.get(1)).toMatchObject({
      groupId: "G001",
      orderInGroup: 1,
      groupSize: 4,
      reviewRole: "body",
    });
    for (const id of [3, 4, 2]) {
      expect(byId.get(id)).toMatchObject({
        groupId: "G001",
        groupSize: 4,
        reviewRole: "ruby",
      });
    }
  });

  it("keeps p13-like left and lower standalone kana outside a confirmed ruby cluster", () => {
    const candidates = [
      clusterCandidate(1, "世界危機", 100, 100, 140, 400, "B001"),
      clusterCandidate(2, "せ", 138, 110, 146, 125, "B001"),
      clusterCandidate(3, "き", 138, 260, 146, 275, "B001"),
      deferredClusterCandidate(4, "あ", 60, 330, 75, 345, "D001"),
      deferredClusterCandidate(5, "あ", 140, 420, 150, 435, "D002"),
    ];
    const projected = buildGroupOnlyReviewFallback(
      buildPlan(candidates, [
        { fragment: "B001", status: "confirmed", ids: [1, 2, 3] },
        { fragment: "D001", status: "deferred", ids: [4] },
        { fragment: "D002", status: "deferred", ids: [5] },
      ]),
    );

    expect(projected.groups).toEqual([
      expect.objectContaining({
        bodyCandidateIds: [1],
        rubyCandidateIds: [2, 3],
        jp: "世界危機",
      }),
      expect.objectContaining({
        bodyCandidateIds: [4],
        rubyCandidateIds: [],
        jp: "あ",
      }),
      expect.objectContaining({
        bodyCandidateIds: [5],
        rubyCandidateIds: [],
        jp: "あ",
      }),
    ]);
  });

  it("does not establish a ruby cluster from ordinary multi-kana text", () => {
    const candidates = [
      clusterCandidate(1, "世界危機", 100, 100, 140, 400, "B001"),
      clusterCandidate(2, "かな", 138, 110, 146, 125, "B001"),
      clusterCandidate(3, "き", 138, 260, 146, 275, "B001"),
      deferredClusterCandidate(4, "せ", 138, 185, 146, 200, "D001"),
    ];
    const projected = buildGroupOnlyReviewFallback(
      buildPlan(candidates, [
        { fragment: "B001", status: "confirmed", ids: [1, 2, 3] },
        { fragment: "D001", status: "deferred", ids: [4] },
      ]),
    );

    expect(projected.groups.flatMap((group) => group.rubyCandidateIds)).toEqual(
      [],
    );
    expect(projected.groups.map((group) => group.candidateIds)).toEqual([
      [1, 2, 3],
      [4],
    ]);
  });

  it("leaves a deferred kana separate when two confirmed vertical hosts are plausible", () => {
    const candidates = [
      clusterCandidate(1, "世界", 100, 100, 140, 400, "B001"),
      clusterCandidate(2, "せ", 138, 110, 146, 125, "B001"),
      clusterCandidate(3, "か", 138, 260, 146, 275, "B001"),
      clusterCandidate(4, "危機", 110, 100, 150, 400, "B002"),
      clusterCandidate(5, "き", 148, 110, 156, 125, "B002"),
      clusterCandidate(6, "き", 148, 260, 156, 275, "B002"),
      deferredClusterCandidate(7, "せ", 139, 110, 149, 125, "D001"),
    ];
    const projected = buildGroupOnlyReviewFallback(
      buildPlan(candidates, [
        { fragment: "B001", status: "confirmed", ids: [1, 2, 3] },
        { fragment: "B002", status: "confirmed", ids: [4, 5, 6] },
        { fragment: "D001", status: "deferred", ids: [7] },
      ]),
    );

    expect(projected.groups).toEqual([
      expect.objectContaining({
        bodyCandidateIds: [1],
        rubyCandidateIds: [2, 3],
      }),
      expect.objectContaining({
        bodyCandidateIds: [4],
        rubyCandidateIds: [5, 6],
      }),
      expect.objectContaining({
        bodyCandidateIds: [7],
        rubyCandidateIds: [],
      }),
    ]);
  });

  it.each([
    [
      "same-size ordinary kana",
      [
        candidate(1, "漢", 100, 100, 140, 220, 1, "B001"),
        candidate(2, "かな", 140, 110, 180, 210, 2, "B002"),
      ],
    ],
    [
      "kana on the non-ruby side",
      [
        candidate(1, "漢", 100, 100, 140, 220, 1, "B001"),
        candidate(2, "か", 80, 110, 95, 160, 2, "B002"),
      ],
    ],
    [
      "small sound effect from another review context",
      [
        candidate(1, "漢", 100, 100, 140, 220, 1, "B001"),
        {
          ...candidate(2, "ド", 140, 110, 155, 160, 2, "B002"),
          reviewContextId: "RC002",
        },
      ],
    ],
    [
      "kana with two plausible Han hosts",
      [
        candidate(1, "漢", 100, 100, 140, 220, 1, "B001"),
        candidate(2, "字", 80, 100, 120, 220, 2, "B001"),
        candidate(3, "か", 130, 110, 145, 160, 3, "B002"),
      ],
    ],
  ])("does not swallow %s as ruby", (_label, candidates) => {
    expect(parseAllBody(candidates).groups[0].rubyCandidateIds).toEqual([]);
  });
});

function parseAllBody(candidates: JsonRecord[]): ReviewProjection {
  return parseAllBodyWithFragments(candidates, confirmedFragments(candidates));
}

function parseAllBodyWithFragments(
  candidates: JsonRecord[],
  fragments: JsonRecord[],
): ReviewProjection {
  const plan = buildPlan(candidates, fragments);
  return parseGroupOnlyReviewResponse(
    JSON.stringify({
      labels: candidates.map(() => ({ group: 1, role: "body" })),
    }),
    plan,
  );
}

function projectCrop(
  candidates: JsonRecord[],
  groups: number[],
): ReviewProjection {
  const plan = buildPlan(candidates, deferredFragments(candidates));
  return parseGroupOnlyReviewResponse(
    JSON.stringify({
      labels: groups.map((group) => ({ group, role: "body" })),
    }),
    plan,
  );
}

function deferredFragments(candidates: JsonRecord[]): JsonRecord[] {
  const idsByFragment = new Map<string, number[]>();
  for (const item of candidates) {
    const fragment = String(item.reviewFragmentId);
    const ids = idsByFragment.get(fragment) ?? [];
    ids.push(Number(item.id));
    idsByFragment.set(fragment, ids);
  }
  return [...idsByFragment].map(([fragment, ids]) => ({
    fragment,
    status: "deferred",
    ids,
  }));
}

function buildPlan(
  candidates: JsonRecord[],
  upstreamFragments: JsonRecord[],
): ReviewPlan {
  return buildGroupOnlyReviewPlan(
    { candidates, upstreamFragments },
    { cropBbox: { x1: 0, y1: 0, x2: 1000, y2: 500 } },
  );
}

function confirmedFragments(candidates: JsonRecord[]): JsonRecord[] {
  const idsByFragment = new Map<string, number[]>();
  for (const item of candidates) {
    const fragment = String(item.reviewFragmentId);
    const ids = idsByFragment.get(fragment) ?? [];
    ids.push(Number(item.id));
    idsByFragment.set(fragment, ids);
  }
  return [...idsByFragment].map(([fragment, ids]) => ({
    fragment,
    status: "confirmed",
    ids,
  }));
}

function candidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  paddleOrder: number,
  reviewFragmentId: string,
): JsonRecord {
  return {
    id,
    ocrText,
    x1,
    y1,
    x2,
    y2,
    score: 0.95,
    paddleGroupId: "G001",
    paddleOrder,
    paddleGroupSize: 7,
    reviewFragmentId,
    reviewStatus: "confirmed",
    reviewReasons: [],
    reviewContextId: "RC001",
  };
}

function deferredCandidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  reviewFragmentId: string,
  reviewReasons: string[],
  paddleOrder?: number,
  paddleGroupSize?: number,
): JsonRecord {
  return {
    id,
    ocrText,
    x1,
    y1,
    x2,
    y2,
    score: 0.99,
    paddleGroupId: paddleOrder === undefined ? undefined : "G005",
    paddleOrder,
    paddleGroupSize,
    reviewFragmentId,
    reviewStatus: "deferred",
    reviewReasons,
  };
}

function holdoutPage11RubyCandidates(): JsonRecord[] {
  return [
    {
      ...clusterCandidate(3, "き", 936, 414, 950, 432, "B001"),
      score: 0.9708,
      groupId: "G001",
      orderInGroup: 1,
      groupSize: 3,
      semanticGroup: true,
    },
    {
      ...clusterCandidate(4, "き", 937, 479, 950, 496, "B001"),
      score: 0.9974,
      groupId: "G001",
      orderInGroup: 2,
      groupSize: 3,
      semanticGroup: true,
    },
    {
      ...clusterCandidate(1, "世界の危機！", 861, 187, 944, 587, "B001"),
      score: 0.9992,
      groupId: "G001",
      orderInGroup: 3,
      groupSize: 3,
      semanticGroup: true,
    },
    {
      ...deferredClusterCandidate(2, "せ", 934, 219, 953, 241, "D001"),
      score: 0.5862,
    },
  ];
}

function clusterCandidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  reviewFragmentId: string,
): JsonRecord {
  return {
    id,
    label: "ocr_textline",
    ocrText,
    x1,
    y1,
    x2,
    y2,
    score: 0.99,
    reviewFragmentId,
    reviewStatus: "confirmed",
    reviewReasons: [],
  };
}

function deferredClusterCandidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  reviewFragmentId: string,
): JsonRecord {
  return {
    ...clusterCandidate(id, ocrText, x1, y1, x2, y2, reviewFragmentId),
    reviewStatus: "deferred",
    reviewReasons: ["dense_page_single_glyph"],
  };
}
