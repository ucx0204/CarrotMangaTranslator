import { describe, expect, it, vi } from "vitest";

type JsonRecord = Record<string, unknown>;
type ReviewPlan = JsonRecord & {
  candidateOrder: number[];
  candidates: JsonRecord[];
  upstreamFragments: JsonRecord[];
};
type ReviewProjection = JsonRecord & {
  status?: string;
  source: string;
  labels: Array<{ group: number; role: "body" | "ruby" }>;
  groups: Array<{
    localGroupIndex: number;
    modelGroup: number | null;
    candidateIds: number[];
    bodyCandidateIds: number[];
    rubyCandidateIds: number[];
    jp: string;
    bbox: { x1: number; y1: number; x2: number; y2: number };
  }>;
};

const {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  applyReviewedGroupsToHints,
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  buildGroupOnlyReviewPrompt,
  buildGroupOnlyReviewResponseFormat,
  buildGroupOnlyReviewSystemPrompt,
  parseGroupOnlyReviewResponse,
  reviewGroupOnlyCrop,
} = require("../src/main/runtime/semantic-ocr/group-only-review.cjs") as {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION: number;
  applyReviewedGroupsToHints: (
    hints: JsonRecord[],
    results: ReviewProjection[],
    options?: { validatedGroupOnlyReview?: boolean },
  ) => {
    hints: JsonRecord[];
    validatedGroupOnlyReview: boolean;
    reviewedGroupCount: number;
  };
  buildGroupOnlyReviewFallback: (plan: ReviewPlan) => ReviewProjection;
  buildGroupOnlyReviewPlan: (
    reviewCase: JsonRecord,
    region?: JsonRecord,
  ) => ReviewPlan;
  buildGroupOnlyReviewPrompt: (plan: ReviewPlan) => string;
  buildGroupOnlyReviewResponseFormat: (count: number) => JsonRecord;
  buildGroupOnlyReviewSystemPrompt: () => string;
  parseGroupOnlyReviewResponse: (
    rawText: string,
    plan: ReviewPlan,
  ) => ReviewProjection;
  reviewGroupOnlyCrop: (
    reviewCase: JsonRecord,
    region: JsonRecord,
    request: (request: JsonRecord) => Promise<unknown>,
  ) => Promise<ReviewProjection>;
};

