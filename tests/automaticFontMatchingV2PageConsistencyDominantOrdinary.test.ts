import { describe, expect, it } from "vitest";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";
import {
  applyAutomaticFontPageConsistency,
  buildAutomaticFontPageConsistencyPlan,
  mergeAutomaticFontPageConsistencyState,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistency";
import { applyDominantOrdinaryRecoveries } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyDominantOrdinary";
import { buildInitialEvidenceRow } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyEvidence";
import type {
  AutomaticFontPageConsistencyState,
  PageGeometryItem,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyShared";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";

describe("dominant ordinary page recovery", () => {
  it.each([
    {
      name: "holdout p8 Jua",
      anchorFontId: "ridi-batang",
      anchorCount: 5,
      baseline: glyph({
        globalForegroundDistanceMean: 1.1979751962914689,
        medianComponentDistanceMean: 1.102857138713201,
        medianComponentFill: 0.48,
        foregroundMeanLuma: 49.82235663082437,
      }),
      target: actualTarget("jua-target", {
        candidates: [
          pixelCandidate("jua", 1, 0.22676372794314528, 0.3426),
          pixelCandidate("dohyeon", 2, 0.1404900383979101),
          pixelCandidate("nanum-gothic", 3, 0.10851762201855318),
          pixelCandidate("ridi-batang", 4, 0.09979484716664025),
        ],
        morphology: glyph({
          maskWidth: 138,
          maskHeight: 295,
          foregroundPixelCount: 4767,
          connectedComponentCount: 67,
          globalForegroundDistanceMean: 1.2281398513618695,
          medianComponentDistanceMean: 1.1999999934095678,
          medianComponentFill: 0.430952380952381,
          foregroundMeanLuma: 46.82294944409482,
        }),
        bbox: { x: 721.78, y: 86, w: 122.67, h: 184 },
        candidateIds: [9, 10, 8, 18, 11, 14, 15],
      }),
    },
    {
      name: "holdout p9 Dohyeon",
      anchorFontId: "nanum-gothic",
      anchorCount: 4,
      baseline: glyph({
        globalForegroundDistanceMean: 1.6192970271205378,
        medianComponentDistanceMean: 1.576527875667576,
        medianComponentFill: 0.4767012301412684,
        foregroundMeanLuma: 53.222075142921064,
      }),
      target: actualTarget("dohyeon-target", {
        candidates: [
          pixelCandidate("dohyeon", 1, 0.31458853173943513, 0.3426),
          pixelCandidate("nanum-myeongjo", 2, 0.2657164221903773),
          pixelCandidate("ridi-batang", 3, 0.18036499348163343),
          pixelCandidate("nanum-gothic", 9, 0.01791740410675705),
        ],
        morphology: glyph({
          maskWidth: 132,
          maskHeight: 216,
          foregroundPixelCount: 4522,
          connectedComponentCount: 17,
          globalForegroundDistanceMean: 1.700324751723398,
          medianComponentDistanceMean: 1.7073449909687042,
          medianComponentFill: 0.6565656565656566,
          foregroundMeanLuma: 47.11344537815126,
        }),
        bbox: { x: 253, y: 705.73, w: 95.5, h: 112.27 },
        candidateIds: [17, 16],
      }),
    },
    {
      name: "holdout p14 Mongtori",
      anchorFontId: "ridi-batang",
      anchorCount: 5,
      baseline: glyph({
        globalForegroundDistanceMean: 1.37386793029889,
        medianComponentDistanceMean: 1.0567765541565723,
        medianComponentFill: 0.45967078189300414,
        foregroundMeanLuma: 41.00247239162683,
      }),
      target: actualTarget("mongtori-target", {
        candidates: [
          pixelCandidate("mongtori", 1, 0.6230817427436325, 0.3426),
          pixelCandidate("jua", 2, 0.1899359771487377),
          pixelCandidate("griun-pol-sensibility", 3, 0.04723215922431655),
          pixelCandidate("ridi-batang", 16, 0.0015203084525315007),
        ],
        morphology: glyph({
          maskWidth: 90,
          maskHeight: 185,
          foregroundPixelCount: 1919,
          connectedComponentCount: 21,
          globalForegroundDistanceMean: 1.3730504327046493,
          medianComponentDistanceMean: 1.3199311044481066,
          medianComponentFill: 0.48333333333333334,
          foregroundMeanLuma: 37.57269411151641,
        }),
        bbox: { x: 442.67, y: 226, w: 79.33, h: 115.25 },
        candidateIds: [10, 9],
      }),
    },
    {
      name: "holdout p29 contaminated Griun",
      anchorFontId: "ridi-batang",
      anchorCount: 4,
      baseline: glyph({
        globalForegroundDistanceMean: 1.3810000913949179,
        medianComponentDistanceMean: 1.323025399076987,
        medianComponentFill: 0.47878787878787876,
        foregroundMeanLuma: 101.33098541669727,
      }),
      target: actualTarget("contaminated-griun-target", {
        candidates: [
          pixelCandidate(
            "griun-pol-sensibility",
            1,
            0.7917234919289471,
            0.3426,
          ),
          pixelCandidate("black-and-white-picture", 2, 0.06124984831299804),
          pixelCandidate("black-han-sans", 3, 0.03909754665434191),
          pixelCandidate("ridi-batang", 20, 0.00014010321008404712),
        ],
        morphology: glyph({
          maskWidth: 213,
          maskHeight: 233,
          foregroundPixelCount: 9768,
          connectedComponentCount: 46,
          globalForegroundDistanceMean: 2.051028669539482,
          medianComponentDistanceMean: 1.2656001559659547,
          medianComponentFill: 0.5230392156862745,
          foregroundMeanLuma: 53.45546683046683,
        }),
        bbox: { x: 495.96, y: 41.67, w: 156.04, h: 121.33 },
        candidateIds: [1, 5, 6],
      }),
    },
  ])("recovers the actual-shaped $name ordinary row", (fixture) => {
    const anchors = anchorRows(
      fixture.anchorFontId,
      fixture.anchorCount,
      fixture.baseline,
    );
    const rows = [
      ...anchors.map((entry) => entry.inference),
      fixture.target.inference,
    ];
    const items = [...anchors.map((entry) => entry.item), fixture.target.item];
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);
    const state = plan.get(fixture.target.inference.blockId);

    expect(state).toMatchObject({
      mode: "page_anchor",
      anchorFontId: fixture.anchorFontId,
      anchorEvidenceCount: fixture.anchorCount,
      anchorSupportShare: 1,
      recoveredBody: true,
      ordinaryMorphologyConsensus: true,
    });
    const selected = applyAutomaticFontPageConsistency(
      fixture.target.inference.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, state),
    )[0];
    expect(selected?.fontId).toBe(fixture.anchorFontId);
    expect(selected?.reasonCodes).toContain(
      "neutral_head_page_glyph_body_consensus",
    );
  });

  it.each([
    ["a single OCR candidate", { candidateIds: [1] }],
    ["a horizontal SFX-shaped row", { direction: "horizontal" as const }],
    [
      "a strong local pixel margin",
      {
        candidates: [
          pixelCandidate("mongtori", 1, 0.72, 0.3426),
          pixelCandidate("jua", 2, 0.18),
          pixelCandidate("ridi-batang", 8, 0.02),
        ],
      },
    ],
    [
      "black-background white text",
      {
        morphology: glyph({
          connectedComponentCount: 35,
          globalForegroundDistanceMean: 1.25,
          medianComponentDistanceMean: 1.18,
          medianComponentFill: 0.48,
          foregroundPolarity: "light",
          foregroundMeanLuma: 224,
          backgroundMeanLuma: 18,
        }),
      },
    ],
  ])("preserves %s", (_name, overrides) => {
    const baseline = glyph({
      globalForegroundDistanceMean: 1.24,
      medianComponentDistanceMean: 1.16,
      medianComponentFill: 0.48,
      foregroundMeanLuma: 48,
    });
    const anchors = anchorRows("ridi-batang", 4, baseline);
    const target = actualTarget("preserved-local", {
      candidates: [
        pixelCandidate("mongtori", 1, 0.46, 0.3426),
        pixelCandidate("jua", 2, 0.24),
        pixelCandidate("ridi-batang", 8, 0.03),
      ],
      morphology: glyph({
        connectedComponentCount: 20,
        globalForegroundDistanceMean: 1.26,
        medianComponentDistanceMean: 1.2,
        medianComponentFill: 0.5,
        foregroundMeanLuma: 48,
      }),
      bbox: { x: 400, y: 100, w: 90, h: 150 },
      candidateIds: [1, 2],
      ...overrides,
    });
    const plan = buildAutomaticFontPageConsistencyPlan(
      [...anchors.map((entry) => entry.inference), target.inference],
      [...anchors.map((entry) => entry.item), target.item],
    );

    expect(plan.get(target.inference.blockId)).toMatchObject({
      mode: "local_visual_variant",
    });
  });

  it("requires at least three unambiguous body-anchor rows", () => {
    const baseline = glyph({
      globalForegroundDistanceMean: 1.3,
      medianComponentDistanceMean: 1.2,
      medianComponentFill: 0.48,
      foregroundMeanLuma: 46,
    });
    const anchors = anchorRows("ridi-batang", 2, baseline);
    const target = actualTarget("two-anchor-single-day", {
      candidates: [
        pixelCandidate("single-day", 1, 0.6088518472611562, 0.3426),
        pixelCandidate("mongtori", 2, 0.21388955977194563),
        pixelCandidate("ridi-batang", 9, 0.0022943973365254712),
      ],
      morphology: glyph({
        connectedComponentCount: 19,
        globalForegroundDistanceMean: 1.289159404016395,
        medianComponentDistanceMean: 1.2544515060655999,
        medianComponentFill: 0.5818181818181818,
        foregroundMeanLuma: 42.58585858585859,
      }),
      bbox: { x: 662, y: 53, w: 72.22, h: 103 },
      candidateIds: [2, 1],
    });
    const plan = buildAutomaticFontPageConsistencyPlan(
      [...anchors.map((entry) => entry.inference), target.inference],
      [...anchors.map((entry) => entry.item), target.item],
    );

    expect(plan.get(target.inference.blockId)).toMatchObject({
      mode: "local_visual_variant",
    });

    const unrenderableThirdAnchor = actualTarget("unrenderable-third-anchor", {
      candidates: [
        {
          ...pixelCandidate("ridi-batang", 1, 0.5, 0.3426),
          renderStatus: "unrenderable",
          unrenderableReason: "fixture-unrenderable",
        },
      ],
      morphology: baseline,
      bbox: { x: 500, y: 500, w: 90, h: 150 },
      candidateIds: [21, 22],
    });
    const anchorState: AutomaticFontPageConsistencyState = {
      mode: "page_anchor",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 2,
      anchorSupportShare: 1,
      printedFamily: "serif",
    };
    const states = new Map<string, AutomaticFontPageConsistencyState>([
      ...anchors.map(
        (entry) => [entry.inference.blockId, anchorState] as const,
      ),
      [unrenderableThirdAnchor.inference.blockId, anchorState],
      [
        target.inference.blockId,
        { mode: "local_visual_variant", anchorEvidenceCount: 0 },
      ],
    ]);
    applyDominantOrdinaryRecoveries(
      states,
      [...anchors, unrenderableThirdAnchor, target].map(({ inference, item }) =>
        buildInitialEvidenceRow(inference, item),
      ),
    );
    expect(states.get(target.inference.blockId)?.mode).toBe(
      "local_visual_variant",
    );
  });

  it("recovers holdout p17 only when its two body anchors are separated from a recognized emphasis pair", () => {
    const baseline = glyph({
      globalForegroundDistanceMean: 1.3,
      medianComponentDistanceMean: 1.2,
      medianComponentFill: 0.48,
      foregroundMeanLuma: 46,
    });
    const anchors = anchorRows("ridi-batang", 2, baseline);
    const target = actualTarget("p17-single-day", {
      candidates: [
        pixelCandidate("single-day", 1, 0.6088518472611562, 0.3426),
        pixelCandidate("mongtori", 2, 0.21388955977194563),
        pixelCandidate("ridi-batang", 9, 0.0022943973365254712),
      ],
      morphology: glyph({
        connectedComponentCount: 19,
        globalForegroundDistanceMean: 1.289159404016395,
        medianComponentDistanceMean: 1.2544515060655999,
        medianComponentFill: 0.5818181818181818,
        foregroundMeanLuma: 42.58585858585859,
      }),
      bbox: { x: 662, y: 53, w: 72.22, h: 103 },
      candidateIds: [2, 1],
    });
    const emphasis = recognizedEmphasisPair();
    const rows = [
      ...anchors.map((entry) => entry.inference),
      target.inference,
      ...emphasis.map((entry) => entry.inference),
    ];
    const items = [
      ...anchors.map((entry) => entry.item),
      target.item,
      ...emphasis.map((entry) => entry.item),
    ];
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    expect(plan.get(target.inference.blockId)).toMatchObject({
      mode: "page_anchor",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 2,
      anchorSupportShare: 1,
      recoveredBody: true,
      ordinaryMorphologyConsensus: true,
    });
    for (const entry of emphasis) {
      expect(plan.get(entry.inference.blockId)).toMatchObject({
        anchorFontId: "dohyeon",
        emphasisMorphologyConsensus: true,
        ordinaryMorphologyConsensus: false,
      });
    }
  });

  it("does not flatten a repeated true-emphasis pair", () => {
    const baseline = glyph({
      globalForegroundDistanceMean: 1.2,
      medianComponentDistanceMean: 1.12,
      medianComponentFill: 0.48,
      foregroundMeanLuma: 52,
    });
    const anchors = anchorRows("ridi-batang", 3, baseline);
    const emphasis = recognizedEmphasisPair();
    const plan = buildAutomaticFontPageConsistencyPlan(
      [
        ...anchors.map((entry) => entry.inference),
        ...emphasis.map((entry) => entry.inference),
      ],
      [
        ...anchors.map((entry) => entry.item),
        ...emphasis.map((entry) => entry.item),
      ],
    );

    for (const entry of emphasis) {
      expect(plan.get(entry.inference.blockId)).toMatchObject({
        mode: "page_anchor",
        anchorFontId: "dohyeon",
        emphasisMorphologyConsensus: true,
        ordinaryMorphologyConsensus: false,
      });
    }
  });
});

