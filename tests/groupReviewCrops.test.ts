import { describe, expect, it, vi } from "vitest";

type Box = [number, number, number, number];
type Status = "confirmed" | "deferred";
type Candidate = {
  id: number;
  bbox: Box;
  reviewFragmentId: string;
  reviewStatus: Status;
  reviewReasons: string[];
  reviewOrder: number;
  reviewContextId?: string;
  paddleGroupId?: string;
  paddleOrder?: number;
  paddleGroupSize?: number;
  animeTextRegionId?: string;
  animeTextRegionScore?: number;
  animeTextContainment?: number;
  animeTextRegionBbox?: number[];
  animeTextEvidenceVersion?: number;
  animeTextModelRevision?: string;
};
type Region = {
  cropId: string;
  reasons: string[];
  confirmedFragmentIds: string[];
  deferredFragmentIds: string[];
  fragmentIds: string[];
  candidateIds: number[];
  contentBbox: { x1: number; y1: number; x2: number; y2: number };
  cropBbox: { x1: number; y1: number; x2: number; y2: number };
  cropRect: { x: number; y: number; width: number; height: number };
  fragments: Array<{
    reviewFragmentId: string;
    candidateIds: number[];
    bbox: { x1: number; y1: number; x2: number; y2: number };
    bbox1000: Box;
  }>;
  candidates: Array<{
    candidateId: number;
    reviewFragmentId: string;
    paddleGroupId: string | null;
    paddleOrder: number | null;
    paddleGroupSize: number | null;
    bbox1000: Box;
  }>;
};
type Plan = {
  version: number;
  pageWidth: number;
  pageHeight: number;
  fragmentCount: number;
  candidateCount: number;
  regions: Region[];
};

const {
  buildGroupReviewCropImageVariants,
  buildGroupReviewCropPlan,
  projectBoxToCrop1000,
} = require("../src/main/runtime/semantic-ocr/group-review-crops.cjs") as {
  buildGroupReviewCropImageVariants: (
    options: Record<string, unknown>,
    plan: Plan,
    dependencies?: Record<string, unknown>,
  ) => {
    crops: Array<{
      region: Region;
      variant: Record<string, unknown>;
    }>;
    fallbackReason: string | null;
  };
  buildGroupReviewCropPlan: (
    candidates: Candidate[],
    width: number,
    height: number,
  ) => Plan;
  projectBoxToCrop1000: (
    pageBbox: { x1: number; y1: number; x2: number; y2: number },
    cropBbox: { x1: number; y1: number; x2: number; y2: number },
  ) => Box;
};

