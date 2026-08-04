import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;
type ReviewProjection = {
  groups: Array<{
    candidateIds: number[];
    bodyCandidateIds: number[];
    rubyCandidateIds: number[];
    jp: string;
  }>;
};

const {
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  parseGroupOnlyReviewResponse,
} = require("../src/main/runtime/semantic-ocr/group-only-review.cjs") as {
  buildGroupOnlyReviewFallback: (plan: JsonRecord) => ReviewProjection;
  buildGroupOnlyReviewPlan: (
    reviewCase: JsonRecord,
    region: JsonRecord,
  ) => JsonRecord;
  parseGroupOnlyReviewResponse: (
    raw: string,
    plan: JsonRecord,
  ) => ReviewProjection;
};

describe("group-only adjacent vertical column stabilization", () => {
  it("weakly reunites the observed p13 split while retaining both ruby runs", () => {
    const plan = buildPlan(p13Candidates());
    const expected = expect.objectContaining({
      candidateIds: [2, 4, 3, 5],
      bodyCandidateIds: [2, 4],
      rubyCandidateIds: [3, 5],
      jp: "何なんだこの兄妹",
    });

    expect(parseSplitModelResult(plan).groups).toEqual([expected]);
    expect(buildGroupOnlyReviewFallback(plan).groups).toEqual([expected]);
  });

  it("keeps nearby columns separate when either one has no ruby evidence", () => {
    const candidates = p13Candidates();
    candidates[2] = {
      ...candidates[2],
      ocrText: "兄妹",
      x1: 640,
      x2: 696,
      y1: 1146,
      y2: 1367,
    };
    const plan = buildPlan(candidates, [
      { fragment: "B002", status: "confirmed", ids: [3, 2] },
      { fragment: "B003", status: "confirmed", ids: [5, 4] },
    ]);
    const result = parseGroupOnlyReviewResponse(
      '{"labels":[{"group":1,"role":"ruby"},{"group":1,"role":"body"},{"group":2,"role":"body"},{"group":2,"role":"body"}]}',
      plan,
    );

    expect(result.groups).toHaveLength(2);
  });

  it.each([
    ["different review contexts", { context: "RC002" }],
    ["non-overlapping vertical starts", { y1: 1380, y2: 1600 }],
    ["a distant second column", { x1: 400, x2: 456 }],
  ])("does not merge %s", (_label, patch) => {
    const candidates = p13Candidates();
    candidates[2] = { ...candidates[2], ...patch };
    candidates[3] = { ...candidates[3], ...patch };
    if ("context" in patch) {
      candidates[2].reviewContextId = patch.context;
      candidates[3].reviewContextId = patch.context;
      delete candidates[2].context;
      delete candidates[3].context;
    }

    expect(parseSplitModelResult(buildPlan(candidates)).groups).toHaveLength(2);
  });
});

function parseSplitModelResult(plan: JsonRecord): ReviewProjection {
  return parseGroupOnlyReviewResponse(
    '{"labels":[{"group":1,"role":"ruby"},{"group":1,"role":"body"},{"group":2,"role":"ruby"},{"group":2,"role":"body"}]}',
    plan,
  );
}

function buildPlan(
  candidates: JsonRecord[],
  upstreamFragments: JsonRecord[] = [
    { fragment: "B002", status: "confirmed", ids: [3, 2] },
    { fragment: "B003", status: "confirmed", ids: [5, 4] },
  ],
): JsonRecord {
  return buildGroupOnlyReviewPlan(
    { candidates, upstreamFragments },
    { cropId: "C002", cropBbox: { x1: 600, y1: 1000, x2: 800, y2: 1450 } },
  );
}

function p13Candidates(): JsonRecord[] {
  return [
    candidate(3, "なん", 740, 1056, 767, 1103, "G001", 1, "B002"),
    candidate(2, "何なんだ", 688, 1045, 752, 1260, "G001", 2, "B002"),
    candidate(5, "きょうだい", 690, 1257, 717, 1365, "G002", 1, "B003"),
    candidate(4, "この兄妹", 640, 1146, 696, 1367, "G002", 2, "B003"),
  ];
}

function candidate(
  id: number,
  ocrText: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  paddleGroupId: string,
  paddleOrder: number,
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
    paddleGroupId,
    paddleOrder,
    paddleGroupSize: 2,
    reviewFragmentId,
    reviewStatus: "confirmed",
    reviewReasons: [],
    reviewContextId: "RC001",
  };
}
