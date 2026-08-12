import { describe, expect, it } from "vitest";

type AblationRow = {
  blockId: string;
  projectedRole: string;
  projectedRoute: string;
  projectedFontId: string | null;
  reasonCodes: string[];
};

type AblationModule = {
  buildPageRelativeProjection: (
    inferences: unknown[],
    items: unknown[],
    decisions: unknown[],
    pageStates: Map<string, unknown>,
  ) => { rows: AblationRow[] };
};

const ablation =
  require("../scripts/ablate_manga_font_page_relative_role.cjs") as AblationModule;

describe("page-relative role ablation", () => {
  it("recovers repeated ordinary morphology but preserves a clear glyph outlier", () => {
    const rows = [
      fixture("body-a", "dialogue", 0.82, morphology(1.3, 1.25, 0.48, 55)),
      fixture("body-b", "dialogue", 0.76, morphology(1.32, 1.26, 0.5, 57)),
      fixture(
        "false-emphasis",
        "emphasis_dialogue",
        0.72,
        morphology(1.31, 1.27, 0.49, 56),
      ),
      fixture(
        "corroborated-body",
        "emphasis_dialogue",
        0.9,
        morphology(1.29, 1.24, 0.5, 54),
        {
          variantWinner: true,
          winnerFontId: "mongtori",
          selectedFontId: "ridi-batang",
        },
      ),
      fixture(
        "true-variant",
        "emphasis_dialogue",
        0.95,
        morphology(2.4, 2.2, 0.68, 24),
        { variantWinner: true, selectedFontId: "mongtori" },
      ),
    ];
    const pageStates = new Map(
      rows
        .slice(0, 4)
        .map((row) => [
          row.inference.blockId,
          { mode: "page_anchor", anchorFontId: "ridi-batang" },
        ]),
    );

    const projected = project(rows, pageStates);

    expect(byId(projected, "false-emphasis")).toMatchObject({
      projectedRole: "dialogue",
      projectedRoute: "body",
      projectedFontId: "ridi-batang",
    });
    expect(byId(projected, "corroborated-body")).toMatchObject({
      projectedRole: "dialogue",
      projectedFontId: "ridi-batang",
    });
    expect(byId(projected, "true-variant")).toMatchObject({
      projectedRole: "emphasis_dialogue",
      projectedRoute: "variant",
      projectedFontId: "mongtori",
    });
  });

  it("does not flatten a strong local variant face inside an otherwise ordinary cluster", () => {
    const shared = morphology(1.42, 1.35, 0.52, 62);
    const rows = [
      fixture("body-a", "dialogue", 0.84, shared),
      fixture("body-b", "dialogue", 0.79, shared),
      fixture("strong-variant", "emphasis_dialogue", 0.7, shared, {
        variantWinner: true,
        selectedFontId: "mongtori",
      }),
    ];

    const projected = project(rows);

    expect(byId(projected, "strong-variant")).toMatchObject({
      projectedRole: "emphasis_dialogue",
      projectedFontId: "mongtori",
      reasonCodes: ["preserve_strong_local_variant_pixel_gap"],
    });
  });

  it("allows only thin vertical all-emphasis pages to self-anchor", () => {
    const thin = Array.from({ length: 4 }, (_, index) =>
      fixture(
        `thin-${index}`,
        "emphasis_dialogue",
        0.82,
        morphology(1.35 + index * 0.01, 1.3, 0.5, 62),
      ),
    );
    const heavy = Array.from({ length: 4 }, (_, index) =>
      fixture(
        `heavy-${index}`,
        "emphasis_dialogue",
        0.82,
        morphology(2 + index * 0.01, 1.9, 0.52, 30),
      ),
    );

    const thinProjection = project(thin);
    const heavyProjection = project(heavy);

    expect(
      thinProjection.rows.filter((row) => row.projectedRole === "dialogue"),
    ).toHaveLength(4);
    expect(
      heavyProjection.rows.filter((row) => row.projectedRole === "dialogue"),
    ).toHaveLength(0);
  });

  it("reranks a nearby split Single Day fragment but preserves an isolated breath", () => {
    const peer = fixture(
      "peer",
      "emphasis_dialogue",
      0.99,
      morphology(1.5, 1.14, 0.49, 70, 20),
      {
        bbox: { x: 712, y: 695, w: 70, h: 80 },
        candidateIds: [16],
        selectedFontId: "gaegu",
        variantWinner: true,
      },
    );
    const split = fixture(
      "split",
      "emphasis_dialogue",
      0.955,
      morphology(1.63, 1.55, 0.41, 53, 5),
      {
        bbox: { x: 645, y: 797, w: 51, h: 54 },
        candidateIds: [20],
        selectedFontId: "single-day",
        variantWinner: true,
        includeGaeguTop3: true,
      },
    );
    const breath = fixture(
      "breath",
      "emphasis_dialogue",
      0.994,
      morphology(1.43, 1.09, 0.52, 59, 8),
      {
        bbox: { x: 120, y: 100, w: 33, h: 63 },
        candidateIds: [23],
        selectedFontId: "single-day",
        variantWinner: true,
        includeGaeguTop3: true,
      },
    );

    const projected = project([peer, split, breath]);

    expect(byId(projected, "split")).toMatchObject({
      projectedRole: "emphasis_dialogue",
      projectedFontId: "gaegu",
      reasonCodes: expect.arrayContaining(["split_fragment_peer_rank"]),
    });
    expect(byId(projected, "breath")).toMatchObject({
      projectedRole: "emphasis_dialogue",
      projectedFontId: "single-day",
      reasonCodes: ["preserve_isolated_single_day_variant"],
    });
  });
});