describe("group review crop planning", () => {
  it("uses reviewFragmentId as the exact fragment boundary and attaches one ruby host", () => {
    const candidates = [
      candidate(1, [700, 100, 730, 220], "F001", "confirmed", 2),
      {
        ...candidate(2, [665, 100, 695, 220], "F001", "confirmed", 1),
        paddleGroupId: "G017",
        paddleOrder: 2,
        paddleGroupSize: 4,
      },
      candidate(3, [733, 120, 743, 180], "D001", "deferred", 1, [
        "ruby_candidate",
      ]),
      candidate(4, [100, 500, 200, 540], "F002", "confirmed", 1),
    ];
    const snapshot = structuredClone(candidates);

    const plan = buildGroupReviewCropPlan(candidates, 1000, 1000);

    const attached = plan.regions.find((region) =>
      region.fragmentIds.includes("F001"),
    );
    expect(attached).toMatchObject({
      reasons: ["deferred_attached_once"],
      confirmedFragmentIds: ["F001"],
      deferredFragmentIds: ["D001"],
      candidateIds: [3, 2, 1],
      contentBbox: { x1: 665, y1: 100, x2: 743, y2: 220 },
    });
    expect(
      attached?.fragments.find(
        (fragment) => fragment.reviewFragmentId === "F001",
      ),
    ).toMatchObject({
      candidateIds: [2, 1],
      bbox: { x1: 665, y1: 100, x2: 730, y2: 220 },
    });
    for (const projected of attached?.candidates ?? []) {
      expect(projected.bbox1000).toHaveLength(4);
      expect(projected.bbox1000.every(Number.isInteger)).toBe(true);
      expect(projected.bbox1000[0]).toBeLessThan(projected.bbox1000[2]);
      expect(projected.bbox1000[1]).toBeLessThan(projected.bbox1000[3]);
      expect(Math.min(...projected.bbox1000)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...projected.bbox1000)).toBeLessThanOrEqual(1000);
    }
    expect(
      attached?.candidates.find((entry) => entry.candidateId === 2),
    ).toMatchObject({
      paddleGroupId: "G017",
      paddleOrder: 2,
      paddleGroupSize: 4,
    });
    expect(
      attached?.candidates.find((entry) => entry.candidateId === 1),
    ).toMatchObject({
      paddleGroupId: null,
      paddleOrder: null,
      paddleGroupSize: null,
    });
    expect(candidates).toEqual(snapshot);
  });

  it("does not attach oversized display or uncertain SFX fragments to a host", () => {
    const confirmed = candidate(
      1,
      [100, 100, 120, 300],
      "F001",
      "confirmed",
      1,
    );
    const ordinaryDeferred = candidate(
      2,
      [124, 100, 144, 300],
      "D001",
      "deferred",
      1,
    );
    const attached = buildGroupReviewCropPlan(
      [confirmed, ordinaryDeferred],
      1000,
      1000,
    );
    const heldOut = buildGroupReviewCropPlan(
      [
        confirmed,
        {
          ...ordinaryDeferred,
          reviewReasons: ["oversized_uncertain_sfx"],
        },
      ],
      1000,
      1000,
    );

    expect(attached.regions).toHaveLength(1);
    expect(attached.regions[0].reasons).toContain("deferred_attached_once");
    expect(heldOut.regions).toHaveLength(2);
    expect(
      heldOut.regions.find((region) =>
        region.deferredFragmentIds.includes("D001"),
      )?.reasons,
    ).toContain("deferred_only");
    expectNonOverlapping(heldOut);
  });

  it("leaves a deferred fragment independent when two hosts are equally plausible", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 120, 300], "F001", "confirmed", 1),
        candidate(2, [150, 100, 170, 300], "F002", "confirmed", 1),
        candidate(3, [124, 100, 146, 300], "D001", "deferred", 1),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(3);
    expect(plan.regions.flatMap((region) => region.reasons)).not.toContain(
      "deferred_attached_once",
    );
    expect(
      plan.regions.find((region) => region.deferredFragmentIds.includes("D001"))
        ?.reasons,
    ).toContain("deferred_only");
    expectNonOverlapping(plan);
  });

  it("uses a unique shared detector region only to widen deferred visual review", () => {
    const detectorEvidence = {
      animeTextRegionId: "ATY001",
      animeTextRegionScore: 0.84,
      animeTextContainment: 0.9,
      animeTextRegionBbox: [80, 80, 190, 280],
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    };
    const plan = buildGroupReviewCropPlan(
      [
        {
          ...candidate(1, [100, 100, 130, 260], "B001", "confirmed", 1),
          ...detectorEvidence,
        },
        {
          ...candidate(2, [142, 100, 172, 160], "D001", "deferred", 1),
          ...detectorEvidence,
        },
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]).toMatchObject({
      reasons: ["deferred_anime_text_hint", "deferred_attached_once"],
      confirmedFragmentIds: ["B001"],
      deferredFragmentIds: ["D001"],
      candidateIds: [1, 2],
    });
  });

  it("never joins two confirmed fragments from detector evidence alone", () => {
    const detectorEvidence = {
      animeTextRegionId: "ATY008",
      animeTextRegionScore: 0.86,
      animeTextContainment: 1,
      animeTextRegionBbox: [80, 80, 750, 780],
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    };
    const plan = buildGroupReviewCropPlan(
      [
        {
          ...candidate(1, [100, 100, 130, 260], "B001", "confirmed", 1),
          ...detectorEvidence,
        },
        {
          ...candidate(2, [700, 600, 730, 760], "B002", "confirmed", 1),
          ...detectorEvidence,
        },
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(2);
    expect(plan.regions.map((region) => region.fragmentIds)).toEqual([
      ["B001"],
      ["B002"],
    ]);
    expect(plan.regions.flatMap((region) => region.reasons)).not.toContain(
      "deferred_anime_text_hint",
    );
  });

  it("puts intersecting confirmed fragments in one joint visual region", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 160, 240], "F001", "confirmed", 1),
        candidate(2, [150, 180, 210, 300], "F002", "confirmed", 1),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]).toMatchObject({
      reasons: ["confirmed_bbox_collision"],
      confirmedFragmentIds: ["F001", "F002"],
      candidateIds: [1, 2],
      contentBbox: { x1: 100, y1: 100, x2: 210, y2: 300 },
    });
  });

  it.each([3, 4])(
    "puts %i staggered vertical columns from one review context in one crop",
    (columnCount) => {
      const plan = buildGroupReviewCropPlan(
        staggeredContextCandidates(columnCount),
        1200,
        1800,
      );

      expect(plan.regions).toHaveLength(1);
      expect(plan.regions[0]).toMatchObject({
        reasons: ["confirmed_review_context"],
        fragmentIds:
          columnCount === 3 ? ["B001", "B002"] : ["B001", "B002", "B003"],
        candidateIds: Array.from(
          { length: columnCount },
          (_, index) => index + 1,
        ),
      });
      expect(plan.regions[0].candidates).toEqual(
        expect.arrayContaining(
          Array.from({ length: columnCount }, (_, index) =>
            expect.objectContaining({
              candidateId: index + 1,
              reviewContextId: "RC001",
            }),
          ),
        ),
      );
      expect(plan.regions[0].contentBbox).toEqual({
        x1: columnCount === 3 ? 620 : 580,
        y1: 200,
        x2: 732,
        y2: columnCount === 3 ? 462 : 476,
      });
    },
  );

  it.each([
    {
      name: "invalid context id",
      candidates: [
        {
          ...candidate(1, [100, 100, 120, 300], "B001", "confirmed", 1),
          reviewContextId: "context-one",
        },
      ],
      message: /reviewContextId is malformed/,
    },
    {
      name: "orphan context",
      candidates: [
        {
          ...candidate(1, [100, 100, 120, 300], "B001", "confirmed", 1),
          reviewContextId: "RC001",
        },
      ],
      message: /must connect at least two review fragments/,
    },
    {
      name: "partial fragment context",
      candidates: [
        {
          ...candidate(1, [100, 100, 120, 300], "B001", "confirmed", 1),
          reviewContextId: "RC001",
        },
        candidate(2, [124, 100, 144, 300], "B001", "confirmed", 2),
        {
          ...candidate(3, [148, 100, 168, 300], "B002", "confirmed", 1),
          reviewContextId: "RC001",
        },
      ],
      message: /inconsistent reviewContextId/,
    },
  ])(
    "rejects malformed crop review metadata: $name",
    ({ candidates, message }) => {
      expect(() => buildGroupReviewCropPlan(candidates, 1000, 1000)).toThrow(
        message,
      );
    },
  );

  it("joins hostless deferred fragments only on one compatible axis", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 120, 200], "D001", "deferred", 1),
        candidate(2, [125, 105, 145, 205], "D002", "deferred", 1),
        candidate(3, [150, 220, 170, 320], "D003", "deferred", 1),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(2);
    expect(
      plan.regions.find((region) => region.fragmentIds.includes("D001")),
    ).toMatchObject({
      reasons: ["deferred_axis_context"],
      fragmentIds: ["D001", "D002"],
      candidateIds: [1, 2],
    });
    expect(
      plan.regions.find((region) => region.fragmentIds.includes("D003")),
    ).toMatchObject({
      reasons: ["deferred_only"],
      fragmentIds: ["D003"],
    });
    expectNonOverlapping(plan);
  });

  it("keeps the accepted transitive axis context without a diagonal shortcut", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 120, 200], "D001", "deferred", 1),
        candidate(2, [124, 100, 144, 200], "D002", "deferred", 1),
        candidate(3, [124, 204, 144, 304], "D003", "deferred", 1),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]).toMatchObject({
      reasons: ["deferred_axis_context"],
      fragmentIds: ["D001", "D002", "D003"],
      candidateIds: [1, 2, 3],
    });
  });

  it("splits overlapping padding at a midpoint without trimming content", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 120, 300], "F001", "confirmed", 1),
        candidate(2, [145, 100, 165, 300], "F002", "confirmed", 1),
      ],
      1000,
      1000,
    );
    const left = plan.regions.find((region) =>
      region.fragmentIds.includes("F001"),
    );
    const right = plan.regions.find((region) =>
      region.fragmentIds.includes("F002"),
    );

    expect(left?.cropBbox.x2).toBe(133);
    expect(right?.cropBbox.x1).toBe(133);
    expect(left?.cropBbox.x2).toBeGreaterThanOrEqual(left?.contentBbox.x2 ?? 0);
    expect(right?.cropBbox.x1).toBeLessThanOrEqual(right?.contentBbox.x1 ?? 0);
    expectNonOverlapping(plan);
  });

  it("lets an oversized display strip yield to an ordinary speech crop", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 160, 250], "F001", "confirmed", 1),
        candidate(2, [150, 120, 180, 200], "D001", "deferred", 1, [
          "oversized_display_text",
        ]),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(2);
    expect(
      plan.regions.find((region) => region.fragmentIds.includes("D001"))
        ?.reasons,
    ).toContain("display_priority_clip");
    expectNonOverlapping(plan);
  });

  it("cuts a detector-only hairline seam instead of making a huge joint crop", () => {
    const plan = buildGroupReviewCropPlan(
      [
        candidate(1, [100, 100, 150, 300], "F001", "confirmed", 1),
        candidate(2, [40, 298, 600, 360], "D001", "deferred", 1),
      ],
      1000,
      1000,
    );

    expect(plan.regions).toHaveLength(2);
    expect(plan.regions.flatMap((region) => region.reasons)).toContain(
      "narrow_content_seam",
    );
    expectNonOverlapping(plan);
  });

  it("rejects malformed fragment metadata before any geometry grouping", () => {
    expect(() =>
      buildGroupReviewCropPlan(
        [
          candidate(1, [100, 100, 120, 200], "F001", "confirmed", 1),
          candidate(2, [125, 100, 145, 200], "F001", "deferred", 2),
        ],
        1000,
        1000,
      ),
    ).toThrow(/mixed reviewStatus/i);
    expect(() =>
      buildGroupReviewCropPlan(
        [
          candidate(1, [100, 100, 120, 200], "F001", "confirmed", 1),
          candidate(2, [125, 100, 145, 200], "F001", "confirmed", 1),
        ],
        1000,
        1000,
      ),
    ).toThrow(/duplicate reviewOrder/i);
  });

  it("projects page boxes to integer crop-relative 0..1000 coordinates", () => {
    expect(
      projectBoxToCrop1000(
        { x1: 125, y1: 250, x2: 301, y2: 499 },
        { x1: 100, y1: 200, x2: 500, y2: 600 },
      ),
    ).toEqual([62, 125, 503, 748]);
  });
});