function recognizedEmphasisPair() {
  return [0, 1].map((index) =>
    actualTarget(`recognized-emphasis-${index}`, {
      candidates: [
        pixelCandidate("dohyeon", 1, 0.55, 0.3426),
        pixelCandidate("jua", 2, 0.3),
        pixelCandidate("ridi-batang", 3, 0.1),
      ],
      morphology: glyph({
        connectedComponentCount: 24,
        globalForegroundDistanceMean: 2.7 - index * 0.04,
        medianComponentDistanceMean: 2.2 - index * 0.06,
        medianComponentFill: 0.65 - index * 0.03,
        foregroundMeanLuma: 15 + index * 0.4,
      }),
      bbox: { x: 700 - index * 600, y: 80, w: 92, h: 168 },
      candidateIds: [30 + index * 2, 31 + index * 2],
      roleConfidence: 1 / 14,
    }),
  );
}

type TargetOverrides = Readonly<{
  candidates: RankedFontCandidateV2[];
  morphology: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
  >;
  bbox: PageGeometryItem["bbox"];
  candidateIds: number[];
  direction?: "horizontal" | "vertical";
  roleConfidence?: number;
}>;

function actualTarget(blockId: string, overrides: TargetOverrides) {
  return {
    inference: inference(
      blockId,
      overrides.candidates,
      overrides.morphology,
      overrides.roleConfidence,
    ),
    item: item(overrides.bbox, overrides.candidateIds, overrides.direction),
  };
}