function project(
  fixtures: ReturnType<typeof fixture>[],
  pageStates = new Map<string, unknown>(),
) {
  return ablation.buildPageRelativeProjection(
    fixtures.map((entry) => entry.inference),
    fixtures.map((entry) => entry.item),
    fixtures.map((entry) => entry.decision),
    pageStates,
  );
}

function byId(projected: { rows: AblationRow[] }, blockId: string) {
  return projected.rows.find((row) => row.blockId === blockId);
}

function fixture(
  blockId: string,
  role: "dialogue" | "emphasis_dialogue",
  primaryProbability: number,
  glyphMorphology: ReturnType<typeof morphology>,
  options: {
    bbox?: { x: number; y: number; w: number; h: number };
    candidateIds?: number[];
    selectedFontId?: string;
    winnerFontId?: string;
    variantWinner?: boolean;
    includeGaeguTop3?: boolean;
  } = {},
) {
  const alternativeRole =
    role === "dialogue" ? "emphasis_dialogue" : "dialogue";
  const candidates = options.variantWinner
    ? [
        candidate(
          options.winnerFontId ?? options.selectedFontId ?? "mongtori",
          1,
          0.68,
        ),
        candidate("ridi-batang", 2, 0.08),
        ...(options.includeGaeguTop3
          ? [candidate("gaegu", 3, 0.07)]
          : [candidate("nanum-gothic", 3, 0.06)]),
      ]
    : [
        candidate("ridi-batang", 1, 0.58),
        candidate("nanum-myeongjo", 2, 0.2),
        candidate("nanum-gothic", 3, 0.12),
      ];
  if (
    options.selectedFontId === "single-day" &&
    !candidates.some((entry) => entry.fontId === "single-day")
  ) {
    candidates.unshift(candidate("single-day", 1, 0.7));
    candidates.forEach((entry, index) => {
      entry.rawPixelRank = index + 1;
      entry.rank = index + 1;
    });
  }
  return {
    inference: {
      blockId,
      rolePrediction: {
        primary: role,
        confidence: primaryProbability,
        alternatives: [
          { role: alternativeRole, confidence: 1 - primaryProbability },
        ],
      },
      scoreRoute: {
        family: role === "dialogue" ? "body" : "variant",
      },
      treatment: { orientation: "vertical", distortion: "none" },
      glyphMorphology,
      localEvidence: { rankedCandidates: candidates },
    },
    item: {
      blockId,
      item: {
        direction: "vertical",
        bbox: options.bbox ?? { x: 100, y: 100, w: 120, h: 180 },
        candidateIds: options.candidateIds ?? [1, 2],
        type: "nonsolid",
      },
    },
    decision: {
      blockId,
      blockIndex: 0,
      applied: true,
      role,
      selectedFontId: options.selectedFontId ?? candidates[0]?.fontId ?? null,
    },
  };
}

function candidate(fontId: string, rank: number, rawPixelScore: number) {
  return {
    fontId,
    rank,
    rawPixelRank: rank,
    rawPixelScore,
    totalScore: rawPixelScore,
    renderStatus: "rendered",
    confidence: rank === 1 ? 0.55 : 0,
  };
}

function morphology(
  globalForegroundDistanceMean: number,
  medianComponentDistanceMean: number,
  medianComponentFill: number,
  foregroundMeanLuma: number,
  connectedComponentCount = 24,
) {
  return {
    contractVersion: "font-matching-glyph-morphology-v1",
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    connectedComponentCount,
    globalForegroundDistanceMean,
    medianComponentDistanceMean,
    medianComponentFill,
    foregroundMeanLuma,
  };
}