describe("group-only crop review contract", () => {
  it("builds the exact positional labels-only schema and grouping-only prompt", () => {
    const plan = buildGroupOnlyReviewPlan(makeCase(), makeRegion());
    const prompt = buildGroupOnlyReviewPrompt(plan);
    const system = buildGroupOnlyReviewSystemPrompt();
    const responseFormat = buildGroupOnlyReviewResponseFormat(4) as {
      schema: {
        required: string[];
        properties: {
          labels: {
            minItems: number;
            maxItems: number;
            items: {
              required: string[];
              additionalProperties: boolean;
              properties: JsonRecord;
            };
          };
        };
      };
    };

    expect(plan.candidateOrder).toEqual([10, 11, 20, 21]);
    expect(GROUP_ONLY_PROMPT_CONTRACT_VERSION).toBe(11);
    expect(prompt).toContain("candidateOrder=[10,11,20,21]");
    expect(prompt).toContain("Return exactly 4 labels");
    expect(prompt).toContain("Never split a supplied upstream fragment");
    expect(prompt).toContain(
      "Do not output text. Do not correct OCR text. Do not output or propose coordinates.",
    );
    expect(prompt).toContain('"paddleGroup":"PADDLE-A"');
    expect(prompt).not.toContain("STALE-A");
    expect(system).toContain("grouping only");
    expect(system).toContain("never transcribe, correct");
    expect(system).toContain(
      "This pass may merge upstream fragments but must never split one.",
    );
    expect(responseFormat.schema.required).toEqual(["labels"]);
    expect(Object.keys(responseFormat.schema.properties)).toEqual(["labels"]);
    expect(responseFormat.schema.properties.labels).toMatchObject({
      minItems: 4,
      maxItems: 4,
    });
    const labelSchema = responseFormat.schema.properties.labels.items;
    expect(labelSchema.required).toEqual(["group", "role"]);
    expect(labelSchema.additionalProperties).toBe(false);
    expect(Object.keys(labelSchema.properties)).toEqual(["group", "role"]);
    expect(JSON.stringify(responseFormat)).not.toMatch(
      /discard|text|coord|bbox|candidateId/i,
    );
  });

  it("projects raw hints without rewriting text or boxes and excludes ruby from JP", () => {
    const reviewCase = makeCase();
    const plan = buildGroupOnlyReviewPlan(reviewCase, makeRegion());
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 2, role: "body" },
          { group: 2, role: "ruby" },
          { group: 2, role: "body" },
          { group: 2, role: "body" },
        ],
      }),
      plan,
    );

    expect(projected.source).toBe("model");
    expect(projected.groups).toEqual([
      {
        localGroupIndex: 1,
        modelGroup: 2,
        candidateIds: [10, 20, 21, 11],
        bodyCandidateIds: [10, 20, 21],
        rubyCandidateIds: [11],
        jp: "本文末",
        bbox: { x1: 80, y1: 80, x2: 280, y2: 220 },
      },
    ]);
    const applied = applyReviewedGroupsToHints(
      reviewCase.candidates as JsonRecord[],
      [projected],
    );
    expect(applied.hints).toHaveLength(4);
    expect(applied.hints[0]).toMatchObject({
      id: 10,
      ocrText: "本",
      x1: 100,
      y1: 100,
      x2: 150,
      y2: 220,
      untouched: "candidate-10",
      groupId: "G001",
      orderInGroup: 1,
      groupSize: 4,
      semanticGroup: true,
      rolePrior: "ordinary_mergeable",
      containerType: "same_text_container",
      reviewRole: "body",
    });
    expect(applied.hints[1]).toMatchObject({
      id: 11,
      ocrText: "ほん",
      x1: 80,
      y1: 80,
      x2: 105,
      y2: 135,
      groupId: "G001",
      orderInGroup: 4,
      reviewRole: "ruby",
    });
    expect(applied.validatedGroupOnlyReview).toBe(true);
    expect(reviewCase.candidates).toEqual(makeCase().candidates);
  });

  it("separates weak diagonal merges across different Paddle lineages and keeps each ruby host", () => {
    const plan = buildGroupOnlyReviewPlan(
      {
        candidates: [
          reviewCandidate(1, "右", 186, 521, 310, 686, "PADDLE-A"),
          reviewCandidate(2, "みぎ", 290, 530, 305, 560, "PADDLE-A"),
          reviewCandidate(3, "左", 129, 634, 193, 778, "PADDLE-B"),
          reviewCandidate(4, "ひだり", 130, 640, 145, 670, "PADDLE-B"),
        ],
        upstreamFragments: [
          { fragment: "B001", status: "confirmed", ids: [1] },
          { fragment: "D001", status: "deferred", ids: [2] },
          { fragment: "B002", status: "confirmed", ids: [3] },
          { fragment: "D002", status: "deferred", ids: [4] },
        ],
      },
      makeRegion(),
    );
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 1, role: "ruby" },
          { group: 1, role: "ruby" },
          { group: 1, role: "ruby" },
        ],
      }),
      plan,
    );

    expect(projected.groups.map((group) => group.candidateIds)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(projected.groups.map((group) => group.rubyCandidateIds)).toEqual([
      [2],
      [4],
    ]);
    expect(projected.groups.map((group) => group.bodyCandidateIds)).toEqual([
      [1],
      [3],
    ]);
  });

  it("preserves same-Paddle, strongly aligned, and disjoint cross-fragment merges", () => {
    const cases = [
      [
        reviewCandidate(1, "右", 186, 521, 310, 686, "SHARED"),
        reviewCandidate(2, "左", 129, 634, 193, 778, "SHARED"),
      ],
      [
        reviewCandidate(1, "上", 100, 100, 140, 300, "PADDLE-A"),
        reviewCandidate(2, "下", 130, 100, 170, 300, "PADDLE-B"),
      ],
      [
        reviewCandidate(1, "斜", 100, 100, 150, 200, "PADDLE-A"),
        reviewCandidate(2, "音", 300, 300, 350, 400, "PADDLE-B"),
      ],
    ];
    for (const candidates of cases) {
      const plan = buildGroupOnlyReviewPlan(
        {
          candidates,
          upstreamFragments: [
            { fragment: "B001", status: "confirmed", ids: [1] },
            { fragment: "B002", status: "confirmed", ids: [2] },
          ],
        },
        makeRegion(),
      );
      const projected = parseGroupOnlyReviewResponse(
        JSON.stringify({
          labels: [
            { group: 1, role: "body" },
            { group: 1, role: "body" },
          ],
        }),
        plan,
      );
      expect(projected.groups.map((group) => group.candidateIds)).toEqual([
        [1, 2],
      ]);
    }
  });

  it("does not promote confirmed ruby when a deferred body already owns the separated component", () => {
    const plan = buildGroupOnlyReviewPlan(
      {
        candidates: [
          reviewCandidate(1, "右", 186, 521, 310, 686, "PADDLE-A"),
          reviewCandidate(2, "ひだり", 129, 634, 193, 778, "PADDLE-B"),
          {
            ...reviewCandidate(3, "左", 130, 640, 170, 750, "PADDLE-B"),
            reviewStatus: "deferred",
          },
        ],
        upstreamFragments: [
          { fragment: "B001", status: "confirmed", ids: [1] },
          { fragment: "B002", status: "confirmed", ids: [2] },
          { fragment: "D001", status: "deferred", ids: [3] },
        ],
      },
      makeRegion(),
    );
    const projected = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 1, role: "ruby" },
          { group: 1, role: "body" },
        ],
      }),
      plan,
    );

    expect(projected.groups.map((group) => group.bodyCandidateIds)).toEqual([
      [1],
      [3],
    ]);
    expect(projected.groups.map((group) => group.rubyCandidateIds)).toEqual([
      [],
      [2],
    ]);
  });

  it("reattaches one contained low-confidence fallback satellite as ruby", () => {
    const plan = buildGroupOnlyReviewPlan(
      {
        candidates: [
          reviewCandidate(1, "本", 100, 100, 140, 300, "PADDLE-A"),
          reviewCandidate(2, "文", 140, 100, 180, 300, "PADDLE-A"),
          {
            ...reviewCandidate(3, "ほん", 145, 120, 158, 160, "PADDLE-A"),
            score: 0.4,
            reviewStatus: "deferred",
            reviewReasons: ["small_low_confidence_text"],
          },
        ],
        upstreamFragments: [
          { fragment: "B001", status: "confirmed", ids: [1, 2] },
          { fragment: "D001", status: "deferred", ids: [3] },
        ],
      },
      makeRegion(),
    );
    const fallback = buildGroupOnlyReviewFallback(plan);

    expect(fallback.groups).toEqual([
      expect.objectContaining({
        candidateIds: [1, 2, 3],
        bodyCandidateIds: [1, 2],
        rubyCandidateIds: [3],
        jp: "本文",
      }),
    ]);
  });

  it.each([
    ["90% covered", 181, true],
    ["less than 90% covered", 182, false],
  ])(
    "treats a slightly protruding fallback satellite as ruby only when it is %s",
    (_label, satelliteX2, shouldAttach) => {
      const plan = buildGroupOnlyReviewPlan(
        {
          candidates: [
            reviewCandidate(1, "本文", 100, 100, 180, 300, "PADDLE-A"),
            {
              ...reviewCandidate(
                2,
                "ほん",
                171,
                120,
                satelliteX2,
                160,
                "PADDLE-A",
              ),
              score: 0.4,
              reviewStatus: "deferred",
              reviewReasons: ["small_low_confidence_text"],
            },
          ],
          upstreamFragments: [
            { fragment: "B001", status: "confirmed", ids: [1] },
            { fragment: "D001", status: "deferred", ids: [2] },
          ],
        },
        makeRegion(),
      );
      const fallback = buildGroupOnlyReviewFallback(plan);

      expect(fallback.groups.map((group) => group.candidateIds)).toEqual(
        shouldAttach ? [[1, 2]] : [[1], [2]],
      );
      expect(fallback.labels[1].role).toBe(shouldAttach ? "ruby" : "body");

      const model = parseGroupOnlyReviewResponse(
        JSON.stringify({
          labels: [
            { group: 1, role: "body" },
            { group: 2, role: "body" },
          ],
        }),
        plan,
      );
      expect(model.groups.map((group) => group.candidateIds)).toEqual(
        shouldAttach ? [[1, 2]] : [[1], [2]],
      );
      expect(model.labels[1].role).toBe(shouldAttach ? "ruby" : "body");
    },
  );

  it.each([
    [
      "top-level extras",
      JSON.stringify({
        labels: validLabels(),
        discardedIds: [],
      }),
    ],
    [
      "label extras",
      JSON.stringify({
        labels: [
          { group: 1, role: "body", text: "forbidden" },
          ...validLabels().slice(1),
        ],
      }),
    ],
    [
      "wrong label count",
      JSON.stringify({ labels: validLabels().slice(0, 3) }),
    ],
    [
      "non-integer group",
      JSON.stringify({
        labels: [{ group: 1.5, role: "body" }, ...validLabels().slice(1)],
      }),
    ],
    [
      "upstream fragment split",
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 2, role: "body" },
          { group: 3, role: "body" },
          { group: 3, role: "body" },
        ],
      }),
    ],
    [
      "ruby-only group",
      JSON.stringify({
        labels: [
          { group: 1, role: "ruby" },
          { group: 1, role: "ruby" },
          { group: 2, role: "body" },
          { group: 2, role: "body" },
        ],
      }),
    ],
    [
      "duplicate top-level key",
      `{"labels":${JSON.stringify(validLabels())},"labels":${JSON.stringify(validLabels())}}`,
    ],
    [
      "duplicate label key",
      '{"labels":[{"group":1,"group":1,"role":"body"},{"group":1,"role":"body"},{"group":2,"role":"body"},{"group":2,"role":"body"}]}',
    ],
  ])("rejects %s", (_name, rawText) => {
    const plan = buildGroupOnlyReviewPlan(makeCase(), makeRegion());
    expect(() => parseGroupOnlyReviewResponse(rawText, plan)).toThrow();
  });

  it("rejects duplicate/missing input coverage before a model request", () => {
    const duplicateCandidateCase = makeCase();
    (duplicateCandidateCase.candidates as JsonRecord[])[1].id = 10;
    expect(() =>
      buildGroupOnlyReviewPlan(duplicateCandidateCase, makeRegion()),
    ).toThrow(/unique positive id/i);

    const wrongOrderCase = makeCase();
    wrongOrderCase.candidateOrder = [11, 10, 20, 21];
    expect(() =>
      buildGroupOnlyReviewPlan(wrongOrderCase, makeRegion()),
    ).toThrow(/candidateOrder/i);

    const duplicateFragmentCase = makeCase();
    duplicateFragmentCase.upstreamFragments = [
      { fragment: "F1", ids: [10, 11] },
      { fragment: "F2", ids: [11, 20, 21] },
    ];
    expect(() =>
      buildGroupOnlyReviewPlan(duplicateFragmentCase, makeRegion()),
    ).toThrow(/unknown or duplicate fragment candidate/i);
  });

  it("passes plain case/region request data and accepts only labels from the callback", async () => {
    const reviewCase = makeCase();
    const region = makeRegion();
    const request = vi.fn(async (payload: JsonRecord) => {
      expect(payload.case).toBe(reviewCase);
      expect(payload.region).toBe(region);
      expect(payload.candidateOrder).toEqual([10, 11, 20, 21]);
      expect(payload.systemPrompt).toEqual(expect.any(String));
      expect(payload.prompt).toEqual(
        expect.stringContaining("candidateOrder="),
      );
      expect(payload.responseFormat).toMatchObject({
        schema: { required: ["labels"] },
      });
      return {
        outputText: JSON.stringify({ labels: validLabels() }),
        rawResponse: { usage: { prompt_tokens: 100 } },
      };
    });

    const result = await reviewGroupOnlyCrop(reviewCase, region, request);

    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "reviewed",
      source: "model",
      usedFallback: false,
      requestSkipped: false,
      rawResponse: { usage: { prompt_tokens: 100 } },
    });
    expect(result.groups.map((group) => group.candidateIds)).toEqual([
      [10, 11],
      [20, 21],
    ]);
  });

  it.each([
    [
      "HTTP error",
      async () =>
        Promise.reject(
          Object.assign(new Error("HTTP 500"), {
            failureCategory: "model-request",
          }),
        ),
    ],
    ["parse error", async () => "not json"],
    [
      "schema error",
      async () => JSON.stringify({ labels: validLabels(), text: "forbidden" }),
    ],
    [
      "invariant error",
      async () =>
        JSON.stringify({
          labels: [
            { group: 1, role: "body" },
            { group: 2, role: "body" },
            { group: 3, role: "body" },
            { group: 3, role: "body" },
          ],
        }),
    ],
  ])(
    "falls back to the exact upstream fragments after %s",
    async (_name, request) => {
      const result = await reviewGroupOnlyCrop(
        makeCase(),
        makeRegion(),
        request,
      );

      expect(result).toMatchObject({
        status: "fallback",
        source: "upstream-fallback",
        usedFallback: true,
        requestSkipped: false,
      });
      expect(result.groups.map((group) => group.candidateIds)).toEqual([
        [10, 11],
        [20, 21],
      ]);
      expect(result.groups.map((group) => group.rubyCandidateIds)).toEqual([
        [],
        [],
      ]);
      expect(result.groups.map((group) => group.jp)).toEqual([
        "本ほん",
        "文末",
      ]);
      const applied = applyReviewedGroupsToHints(
        makeCase().candidates as JsonRecord[],
        [result],
      );
      expect(applied.hints.every((hint) => hint.reviewRole === "body")).toBe(
        true,
      );
      expect(applied.validatedGroupOnlyReview).toBe(false);
    },
  );

  it("rethrows AbortError instead of hiding cancellation in a fallback", async () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    await expect(
      reviewGroupOnlyCrop(makeCase(), makeRegion(), async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });

  it("rethrows unclassified callback bugs instead of hiding them in fallback", async () => {
    const bug = new TypeError("request adapter accessed an invalid field");
    await expect(
      reviewGroupOnlyCrop(makeCase(), makeRegion(), async () => {
        throw bug;
      }),
    ).rejects.toBe(bug);
  });

  it("skips the model for one candidate and projects a body singleton", async () => {
    const candidate = {
      id: 99,
      x1: 12,
      y1: 25,
      x2: 64,
      y2: 170,
      ocrText: "一人",
      untouched: true,
      rolePrior: "stale",
      containerType: "stale",
    };
    const request = vi.fn();
    const result = await reviewGroupOnlyCrop(
      {
        candidates: [candidate],
        candidateOrder: [99],
        upstreamFragments: [{ fragment: "only", ids: [99] }],
      },
      { cropBbox: { x1: 0, y1: 0, x2: 100, y2: 200 } },
      request,
    );

    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "singleton",
      source: "singleton",
      usedFallback: false,
      requestSkipped: true,
      labels: [{ group: 1, role: "body" }],
      groups: [
        {
          localGroupIndex: 1,
          candidateIds: [99],
          bodyCandidateIds: [99],
          rubyCandidateIds: [],
          jp: "一人",
          bbox: { x1: 12, y1: 25, x2: 64, y2: 170 },
        },
      ],
    });
    const applied = applyReviewedGroupsToHints([candidate], [result]);
    expect(applied.hints[0]).toMatchObject({
      id: 99,
      x1: 12,
      y1: 25,
      x2: 64,
      y2: 170,
      ocrText: "一人",
      untouched: true,
      reviewRole: "body",
    });
    expect(applied.hints[0]).not.toHaveProperty("groupId");
    expect(applied.hints[0]).not.toHaveProperty("rolePrior");
    expect(applied.hints[0]).not.toHaveProperty("containerType");
    expect(applied.validatedGroupOnlyReview).toBe(true);
  });

  it("orders final groups by their smallest immutable candidate id", () => {
    const candidates = [
      { id: 4, x1: 200, y1: 20, x2: 240, y2: 160, ocrText: "後" },
      { id: 1, x1: 100, y1: 20, x2: 140, y2: 160, ocrText: "先" },
    ];
    const plan = buildGroupOnlyReviewPlan(
      {
        candidates,
        candidateOrder: [4, 1],
        upstreamFragments: [
          { fragment: "F004", ids: [4] },
          { fragment: "F001", ids: [1] },
        ],
      },
      makeRegion(),
    );
    const result = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 2, role: "body" },
        ],
      }),
      plan,
    );

    expect(result.groups.map((group) => group.candidateIds)).toEqual([
      [1],
      [4],
    ]);
  });

  it("numbers final groups page-wide across crop results and clears stale grouping", () => {
    const pageCase = makeCase();
    const pageHints = pageCase.candidates as JsonRecord[];
    const firstCase = {
      candidates: pageHints.slice(0, 2),
      candidateOrder: [10, 11],
      upstreamFragments: [{ fragment: "first", ids: [10, 11] }],
    };
    const secondCase = {
      candidates: pageHints.slice(2),
      candidateOrder: [20, 21],
      upstreamFragments: [{ fragment: "second", ids: [20, 21] }],
    };
    const first = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 1, role: "body" },
        ],
      }),
      buildGroupOnlyReviewPlan(firstCase, makeRegion()),
    );
    const second = parseGroupOnlyReviewResponse(
      JSON.stringify({
        labels: [
          { group: 1, role: "body" },
          { group: 1, role: "body" },
        ],
      }),
      buildGroupOnlyReviewPlan(secondCase, makeRegion()),
    );

    const applied = applyReviewedGroupsToHints(pageHints, [first, second], {
      validatedGroupOnlyReview: true,
    });

    expect(applied.hints.map((hint) => hint.groupId)).toEqual([
      "G001",
      "G001",
      "G002",
      "G002",
    ]);
    expect(applied.hints.map((hint) => hint.orderInGroup)).toEqual([
      1, 2, 1, 2,
    ]);
    expect(applied.hints.every((hint) => hint.groupSize === 2)).toBe(true);
    expect(
      applied.hints.every(
        (hint) =>
          hint.rolePrior === "ordinary_mergeable" &&
          hint.containerType === "same_text_container",
      ),
    ).toBe(true);
    expect(applied.hints.every((hint) => hint.reviewRole === "body")).toBe(
      true,
    );
    expect(applied.reviewedGroupCount).toBe(2);
    expect(applied.validatedGroupOnlyReview).toBe(true);
  });
});