function anchorRows(
  fontId: string,
  count: number,
  morphology: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
  >,
) {
  return Array.from({ length: count }, (_value, index) => ({
    inference: inference(
      `anchor-${fontId}-${index}`,
      [
        pixelCandidate(fontId, 1, 0.32, 0.3426),
        pixelCandidate("jua", 2, 0.28),
        pixelCandidate("mongtori", 3, 0.2),
      ],
      morphology,
    ),
    item: item({ x: 80 + index * 120, y: 500, w: 90, h: 150 }, [
      index * 2 + 1,
      index * 2 + 2,
    ]),
  }));
}

function item(
  bbox: PageGeometryItem["bbox"],
  candidateIds: number[],
  direction: "horizontal" | "vertical" = "vertical",
): PageGeometryItem {
  return { type: "nonsolid", direction, bbox, candidateIds };
}

function inference(
  blockId: string,
  candidates: RankedFontCandidateV2[],
  glyphMorphology: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
  >,
  roleConfidence = 0.99,
): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    kind: "verified_pixel_inference",
    pageId: "dominant-ordinary-fixture",
    blockId,
    modelVersion: "v7-real-shaped-fixture",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: "sfx_impact",
      confidence: roleConfidence,
      alternatives: [],
    },
    sourceStyle: {
      serifness: 0.5,
      weight: 0.5,
      width: 0.5,
      roundness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      angularity: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      energy: 0.5,
      unknownFields: [],
    },
    treatment: {
      orientation: "horizontal",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "unknown",
      colorMode: "unknown",
    },
    selectionCalibration: {
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.76,
      globalRiskLowerConfidenceBound: 0.5723549452984,
    },
    glyphMorphology,
    localEvidence: {
      rankedCandidates: candidates,
      calibratedConfidence: candidates[0]?.confidence ?? 0,
      noneAcceptable: false,
      catalogVersion: "fixture-catalog",
      modelVersion: "v7-real-shaped-fixture",
      rendererHash: "b".repeat(64),
    },
  };
}

function glyph(
  overrides: Partial<
    NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]>
  >,
): NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]> {
  return {
    contractVersion: "font-matching-glyph-morphology-v1",
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: 100,
    maskHeight: 180,
    otsuThreshold: 148,
    foregroundPolarity: "dark",
    foregroundPixelCount: 2400,
    connectedComponentCount: 20,
    globalForegroundDistanceMean: 1.25,
    medianComponentDistanceMean: 1.18,
    medianComponentFill: 0.48,
    foregroundMeanLuma: 48,
    backgroundMeanLuma: 250,
    ...overrides,
  };
}

function pixelCandidate(
  fontId: string,
  rawPixelRank: number,
  rawPixelScore: number,
  confidence = 0,
): RankedFontCandidateV2 {
  return {
    rank: rawPixelRank,
    rawPixelRank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0.8,
    roleFit: 0.8,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    rawPixelScore,
    totalScore: rawPixelScore,
    confidence,
    reasonCodes: ["v7-real-shaped-fixture"],
  };
}