describe("group review crop image variants", () => {
  it("creates unmarked PNG ImageVariants from the original page atomically", () => {
    const plan = buildGroupReviewCropPlan(
      [candidate(1, [100, 100, 200, 300], "F001", "confirmed", 1)],
      1000,
      1000,
    );
    const crop = vi.fn(() => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from([1, 2, 3]),
    }));
    const createFromPath = vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1000, height: 1000 }),
      crop,
      toPNG: () => Buffer.from([]),
    }));

    const result = buildGroupReviewCropImageVariants(
      { imagePath: "C:\\page.png" },
      plan,
      { nativeImageModule: { createFromPath } },
    );

    expect(result.fallbackReason).toBeNull();
    expect(createFromPath).toHaveBeenCalledWith("C:\\page.png");
    expect(crop).toHaveBeenCalledWith(plan.regions[0].cropRect);
    expect(result.crops).toHaveLength(1);
    expect(result.crops[0].variant).toMatchObject({
      role: "semantic-group-review-crop",
      path: "C:\\page.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AQID",
      width: plan.regions[0].cropRect.width,
      height: plan.regions[0].cropRect.height,
      originalWidth: 1000,
      originalHeight: 1000,
      semanticReviewCropId: "C001",
      semanticCropRect: plan.regions[0].cropRect,
    });
    expect(result.crops[0].variant).not.toHaveProperty("marks");
  });

  it("returns no partial crop array when a later crop fails", () => {
    const candidates = [
      candidate(1, [100, 100, 200, 300], "F001", "confirmed", 1),
      candidate(2, [700, 700, 800, 900], "F002", "confirmed", 1),
    ];
    let cropCount = 0;
    const plan = buildGroupReviewCropPlan(candidates, 1000, 1000);
    const result = buildGroupReviewCropImageVariants(
      { imagePath: "C:\\page.png" },
      plan,
      {
        nativeImageModule: {
          createFromPath: () => ({
            isEmpty: () => false,
            getSize: () => ({ width: 1000, height: 1000 }),
            crop: () => {
              cropCount += 1;
              return {
                isEmpty: () => cropCount === 2,
                toPNG: () => Buffer.from([1]),
              };
            },
            toPNG: () => Buffer.from([]),
          }),
        },
      },
    );

    expect(plan.regions).toHaveLength(2);
    expect(result.crops).toEqual([]);
    expect(result.fallbackReason).toBe("crop-decode-failed:C002");
  });

  it("propagates programming errors from the native image adapter", () => {
    const plan = buildGroupReviewCropPlan(
      [candidate(1, [100, 100, 200, 300], "F001", "confirmed", 1)],
      1000,
      1000,
    );
    const bug = new TypeError("native image adapter contract changed");

    expect(() =>
      buildGroupReviewCropImageVariants({ imagePath: "C:\\page.png" }, plan, {
        nativeImageModule: {
          createFromPath: () => {
            throw bug;
          },
        },
      }),
    ).toThrow(bug);
  });
});