function validLabels() {
  return [
    { group: 1, role: "body" },
    { group: 1, role: "ruby" },
    { group: 2, role: "body" },
    { group: 2, role: "body" },
  ];
}

function reviewCandidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  paddleGroupId: string,
): JsonRecord {
  return {
    id,
    x1,
    y1,
    x2,
    y2,
    ocrText,
    score: 0.99,
    paddleGroupId,
    paddleOrder: 1,
    paddleGroupSize: 1,
    reviewStatus: "confirmed",
    reviewReasons: [],
  };
}

function makeRegion(): JsonRecord {
  return {
    cropId: "C001",
    cropBbox: { x1: 0, y1: 0, x2: 400, y2: 300 },
  };
}

function makeCase(): JsonRecord {
  return {
    caseId: "P01-C001",
    candidateOrder: [10, 11, 20, 21],
    candidates: [
      {
        id: 10,
        x1: 100,
        y1: 100,
        x2: 150,
        y2: 220,
        ocrText: "本",
        score: 0.99,
        paddleGroupId: "PADDLE-A",
        paddleOrder: 1,
        groupId: "STALE-A",
        orderInGroup: 99,
        groupSize: 99,
        semanticGroup: true,
        rolePrior: "stale",
        containerType: "stale",
        untouched: "candidate-10",
      },
      {
        id: 11,
        x1: 80,
        y1: 80,
        x2: 105,
        y2: 135,
        ocrText: "ほん",
        score: 0.91,
        paddleGroupId: "PADDLE-A",
        paddleOrder: 2,
        groupId: "STALE-A",
        orderInGroup: 99,
        groupSize: 99,
        semanticGroup: true,
        untouched: "candidate-11",
      },
      {
        id: 20,
        x1: 200,
        y1: 100,
        x2: 240,
        y2: 210,
        ocrText: "文",
        score: 0.98,
        paddleGroupId: "PADDLE-A",
        paddleOrder: 3,
        groupId: "STALE-B",
        orderInGroup: 99,
        groupSize: 99,
        semanticGroup: true,
        untouched: "candidate-20",
      },
      {
        id: 21,
        x1: 250,
        y1: 105,
        x2: 280,
        y2: 205,
        ocrText: "末",
        score: 0.97,
        paddleGroupId: "PADDLE-A",
        paddleOrder: 4,
        groupId: "STALE-B",
        orderInGroup: 99,
        groupSize: 99,
        semanticGroup: true,
        untouched: "candidate-21",
      },
    ],
    upstreamFragments: [
      { fragment: "F001", status: "confirmed", ids: [10, 11] },
      { fragment: "F002", status: "deferred", ids: [20, 21] },
    ],
  };
}
