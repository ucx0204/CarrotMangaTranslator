import { describe, expect, it } from "vitest";

type DiagnosticModule = {
  buildDiagnosticAnalysis: (input: {
    labels: unknown[];
    actionableCorrections: unknown;
    baselineIndex: unknown;
    candidateIndex: unknown;
  }) => DiagnosticAnalysis;
  buildRunIndex: (
    pages: Array<{ pageNumber: number; trace: unknown }>,
    runName?: string,
  ) => unknown;
  validateLabelAuthority: (labels: unknown[], actionable: unknown) => void;
};

type DiagnosticAnalysis = {
  join: {
    labelRows: number;
    exactJoinedRows: number;
    excludedRows: number;
    exclusions: Array<Record<string, unknown>>;
  };
  confusion: Record<string, unknown>;
  events: Record<string, unknown>;
};

const diagnostic =
  require("../scripts/seal_manga_font_page_relative_role_training_only_diagnostic.cjs") as DiagnosticModule;

const authority = {
  development_only: true,
  training_only: true,
  human_gold: false,
  evaluation_eligible: false,
  automatic_release_authority: false,
};

describe("training-only page-relative role diagnostic", () => {
  it("joins exact block identities and separates correction failure modes", () => {
    const labels = [
      label("R-1", "page-a", 0, "normal"),
      label("R-2", "page-a", 1, "emphasis"),
      label("R-3", "page-a", 2, "normal"),
      label("R-4", "page-a", 3, "normal"),
      label("R-5", "page-a", 4, "emphasis"),
    ];
    const baseline = diagnostic.buildRunIndex(
      [
        pageTrace([
          pixel("page-a", 0, "emphasis_dialogue"),
          pixel("page-a", 1, "emphasis_dialogue"),
          null,
          pixel("page-a", 3, "emphasis_dialogue"),
          pixel("page-a", 4, "dialogue"),
        ]),
      ],
      "baseline",
    );
    const candidate = diagnostic.buildRunIndex(
      [
        pageTrace([
          pixel("page-a", 0, "dialogue", "applied"),
          pixel("page-a", 1, "dialogue", "applied"),
          null,
          pixel("page-a", 3, "emphasis_dialogue", "unchanged"),
          pixel("page-a", 4, "dialogue", "unchanged"),
        ]),
      ],
      "candidate",
    );

    const report = diagnostic.buildDiagnosticAnalysis({
      labels,
      actionableCorrections: { authority },
      baselineIndex: baseline,
      candidateIndex: candidate,
    });

    expect(report.join).toMatchObject({
      labelRows: 5,
      exactJoinedRows: 4,
      excludedRows: 1,
    });
    expect(report.join.exclusions[0]).toMatchObject({
      reviewId: "R-3",
      reason: "request_present_but_not_pixel_role_eligible_in_both_runs",
      baselineRequestTextRole: "sound",
      baselineRequestFontRole: "sfx_impact",
    });
    expect(report.confusion).toEqual({
      baseline: {
        normal: { dialogue: 0, emphasis_dialogue: 2 },
        emphasis: { dialogue: 1, emphasis_dialogue: 1 },
      },
      projected: {
        normal: { dialogue: 1, emphasis_dialogue: 1 },
        emphasis: { dialogue: 2, emphasis_dialogue: 0 },
      },
    });
    expect(report.events).toMatchObject({
      correctedNormals: 1,
      falseNormalizations: 1,
      missedNormals: 1,
      missedEmphasis: 1,
      changedJoinedRows: 2,
    });
  });

  it("fails closed when development-only authority is widened", () => {
    const unsafe = label("unsafe", "page-a", 0, "normal");
    unsafe.authority = { ...authority, evaluation_eligible: true };

    expect(() =>
      diagnostic.validateLabelAuthority([unsafe], { authority }),
    ).toThrow("evaluation_eligible must be false");
  });

  it("rejects duplicate sourcePageId/block joins", () => {
    expect(() =>
      diagnostic.buildRunIndex(
        [
          pageTrace([
            pixel("page-a", 0, "dialogue"),
            pixel("page-a", 0, "dialogue"),
          ]),
        ],
        "duplicate",
      ),
    ).toThrow("duplicate request key");
  });
});

function label(
  reviewId: string,
  pageId: string,
  blockIndex: number,
  intent: "normal" | "emphasis",
) {
  return {
    authority,
    identity: {
      source_page_id: pageId,
      block_index: blockIndex,
      block_id: blockId(pageId, blockIndex),
    },
    review_id: reviewId,
    source_text: reviewId,
    visual_intent: intent,
    role: intent === "normal" ? "dialogue" : "emphasis_dialogue",
    role_correction: true,
    page_consistency_intent:
      intent === "normal" ? "match_page_body" : "intentional_variant",
    selection_reason: "stable_bad_anchor",
  };
}

function pageTrace(pixels: Array<ReturnType<typeof pixel> | null>): {
  pageNumber: number;
  trace: unknown;
} {
  const requestBlocks = pixels.map((entry, index) => ({
    blockId: entry?.blockId ?? blockId("page-a", index),
    item: {
      textRole: entry ? "ordinary" : "sound",
      fontRole: entry ? "dialogue" : "sfx_impact",
      direction: "vertical",
      bbox: { x: 0, y: 0, w: 100, h: 140 },
      candidateIds: [1, 2],
    },
  }));
  return {
    pageNumber: 1,
    trace: {
      requestBlocks,
      pixelInference: pixels.filter(Boolean),
    },
  };
}

function pixel(
  pageId: string,
  blockIndex: number,
  role: "dialogue" | "emphasis_dialogue",
  status?: "applied" | "unchanged",
) {
  const alternative = role === "dialogue" ? "emphasis_dialogue" : "dialogue";
  return {
    blockId: blockId(pageId, blockIndex),
    pageId,
    rolePrediction: {
      primary: role,
      confidence: 0.7,
      alternatives: [{ role: alternative, confidence: 0.3 }],
    },
    treatment: { distortion: "none" },
    glyphMorphology: {
      globalForegroundDistanceMean: 1.3,
      medianComponentDistanceMean: 1.2,
      medianComponentFill: 0.5,
      foregroundMeanLuma: 55,
      connectedComponentCount: 20,
    },
    ...(status
      ? {
          pageRelativeRoleQa: {
            status,
            projectedRole: role,
            reasonCodes: status === "applied" ? ["fixture_projection"] : [],
          },
        }
      : {}),
  };
}

function blockId(pageId: string, blockIndex: number) {
  return `${pageId}-font-qa-fixture-chapter-block-${blockIndex + 1}`;
}