function candidate(
  id: number,
  bbox: Box,
  reviewFragmentId: string,
  reviewStatus: Status,
  reviewOrder: number,
  reviewReasons: string[] = [],
): Candidate {
  return {
    id,
    bbox,
    reviewFragmentId,
    reviewStatus,
    reviewReasons,
    reviewOrder,
  };
}

function staggeredContextCandidates(columnCount: number): Candidate[] {
  const boxes: Box[] = [
    [700, 200, 732, 390],
    [660, 220, 692, 430],
    [620, 252, 652, 462],
    [580, 286, 612, 476],
  ];
  return boxes.slice(0, columnCount).map((bbox, index) => ({
    ...candidate(
      index + 1,
      bbox,
      index < 2 ? "B001" : `B00${index}`,
      "confirmed",
      index < 2 ? index + 1 : 1,
    ),
    reviewContextId: "RC001",
  }));
}

function expectNonOverlapping(plan: Plan) {
  for (let leftIndex = 0; leftIndex < plan.regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < plan.regions.length;
      rightIndex += 1
    ) {
      expect(
        intersectionArea(
          plan.regions[leftIndex].cropBbox,
          plan.regions[rightIndex].cropBbox,
        ),
      ).toBe(0);
    }
  }
}

function intersectionArea(
  left: { x1: number; y1: number; x2: number; y2: number },
  right: { x1: number; y1: number; x2: number; y2: number },
) {
  return (
    Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1)) *
    Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1))
  );
}
