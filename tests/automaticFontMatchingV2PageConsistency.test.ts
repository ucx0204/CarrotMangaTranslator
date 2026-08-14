/* eslint-disable max-lines -- audited page fixtures and page-policy regressions stay co-located */
import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../src/shared/fontMatchingProfileTypes";
import {
  applyAutomaticFontPageConsistency,
  buildAutomaticFontPageConsistencyPlan,
  mergeAutomaticFontPageConsistencyState,
  resolvePixelConsistencyMode,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistency";
import { buildInitialEvidenceRow } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyEvidence";
import { applyNeutralHeadOrdinaryConsensus } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyOrdinary";
import { applyRelaxedNeutralGlyphConsensus } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyRelaxed";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import {
  markRetiredAutomaticFontCandidates,
  RETIRED_AUTOMATIC_FONT_IDS,
} from "../src/main/pipeline/automaticFontMatchingRetiredFonts";

describe("pixel-only page balloon font consistency", () => {
  it("keeps the sealed Gugi row only as an unrenderable audit entry", () => {
    expect(RETIRED_AUTOMATIC_FONT_IDS).toEqual(new Set(["gugi"]));
    const ranked = markRetiredAutomaticFontCandidates([
      candidate("gugi", 1, 0.91),
      candidate("ridi-batang", 2),
    ]);

    expect(ranked[0]).toMatchObject({
      fontId: "gugi",
      renderStatus: "unrenderable",
      unrenderableReason: "font_retired_by_product_policy",
      confidence: 0,
    });
  });

  it("keeps an isolated display-font winner out of the shared body anchor", () => {
    const first = inference({
      blockId: "block-a",
      role: "dialogue",
      candidates: [
        candidate("nanum-barun-gothic", 1, 0.8),
        candidate("dohyeon", 2),
      ],
    });
    const second = inference({
      blockId: "block-b",
      role: "shout",
      roleConfidence: 0.78,
      candidates: [
        candidate("dohyeon", 1, 0.76),
        candidate("nanum-barun-gothic", 2),
      ],
    });
    const plan = buildAutomaticFontPageConsistencyPlan([first, second]);

    expect(plan.get("block-a")).toMatchObject({
      mode: "stable_body",
      anchorFontId: "nanum-barun-gothic",
      anchorEvidenceCount: 1,
    });
    expect(plan.get("block-b")).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
    });
    const state = mergeAutomaticFontPageConsistencyState(
      undefined,
      plan.get("block-b"),
    );
    const ranked = applyAutomaticFontPageConsistency(
      second.localEvidence.rankedCandidates,
      state,
    );

    expect(ranked[0]).toMatchObject({ fontId: "dohyeon", confidence: 0.76 });
    expect(ranked[0]?.reasonCodes).not.toContain(
      "page_balloon_consistency_anchor",
    );
  });

  it("does not transfer a page anchor outside the sealed raw pixel top three", () => {
    const ranked = [
      candidate("ridi-batang", 1, 0.76),
      candidate("dohyeon", 2),
      candidate("seoul-hangang", 3),
      candidate("nanum-myeongjo", 4, 0, false),
    ];
    const result = applyAutomaticFontPageConsistency(ranked, {
      pageBalloonConsistencyMode: "page_anchor",
      pageBalloonAnchorFontId: "nanum-myeongjo",
      pageBalloonAnchorEvidenceCount: 3,
      pageBalloonPrintedFamily: "serif",
    });

    expect(result[0]).toMatchObject({
      fontId: "ridi-batang",
      confidence: 0.76,
    });
    expect(result[0]?.reasonCodes).not.toContain(
      "page_balloon_consistency_anchor",
    );
    expect(result.find((entry) => entry.fontId === "dohyeon")).toMatchObject({
      confidence: 0,
    });
  });

  it("recovers a strong Dohyeon false variant to an eligible pixel body", () => {
    const row = inference({
      blockId: "thin-dohyeon-false-variant",
      role: "emphasis_dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.9, 0.82),
        pixelCandidate("ridi-batang", 2, 0.12),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.2,
        medianComponentDistanceMean: 1.1,
        medianComponentFill: 0.42,
      }),
    });

    const plan = buildAutomaticFontPageConsistencyPlan([row]);
    expect(plan.get(row.blockId)).toMatchObject({
      mode: "stable_body",
      anchorFontId: "ridi-batang",
      recoveredBody: true,
      dohyeonMorphologyVeto: true,
    });
    const result = applyAutomaticFontPageConsistency(
      row.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, plan.get(row.blockId)),
    );
    expect(result[0]).toMatchObject({
      fontId: "ridi-batang",
      confidence: 0.82,
    });
    expect(result[0]?.reasonCodes).toContain("dohyeon_glyph_morphology_veto");
  });

  it("keeps a morphologically supported strong Dohyeon variant local", () => {
    const row = inference({
      blockId: "thick-dohyeon-variant",
      role: "sfx_impact",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.9, 0.82),
        pixelCandidate("ridi-batang", 2, 0.12),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.6,
        medianComponentDistanceMean: 1.4,
        medianComponentFill: 0.72,
      }),
    });

    const plan = buildAutomaticFontPageConsistencyPlan([row]);
    expect(plan.get(row.blockId)).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
    });
    const result = applyAutomaticFontPageConsistency(
      row.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, plan.get(row.blockId)),
    );
    expect(result[0]).toMatchObject({ fontId: "dohyeon", confidence: 0.82 });
  });

  it("accepts the audited 1.70 primary component-mean boundary", () => {
    const row = inference({
      blockId: "dohyeon-component-mean-boundary",
      role: "emphasis_dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.86, 0.82),
        pixelCandidate("jua", 2, 0.04),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.55,
        medianComponentDistanceMean: 1.7,
        medianComponentFill: 0.4,
      }),
    });

    expect(
      buildAutomaticFontPageConsistencyPlan([row]).get(row.blockId),
    ).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
    });
  });

  it.each([
    ["page-10-block-4", 0.9313, 0.0225, 1.81],
    ["page-7-block-0", 0.923, 0.028, 1.61],
  ])(
    "replays audited genuine dominant Dohyeon rescue %s",
    (blockId, winnerScore, runnerScore, globalMean) => {
      const row = inference({
        blockId,
        role: "emphasis_dialogue",
        candidates: [
          pixelCandidate("dohyeon", 1, winnerScore, 0.82),
          pixelCandidate("black-han-sans", 2, runnerScore),
          pixelCandidate("gasoek-one", 3, 0.009),
        ],
        glyphMorphology: morphology({
          globalForegroundDistanceMean: globalMean,
          medianComponentDistanceMean: 1.2,
          medianComponentFill: 0.4,
        }),
      });

      expect(
        buildAutomaticFontPageConsistencyPlan([row]).get(row.blockId),
      ).toEqual({ mode: "local_visual_variant", anchorEvidenceCount: 0 });
    },
  );

  it("transfers a non-rescued ordinary Dohyeon row to its pixel runner", () => {
    const row = inference({
      blockId: "ordinary-dohyeon-false-positive",
      role: "dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.86, 0.82),
        pixelCandidate("jua", 2, 0.05),
        pixelCandidate("black-han-sans", 3, 0.02),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.6,
        medianComponentDistanceMean: 1.2,
        medianComponentFill: 0.4,
      }),
    });

    const pageState = buildAutomaticFontPageConsistencyPlan([row]).get(
      row.blockId,
    );
    expect(pageState).toMatchObject({
      mode: "local_visual_variant",
      dohyeonMorphologyVeto: true,
      dohyeonMorphologyRecoveryFontId: "jua",
      dohyeonMorphologyRecoveryRoute: "non_dohyeon_top3",
    });
    const result = applyAutomaticFontPageConsistency(
      row.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, pageState),
    );
    expect(result[0]).toMatchObject({ fontId: "jua", confidence: 0.82 });
    expect(result[0]?.reasonCodes).toEqual(
      expect.arrayContaining([
        "dohyeon_morphology_confidence_transfer",
        "non_dohyeon_pixel_top3_after_dohyeon_veto",
        "pixel_only_policy",
      ]),
    );
  });

  it("blocks a failed strong Dohyeon variant below the sealed runner floor", () => {
    const row = inference({
      blockId: "unsupported-dohyeon-without-body",
      role: "sfx_comic",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.9, 0.82),
        pixelCandidate("jua", 2, 0.019),
      ],
      glyphMorphology: null,
    });

    const plan = buildAutomaticFontPageConsistencyPlan([row]);
    expect(plan.get(row.blockId)).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
      dohyeonMorphologyVeto: true,
    });
    const result = applyAutomaticFontPageConsistency(
      row.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, plan.get(row.blockId)),
    );
    expect(result[0]).toMatchObject({ fontId: "dohyeon", confidence: 0 });
    expect(result[0]?.reasonCodes).toContain("dohyeon_glyph_morphology_veto");
  });

  it("replays page 10 block 13 through residual stable-body mass", () => {
    const row = inference({
      blockId: "page-10-block-13",
      role: "dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.5781, 0.82),
        pixelCandidate("kirang-haerang", 2, 0.0853),
        pixelCandidate("jua", 3, 0.0729),
        pixelCandidate("black-han-sans", 4, 0.0635),
        pixelCandidate("seoul-namsan", 5, 0.0609),
        pixelCandidate("nanum-barun-gothic", 6, 0.0565),
        pixelCandidate("nanum-gothic", 7, 0.0317),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.49,
        medianComponentDistanceMean: 1.15,
        medianComponentFill: 0.39,
      }),
    });

    const pageState = buildAutomaticFontPageConsistencyPlan([row]).get(
      row.blockId,
    );
    expect(pageState).toMatchObject({
      mode: "local_visual_variant",
      dohyeonMorphologyVeto: true,
      dohyeonMorphologyRecoveryFontId: "seoul-namsan",
      dohyeonMorphologyRecoveryRoute: "residual_stable_body",
    });
    const result = applyAutomaticFontPageConsistency(
      row.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, pageState),
    );
    expect(result[0]).toMatchObject({
      fontId: "seoul-namsan",
      confidence: 0.82,
      rawPixelRank: 5,
    });
    expect(result[0]?.reasonCodes).toContain(
      "residual_stable_body_after_dohyeon_veto",
    );
  });

  it("falls back to an acceptable local body face when the page anchor is unavailable", () => {
    const result = applyAutomaticFontPageConsistency(
      [
        candidate("ridi-batang", 1, 0.76),
        candidate("dohyeon", 2, 0, false),
        candidate("nanum-myeongjo", 3),
      ],
      {
        pageBalloonConsistencyMode: "page_anchor",
        pageBalloonAnchorFontId: "seoul-hangang",
        pageBalloonAnchorEvidenceCount: 3,
        pageBalloonPrintedFamily: "serif",
      },
    );

    expect(result[0]).toMatchObject({
      fontId: "ridi-batang",
      confidence: 0.76,
    });
    expect(result[0]?.reasonCodes).toContain("ordinary_balloon_body_palette");
  });

  it("keeps a calibrated display-font winner local", () => {
    const row = inference({
      blockId: "handwritten",
      role: "emphasis_dialogue",
      roleConfidence: 0.98,
      handwritten: 0.94,
      irregularity: 0.74,
      distortion: "warped",
      candidates: [pixelCandidate("dohyeon", 1, 0.86, 0.76)],
    });

    expect(resolvePixelConsistencyMode(row)).toBe("local_visual_variant");
    expect(
      buildAutomaticFontPageConsistencyPlan([row]).get(row.blockId),
    ).toEqual({ mode: "local_visual_variant", anchorEvidenceCount: 0 });
    expect(
      mergeAutomaticFontPageConsistencyState(
        {
          automaticStrategy: "body_consistency_soft",
          bodyConsistencyFontId: "ridi-batang",
          bodyConsistencyScoreBoost: 0.08,
        },
        buildAutomaticFontPageConsistencyPlan([row]).get(row.blockId),
      ),
    ).toMatchObject({
      automaticStrategy: "local_visual_first",
      pageBalloonConsistencyMode: "local_visual_variant",
    });
  });

  it("uses the calibrated winner instead of SFX role confidence", () => {
    const uncertain = inference({
      blockId: "uncertain-sfx",
      role: "sfx_comic",
      roleConfidence: 0.44,
    });
    const clear = inference({
      blockId: "clear-sfx",
      role: "sfx_comic",
      roleConfidence: 0.91,
      candidates: [pixelCandidate("jua", 1, 0.84, 0.76)],
    });

    expect(resolvePixelConsistencyMode(uncertain)).toBe("stable_body");
    expect(resolvePixelConsistencyMode(clear)).toBe("local_visual_variant");
  });

  it("uses the calibrated winner instead of heavy emphasis heads", () => {
    expect(
      resolvePixelConsistencyMode(
        inference({
          blockId: "plain-heavy-emphasis",
          role: "emphasis_dialogue",
          roleConfidence: 0.949,
          weight: 0.89,
          energy: 0.86,
          candidates: [pixelCandidate("dohyeon", 1, 0.88, 0.76)],
        }),
      ),
    ).toBe("local_visual_variant");
    expect(
      resolvePixelConsistencyMode(
        inference({
          blockId: "heavy-ordinary-dialogue",
          role: "dialogue",
          roleConfidence: 0.949,
          weight: 0.89,
          energy: 0.86,
        }),
      ),
    ).toBe("stable_body");
  });

  it("separates a calibrated shout display winner", () => {
    const row = inference({
      blockId: "clear-shout",
      role: "shout",
      roleConfidence: 0.99,
      weight: 0.87,
      energy: 0.87,
      candidates: [pixelCandidate("dohyeon", 1, 0.87, 0.76)],
    });

    expect(resolvePixelConsistencyMode(row)).toBe("local_visual_variant");
    expect(
      resolvePixelConsistencyMode(
        inference({
          blockId: "plain-shout-role-only",
          role: "shout",
          roleConfidence: 0.99,
        }),
      ),
    ).toBe("stable_body");
  });

  it("does not let handwritten or warp heads override the calibrated winner", () => {
    const falsePositive = inference({
      blockId: "plain-short-reply",
      role: "emphasis_dialogue",
      roleConfidence: 0.65,
      handwritten: 0.97,
      irregularity: 0.4,
      slant: 0.02,
      distortion: "warped",
    });
    const corroborated = inference({
      blockId: "irregular-handwritten",
      role: "emphasis_dialogue",
      roleConfidence: 0.65,
      handwritten: 0.97,
      irregularity: 0.74,
      slant: 0.02,
      distortion: "warped",
      candidates: [pixelCandidate("griun-pol-sensibility", 1, 0.84, 0.76)],
    });

    expect(resolvePixelConsistencyMode(falsePositive)).toBe("stable_body");
    expect(resolvePixelConsistencyMode(corroborated)).toBe(
      "local_visual_variant",
    );
  });

  it("treats a low-confidence plain shout as ordinary balloon text", () => {
    expect(
      resolvePixelConsistencyMode(
        inference({
          blockId: "uncertain-shout",
          role: "shout",
          roleConfidence: 0.35,
          weight: 0.79,
          energy: 0.69,
        }),
      ),
    ).toBe("stable_body");
  });

  it("preserves calibrated non-body winners with weak SFX heads", () => {
    const scream = inference({
      blockId: "scream",
      role: "sfx_impact",
      roleConfidence: 0.49,
      handwritten: 0.9,
      distortion: "warped",
      weight: 0.78,
      energy: 0.82,
      candidates: [pixelCandidate("nanum-brush-script", 1, 0.82, 0.76)],
    });
    const handwrittenShout = inference({
      blockId: "handwritten-shout",
      role: "sfx_comic",
      roleConfidence: 0.48,
      handwritten: 0.65,
      weight: 0.88,
      energy: 0.84,
      candidates: [pixelCandidate("jua", 1, 0.81, 0.76)],
    });

    expect(resolvePixelConsistencyMode(scream)).toBe("local_visual_variant");
    expect(resolvePixelConsistencyMode(handwrittenShout)).toBe(
      "local_visual_variant",
    );
  });

  it("keeps a stable body winner despite an uncertain sign head", () => {
    const row = inference({
      blockId: "misread-balloon-sign",
      role: "sign_ui_title",
      roleConfidence: 0.52,
      roleAlternatives: [
        { role: "emphasis_dialogue", confidence: 0.34 },
        { role: "shout", confidence: 0.14 },
      ],
      weight: 0.82,
      energy: 0.75,
    });

    expect(resolvePixelConsistencyMode(row)).toBe("stable_body");
  });

  it("clusters compatible pixel-score morphology and uses the sans shortlist", () => {
    const styles = [
      [0.71, 0.62, 0.58],
      [0.7, 0.62, 0.59],
      [0.48, 0.51, 0.56],
      [0.6, 0.56, 0.66],
      [0.74, 0.68, 0.56],
      [0.64, 0.58, 0.57],
    ] as const;
    const rows = styles.map(([serifness, strokeContrast, weight], index) =>
      inference({
        blockId: `gothic-${index}`,
        role: index === 3 ? "emphasis_dialogue" : "dialogue",
        serifness,
        strokeContrast,
        weight,
        candidates: [
          pixelCandidate("seoul-namsan", 1, 0.7, 0.8),
          pixelCandidate("dohyeon", 2, 0.18),
          pixelCandidate("ridi-batang", 3, 0.16),
          pixelCandidate("nanum-barun-gothic", 4, 0.12),
          pixelCandidate("nanum-gothic", 5, 0.08),
        ],
      }),
    );

    const plan = buildAutomaticFontPageConsistencyPlan(rows);
    for (const row of rows) {
      expect(plan.get(row.blockId)).toMatchObject({
        mode: "page_anchor",
        printedFamily: "sans",
        anchorFontId: "seoul-namsan",
        anchorEvidenceCount: 6,
      });
    }
  });

  it("keeps a strong Mincho-consensus cluster in the serif body shortlist", () => {
    const rows = [0, 1, 2, 3, 4].map((index) =>
      inference({
        blockId: `mincho-${index}`,
        role: "dialogue",
        serifness: index === 4 ? 0.58 : 0.74,
        strokeContrast: index === 4 ? 0.54 : 0.66,
        candidates: [
          pixelCandidate("ridi-batang", 1, 0.48, 0.8),
          pixelCandidate("nanum-myeongjo", 2, 0.25),
          pixelCandidate("nanum-barun-gothic", 3, 0.27),
        ],
      }),
    );

    const plan = buildAutomaticFontPageConsistencyPlan(rows);
    for (const row of rows) {
      expect(plan.get(row.blockId)).toMatchObject({
        mode: "page_anchor",
        printedFamily: "serif",
        anchorFontId: "ridi-batang",
      });
    }
  });

  it("keeps a stable body winner despite a confident sign head", () => {
    expect(
      resolvePixelConsistencyMode(
        inference({
          blockId: "plain-caption",
          role: "sign_ui_title",
          roleConfidence: 0.99,
          serifness: 0.18,
          strokeContrast: 0.2,
        }),
      ),
    ).toBe("stable_body");
  });

  it("uses calibrated winners when role and style heads are uniformly neutral", () => {
    const neutral = {
      role: "dialogue" as const,
      roleConfidence: 1 / 14,
      serifness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      weight: 0.5,
      energy: 0.5,
    };
    const rows = [
      inference({
        ...neutral,
        blockId: "serif-a",
        candidates: [pixelCandidate("ridi-batang", 1, 0.62, 0.34)],
      }),
      inference({
        ...neutral,
        blockId: "serif-b",
        candidates: [pixelCandidate("ridi-batang", 1, 0.58, 0.34)],
      }),
      inference({
        ...neutral,
        blockId: "sans-a",
        candidates: [pixelCandidate("nanum-gothic", 1, 0.61, 0.34)],
      }),
      inference({
        ...neutral,
        blockId: "sans-b",
        candidates: [pixelCandidate("nanum-gothic", 1, 0.57, 0.34)],
      }),
      inference({
        ...neutral,
        blockId: "display",
        candidates: [pixelCandidate("dohyeon", 1, 0.82, 0.34)],
      }),
    ];

    const plan = buildAutomaticFontPageConsistencyPlan(rows);

    expect(plan.get("serif-a")).toMatchObject({
      mode: "page_anchor",
      printedFamily: "serif",
      anchorFontId: "ridi-batang",
    });
    expect(plan.get("sans-a")).toMatchObject({
      mode: "page_anchor",
      printedFamily: "sans",
      anchorFontId: "nanum-gothic",
    });
    expect(plan.get("display")).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
    });
    expect(
      applyAutomaticFontPageConsistency(
        rows[4].localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(undefined, plan.get("display")),
      )[0],
    ).toMatchObject({ fontId: "dohyeon", confidence: 0.34 });
  });

  it("rejects a shared two-seed anchor when the aggregate winner gap is under 0.08", () => {
    const rows = ["ambiguous-a", "ambiguous-b"].map((blockId) =>
      inference({
        blockId,
        role: "dialogue",
        candidates: [
          pixelCandidate("ridi-batang", 1, 0.42, 0.8),
          pixelCandidate("nanum-myeongjo", 2, 0.38),
          pixelCandidate("dohyeon", 3, 0.2),
        ],
      }),
    );

    const plan = buildAutomaticFontPageConsistencyPlan(rows);
    expect(plan.get("ambiguous-a")).toMatchObject({
      mode: "stable_body",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 1,
    });
    expect(plan.get("ambiguous-b")).toMatchObject({
      mode: "stable_body",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 1,
    });
  });

  it("recovers a non-body top one when aggregate body mass reaches 0.60", () => {
    const row = inference({
      blockId: "body-mass-recovery",
      role: "dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.28, 0.8),
        pixelCandidate("ridi-batang", 2, 0.25),
        pixelCandidate("nanum-myeongjo", 3, 0.2),
        pixelCandidate("seoul-hangang", 4, 0.17),
        pixelCandidate("jua", 5, 0.1),
      ],
    });
    const pageState = buildAutomaticFontPageConsistencyPlan([row]).get(
      row.blockId,
    );

    expect(pageState).toMatchObject({
      mode: "stable_body",
      anchorFontId: "ridi-batang",
      printedFamily: "serif",
      recoveredBody: true,
    });
    expect(
      applyAutomaticFontPageConsistency(
        row.localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(undefined, pageState),
      ).find((candidate) => candidate.confidence > 0)?.fontId,
    ).toBe("ridi-batang");
  });

  it("keeps the audited compact corner speedline winner local", () => {
    const row = inference({
      blockId: "compact-corner-speedline",
      role: "dialogue",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.36, 0.8),
        pixelCandidate("ridi-batang", 2, 0.146),
        pixelCandidate("nanum-myeongjo", 3, 0.145),
        pixelCandidate("seoul-hangang", 4, 0.071),
        pixelCandidate("nanum-gothic", 5, 0.046),
        pixelCandidate("nanum-barun-gothic", 6, 0.06),
        pixelCandidate("seoul-namsan", 7, 0.04),
        pixelCandidate("jua", 8, 0.132),
      ],
    });

    expect(
      resolvePixelConsistencyMode(row, {
        type: "nonsolid",
        direction: "vertical",
        bbox: { x: 47.7, y: 47.9, w: 108.6, h: 108.1 },
      }),
    ).toBe("local_visual_variant");
  });

  it("replays baseline page 10: recovers ordinary fragments and preserves real variants", () => {
    const rows = PAGE_TEN_PIXEL_FIXTURE.map((entry, index) =>
      inference({
        blockId: `page-10-block-${index}`,
        role: "dialogue",
        candidates: entry.scores.map(([fontId, score], rank) =>
          pixelCandidate(fontId, rank + 1, score, rank === 0 ? 0.34 : 0),
        ),
      }),
    );
    const items = PAGE_TEN_PIXEL_FIXTURE.map((entry) => ({
      type: "nonsolid" as const,
      bbox: {
        x: entry.bbox[0],
        y: entry.bbox[1],
        w: entry.bbox[2],
        h: entry.bbox[3],
      },
      direction: entry.direction,
    }));
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    for (const index of [0, 1, 2, 3, 5, 6, 7, 8]) {
      expect(plan.get(`page-10-block-${index}`)).toMatchObject({
        mode: "page_anchor",
        anchorFontId: "ridi-batang",
        printedFamily: "serif",
      });
    }
    expect(plan.get("page-10-block-1")).toMatchObject({ recoveredBody: true });
    expect(plan.get("page-10-block-2")).toMatchObject({
      recoveredBody: true,
      geometryComponentForced: true,
    });
    expect(plan.get("page-10-block-6")).toMatchObject({ recoveredBody: true });
    for (const index of [4, 9, 10, 11, 12, 13, 14]) {
      expect(plan.get(`page-10-block-${index}`)).toEqual({
        mode: "local_visual_variant",
        anchorEvidenceCount: 0,
      });
    }

    for (const index of [1, 2, 6]) {
      const selected = applyAutomaticFontPageConsistency(
        rows[index].localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(
          undefined,
          plan.get(`page-10-block-${index}`),
        ),
      ).find((candidate) => candidate.confidence > 0);
      expect(selected?.fontId).toBe("ridi-batang");
    }
    for (const index of [4, 9, 10, 11, 12, 13, 14]) {
      const before = rows[index].localEvidence.rankedCandidates[0]?.fontId;
      const after = applyAutomaticFontPageConsistency(
        rows[index].localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(
          undefined,
          plan.get(`page-10-block-${index}`),
        ),
      ).find((candidate) => candidate.confidence > 0)?.fontId;
      expect(after).toBe(before);
    }
  });

  it("consolidates neutral-head page body crops while preserving strong visual variants", () => {
    const neutral = {
      role: "dialogue" as const,
      roleConfidence: 1 / 14,
      serifness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      weight: 0.5,
      energy: 0.5,
      roundness: 0.5,
      width: 0.5,
    };
    const bodyMorphology = {
      globalForegroundDistanceMean: 1.5,
      medianComponentDistanceMean: 1.4,
      medianComponentFill: 0.5,
      foregroundMeanLuma: 88,
      connectedComponentCount: 20,
    };
    const bodySeeds = [0, 1, 2].map((index) =>
      inference({
        ...neutral,
        blockId: `neutral-body-${index}`,
        candidates: [
          pixelCandidate("ridi-batang", 1, 0.5, 0.34),
          pixelCandidate("nanum-myeongjo", 2, 0.25),
          pixelCandidate("dohyeon", 3, 0.1),
        ],
        glyphMorphology: morphology(bodyMorphology),
      }),
    );
    const rows = [
      ...bodySeeds,
      inference({
        ...neutral,
        blockId: "neutral-cross-family-body",
        candidates: [
          pixelCandidate("nanum-gothic", 1, 0.38, 0.34),
          pixelCandidate("ridi-batang", 2, 0.34),
          pixelCandidate("seoul-namsan", 3, 0.2),
        ],
        glyphMorphology: morphology(bodyMorphology),
      }),
      inference({
        ...neutral,
        blockId: "neutral-recovered-body",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.3, 0.34),
          pixelCandidate("jua", 2, 0.2),
          pixelCandidate("nanum-gothic", 3, 0.15),
          pixelCandidate("ridi-batang", 6, 0.03),
        ],
        glyphMorphology: morphology(bodyMorphology),
      }),
      inference({
        ...neutral,
        blockId: "neutral-short-reply",
        candidates: [
          pixelCandidate("single-day", 1, 0.41, 0.34),
          pixelCandidate("mongtori", 2, 0.17),
          pixelCandidate("nanum-myeongjo", 3, 0.09),
          pixelCandidate("ridi-batang", 4, 0.08),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 9,
        }),
      }),
      inference({
        ...neutral,
        blockId: "neutral-ambiguous-long-reply",
        candidates: [
          pixelCandidate("single-day", 1, 0.36, 0.34),
          pixelCandidate("mongtori", 2, 0.35),
          pixelCandidate("gaegu", 3, 0.09),
          pixelCandidate("ridi-batang", 6, 0.01),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 17,
        }),
      }),
      inference({
        ...neutral,
        blockId: "neutral-strong-emphasis",
        candidates: [
          pixelCandidate("mongtori", 1, 0.54, 0.34),
          pixelCandidate("single-day", 2, 0.2),
          pixelCandidate("gaegu", 3, 0.06),
          pixelCandidate("ridi-batang", 4, 0.04),
        ],
        glyphMorphology: morphology(bodyMorphology),
      }),
      inference({
        ...neutral,
        blockId: "neutral-bold-outlier",
        candidates: [
          pixelCandidate("black-and-white-picture", 1, 0.3, 0.34),
          pixelCandidate("chosun-gungseo", 2, 0.16),
          pixelCandidate("mongtori", 3, 0.16),
          pixelCandidate("ridi-batang", 4, 0.09),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 5,
          globalForegroundDistanceMean: 1.98,
          medianComponentDistanceMean: 1.97,
          foregroundMeanLuma: 35,
        }),
      }),
      inference({
        ...neutral,
        blockId: "neutral-handwritten-outlier",
        candidates: [
          pixelCandidate("nanum-brush-script", 1, 0.32, 0.34),
          pixelCandidate("griun-pol-sensibility", 2, 0.24),
          pixelCandidate("chosun-gungseo", 3, 0.18),
          pixelCandidate("black-and-white-picture", 4, 0.15),
          pixelCandidate("ridi-batang", 5, 0.01),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 5,
          foregroundMeanLuma: 63,
        }),
      }),
    ];

    const plan = buildAutomaticFontPageConsistencyPlan(rows);
    for (const blockId of [
      "neutral-cross-family-body",
      "neutral-recovered-body",
      "neutral-short-reply",
      "neutral-ambiguous-long-reply",
    ]) {
      expect(plan.get(blockId)).toMatchObject({
        mode: "page_anchor",
        anchorFontId: "ridi-batang",
        ordinaryMorphologyConsensus: true,
      });
      const row = rows.find((entry) => entry.blockId === blockId);
      const selected = applyAutomaticFontPageConsistency(
        row?.localEvidence.rankedCandidates ?? [],
        mergeAutomaticFontPageConsistencyState(undefined, plan.get(blockId)),
      ).find((candidate) => candidate.confidence > 0);
      expect(selected).toMatchObject({ fontId: "ridi-batang" });
      expect(selected?.reasonCodes).toContain(
        "neutral_head_page_glyph_body_consensus",
      );
    }
    for (const blockId of [
      "neutral-strong-emphasis",
      "neutral-bold-outlier",
      "neutral-handwritten-outlier",
    ]) {
      expect(plan.get(blockId)).toMatchObject({
        mode: "local_visual_variant",
      });
    }

    const mixedRows = [
      ...bodySeeds.map((row) => buildInitialEvidenceRow(row)),
      ...Array.from({ length: 4 }, (_value, index) =>
        buildInitialEvidenceRow(
          inference({
            ...neutral,
            blockId: `mixed-sans-${index}`,
            candidates: [pixelCandidate("nanum-gothic", 1, 0.7, 0.34)],
            glyphMorphology: morphology(bodyMorphology),
          }),
        ),
      ),
    ];
    const mixedStates = new Map();
    applyNeutralHeadOrdinaryConsensus(mixedStates, mixedRows);
    expect(mixedStates.get("mixed-sans-0")).toMatchObject({
      anchorFontId: "nanum-gothic",
      anchorEvidenceCount: 4,
    });
    expect(mixedStates.get(bodySeeds[0].blockId)).toBeUndefined();

    const lowMass = buildInitialEvidenceRow(
      inference({
        ...neutral,
        blockId: "low-mass-recovered-body",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.55, 0.34),
          pixelCandidate("ridi-batang", 2, 0.2),
        ],
        glyphMorphology: morphology({ globalForegroundDistanceMean: 1.2 }),
      }),
    );
    const missingMorphology = buildInitialEvidenceRow(
      inference({
        ...neutral,
        blockId: "missing-relaxed-morphology",
        candidates: [
          pixelCandidate("jua", 1, 0.6, 0.34),
          pixelCandidate("ridi-batang", 2, 0.2),
        ],
        glyphMorphology: null,
      }),
    );
    const relaxedStates = new Map();
    applyRelaxedNeutralGlyphConsensus(relaxedStates, [lowMass]);
    applyRelaxedNeutralGlyphConsensus(relaxedStates, [
      buildInitialEvidenceRow(bodySeeds[0]),
      missingMorphology,
    ]);
    expect(relaxedStates.size).toBe(0);
  });

  it("separates compact ordinary glyphs from genuinely heavy local variants", () => {
    const neutral = {
      role: "dialogue" as const,
      roleConfidence: 1 / 14,
      serifness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      weight: 0.5,
      energy: 0.5,
      roundness: 0.5,
      width: 0.5,
    };
    const variantCandidates = [
      pixelCandidate("chosun-gungseo", 1, 0.3, 0.34),
      pixelCandidate("black-and-white-picture", 2, 0.28),
      pixelCandidate("ridi-batang", 3, 0.05),
      pixelCandidate("single-day", 4, 0.25),
    ];
    const rows = [
      inference({
        ...neutral,
        blockId: "relaxed-body-seed",
        candidates: [
          pixelCandidate("ridi-batang", 1, 0.7, 0.34),
          pixelCandidate("nanum-myeongjo", 2, 0.2),
          pixelCandidate("dohyeon", 3, 0.1),
        ],
        glyphMorphology: morphology({
          connectedComponentCount: 20,
          globalForegroundDistanceMean: 1.2,
          medianComponentDistanceMean: 1.15,
          medianComponentFill: 0.45,
          foregroundMeanLuma: 70,
        }),
      }),
      inference({
        ...neutral,
        blockId: "compact-ordinary-low-stroke",
        candidates: variantCandidates,
        glyphMorphology: morphology({
          connectedComponentCount: 5,
          globalForegroundDistanceMean: 1.2,
          medianComponentDistanceMean: 1.15,
          medianComponentFill: 0.45,
          foregroundMeanLuma: 70,
        }),
      }),
      inference({
        ...neutral,
        blockId: "compact-heavy-local",
        candidates: variantCandidates,
        glyphMorphology: morphology({
          connectedComponentCount: 14,
          globalForegroundDistanceMean: 1.44,
          medianComponentDistanceMean: 1.35,
          medianComponentFill: 0.55,
          foregroundMeanLuma: 70,
        }),
      }),
      inference({
        ...neutral,
        blockId: "single-glyph-heavy-local",
        candidates: [
          pixelCandidate("black-and-white-picture", 1, 0.62, 0.34),
          pixelCandidate("griun-pol-sensibility", 2, 0.1),
          pixelCandidate("ridi-batang", 3, 0.08),
          pixelCandidate("nanum-myeongjo", 4, 0.05),
        ],
        glyphMorphology: morphology({
          connectedComponentCount: 1,
          globalForegroundDistanceMean: 1.45,
          medianComponentDistanceMean: 1.35,
          medianComponentFill: 0.45,
          foregroundMeanLuma: 70,
        }),
      }),
    ];
    const items = [
      {
        type: "nonsolid",
        direction: "vertical" as const,
        bbox: { x: 500, y: 100, w: 100, h: 200 },
      },
      {
        type: "nonsolid",
        direction: "vertical" as const,
        bbox: { x: 300, y: 400, w: 50, h: 80 },
      },
      {
        type: "nonsolid",
        direction: "vertical" as const,
        bbox: { x: 400, y: 400, w: 50, h: 80 },
      },
      {
        type: "nonsolid",
        direction: "horizontal" as const,
        bbox: { x: 200, y: 300, w: 50, h: 40 },
      },
    ];

    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    expect(plan.get("compact-ordinary-low-stroke")).toMatchObject({
      mode: "page_anchor",
      anchorFontId: "ridi-batang",
      ordinaryMorphologyConsensus: true,
    });
    for (const blockId of ["compact-heavy-local", "single-glyph-heavy-local"]) {
      expect(plan.get(blockId)).toMatchObject({
        mode: "local_visual_variant",
      });
    }
  });

  it("uses two vetoed Mincho-shaped rows to repair one neutral model outlier", () => {
    const neutral = {
      role: "dialogue" as const,
      roleConfidence: 1 / 14,
      serifness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      weight: 0.5,
      energy: 0.5,
      roundness: 0.5,
      width: 0.5,
    };
    const bodyMorphology = {
      globalForegroundDistanceMean: 1.26,
      medianComponentDistanceMean: 1.22,
      medianComponentFill: 0.44,
      foregroundMeanLuma: 41,
    };
    const rows = [
      inference({
        ...neutral,
        blockId: "vetoed-mincho-a",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.65, 0.34),
          pixelCandidate("nanum-myeongjo", 2, 0.15),
          pixelCandidate("ridi-batang", 3, 0.1),
          pixelCandidate("jua", 4, 0.1),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 20,
        }),
      }),
      inference({
        ...neutral,
        blockId: "neutral-mincho-model-outlier",
        candidates: [
          pixelCandidate("single-day", 1, 0.7, 0.34),
          pixelCandidate("mongtori", 2, 0.2),
          pixelCandidate("nanum-myeongjo", 14, 0.001),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 12,
        }),
      }),
      inference({
        ...neutral,
        blockId: "vetoed-mincho-b",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.58, 0.34),
          pixelCandidate("nanum-myeongjo", 2, 0.19),
          pixelCandidate("ridi-batang", 3, 0.11),
          pixelCandidate("jua", 4, 0.12),
        ],
        glyphMorphology: morphology({
          ...bodyMorphology,
          connectedComponentCount: 18,
        }),
      }),
      inference({
        ...neutral,
        blockId: "real-heavy-shout",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.9, 0.34),
          pixelCandidate("jua", 2, 0.06),
          pixelCandidate("nanum-myeongjo", 3, 0.02),
        ],
        glyphMorphology: morphology({
          connectedComponentCount: 16,
          globalForegroundDistanceMean: 1.9,
          medianComponentDistanceMean: 1.8,
          medianComponentFill: 0.64,
          foregroundMeanLuma: 22,
        }),
      }),
    ];
    const items = rows.map((_row, index) => ({
      type: "nonsolid" as const,
      direction: "vertical" as const,
      bbox: {
        x: 100 + index * 180,
        y: 80,
        w: index === 3 ? 50 : 82,
        h: index === 3 ? 230 : 110,
      },
    }));
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    for (const row of rows.slice(0, 3)) {
      const state = plan.get(row.blockId);
      expect(state).toMatchObject({
        anchorFontId: "nanum-myeongjo",
        ordinaryMorphologyConsensus: true,
      });
      const selected = applyAutomaticFontPageConsistency(
        row.localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(undefined, state),
      ).find((candidate) => candidate.confidence > 0);
      expect(selected?.fontId).toBe("nanum-myeongjo");
    }
    expect(plan.get("real-heavy-shout")).toMatchObject({
      mode: "local_visual_variant",
    });
  });

  it("shares Dohyeon only inside a tightly matched heavy emphasis pair", () => {
    const neutral = {
      role: "dialogue" as const,
      roleConfidence: 1 / 14,
      serifness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      weight: 0.5,
      energy: 0.5,
      roundness: 0.5,
      width: 0.5,
    };
    const rows = [
      inference({
        ...neutral,
        blockId: "heavy-dohyeon-anchor",
        candidates: [
          pixelCandidate("dohyeon", 1, 0.55, 0.34),
          pixelCandidate("jua", 2, 0.3),
          pixelCandidate("seoul-namsan", 3, 0.1),
        ],
        glyphMorphology: morphology({
          globalForegroundDistanceMean: 2.7,
          medianComponentDistanceMean: 2.2,
          medianComponentFill: 0.65,
          foregroundMeanLuma: 15,
        }),
      }),
      inference({
        ...neutral,
        blockId: "heavy-sans-peer",
        candidates: [
          pixelCandidate("seoul-namsan", 1, 0.3, 0.34),
          pixelCandidate("kirang-haerang", 2, 0.25),
          pixelCandidate("dohyeon", 5, 0.08),
        ],
        glyphMorphology: morphology({
          globalForegroundDistanceMean: 2.64,
          medianComponentDistanceMean: 1.92,
          medianComponentFill: 0.48,
          foregroundMeanLuma: 15.4,
        }),
      }),
      inference({
        ...neutral,
        blockId: "heavy-display-impostor",
        candidates: [
          pixelCandidate("jua", 1, 0.5, 0.34),
          pixelCandidate("dohyeon", 2, 0.2),
        ],
        glyphMorphology: morphology({
          globalForegroundDistanceMean: 2.65,
          medianComponentDistanceMean: 2.1,
          medianComponentFill: 0.62,
          foregroundMeanLuma: 18,
        }),
      }),
      inference({
        ...neutral,
        blockId: "regular-body",
        candidates: [pixelCandidate("ridi-batang", 1, 0.6, 0.34)],
        glyphMorphology: morphology({
          globalForegroundDistanceMean: 1.2,
          medianComponentDistanceMean: 1.15,
          medianComponentFill: 0.5,
          foregroundMeanLuma: 50,
        }),
      }),
    ];
    const items = [
      {
        type: "nonsolid" as const,
        direction: "vertical" as const,
        bbox: { x: 700, y: 80, w: 92, h: 168 },
      },
      {
        type: "nonsolid" as const,
        direction: "vertical" as const,
        bbox: { x: 80, y: 84, w: 99, h: 167 },
      },
      {
        type: "nonsolid" as const,
        direction: "vertical" as const,
        bbox: { x: 240, y: 82, w: 94, h: 164 },
      },
      {
        type: "nonsolid" as const,
        direction: "vertical" as const,
        bbox: { x: 380, y: 660, w: 90, h: 120 },
      },
    ];
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    for (const row of rows.slice(0, 2)) {
      const state = plan.get(row.blockId);
      expect(state).toMatchObject({
        anchorFontId: "dohyeon",
        emphasisMorphologyConsensus: true,
      });
      const selected = applyAutomaticFontPageConsistency(
        row.localEvidence.rankedCandidates,
        mergeAutomaticFontPageConsistencyState(undefined, state),
      ).find((candidate) => candidate.confidence > 0);
      expect(selected?.fontId).toBe("dohyeon");
      expect(selected?.reasonCodes).toContain(
        "neutral_head_page_glyph_emphasis_consensus",
      );
    }
    for (const blockId of ["heavy-display-impostor", "regular-body"]) {
      expect(plan.get(blockId)?.emphasisMorphologyConsensus).not.toBe(true);
    }
  });
});

const PAGE_TEN_PIXEL_FIXTURE = [
  {
    bbox: [679, 57.5, 89, 138.75],
    direction: "vertical" as const,
    scores: [
      ["ridi-batang", 0.2478],
      ["dohyeon", 0.2368],
      ["nanum-barun-gothic", 0.1372],
      ["seoul-hangang", 0.1066],
      ["nanum-myeongjo", 0.0992],
      ["seoul-namsan", 0.0782],
      ["nanum-gothic", 0.0462],
      ["seoul-namsan-vertical", 0.0222],
    ] as const,
  },
  {
    bbox: [212, 61, 164, 175],
    direction: "vertical" as const,
    scores: [
      ["dohyeon", 0.4419],
      ["ridi-batang", 0.1225],
      ["nanum-barun-gothic", 0.1125],
      ["nanum-gothic", 0.084],
      ["seoul-hangang", 0.0761],
      ["seoul-namsan", 0.0489],
      ["jua", 0.0412],
      ["nanum-myeongjo", 0.0405],
    ] as const,
  },
  {
    bbox: [764, 91, 46, 115],
    direction: "vertical" as const,
    scores: [
      ["dohyeon", 0.8544],
      ["nanum-barun-gothic", 0.0353],
      ["ridi-batang", 0.0313],
      ["nanum-myeongjo", 0.0229],
      ["seoul-namsan", 0.0134],
      ["seoul-hangang", 0.0102],
      ["nanum-gothic", 0.0068],
      ["seoul-namsan-vertical", 0.0064],
    ] as const,
  },
  {
    bbox: [86, 126, 81.1111, 142],
    direction: "vertical" as const,
    scores: [
      ["seoul-hangang", 0.2023],
      ["nanum-gothic", 0.1325],
      ["ridi-batang", 0.1205],
      ["seoul-namsan", 0.1136],
      ["dohyeon", 0.1082],
      ["nanum-myeongjo", 0.0884],
      ["nanum-barun-gothic", 0.0827],
      ["kirang-haerang", 0.0596],
    ] as const,
  },
  {
    bbox: [608.8889, 333, 290.1111, 198],
    direction: "vertical" as const,
    scores: [
      ["dohyeon", 0.9313],
      ["black-han-sans", 0.0225],
      ["gasoek-one", 0.0092],
      ["jua", 0.0077],
      ["ridi-batang", 0.006],
      ["nanum-barun-gothic", 0.0056],
      ["nanum-myeongjo", 0.0044],
      ["seoul-namsan", 0.0031],
    ] as const,
  },
  {
    bbox: [774, 713.75, 94.4444, 105.25],
    direction: "vertical" as const,
    scores: [
      ["ridi-batang", 0.4246],
      ["nanum-myeongjo", 0.1938],
      ["seoul-hangang", 0.1778],
      ["nanum-gothic", 0.0697],
      ["nanum-barun-gothic", 0.0407],
      ["seoul-namsan", 0.0396],
      ["dohyeon", 0.0226],
      ["seoul-namsan-vertical", 0.0067],
    ] as const,
  },
  {
    bbox: [595.5556, 713.75, 104.4444, 110.625],
    direction: "vertical" as const,
    scores: [
      ["mongtori", 0.2634],
      ["ridi-batang", 0.1536],
      ["nanum-gothic", 0.0857],
      ["seoul-hangang", 0.0793],
      ["jua", 0.0685],
      ["nanum-myeongjo", 0.0679],
      ["dohyeon", 0.0582],
      ["cafe24-gowoonbam", 0.0566],
    ] as const,
  },
  {
    bbox: [410.6667, 777.5, 164.4444, 95.5],
    direction: "vertical" as const,
    scores: [
      ["ridi-batang", 0.3841],
      ["nanum-myeongjo", 0.2932],
      ["dohyeon", 0.1603],
      ["seoul-hangang", 0.0581],
      ["nanum-barun-gothic", 0.0429],
      ["nanum-gothic", 0.0133],
      ["chosun-gungseo", 0.0129],
      ["seoul-namsan", 0.0116],
    ] as const,
  },
  {
    bbox: [45, 823.75, 106.1111, 127.5],
    direction: "vertical" as const,
    scores: [
      ["ridi-batang", 0.3906],
      ["nanum-myeongjo", 0.2539],
      ["dohyeon", 0.2004],
      ["seoul-hangang", 0.0437],
      ["nanum-barun-gothic", 0.0352],
      ["griun-pol-sensibility", 0.0206],
      ["chosun-gungseo", 0.0124],
      ["nanum-brush-script", 0.0112],
    ] as const,
  },
  {
    bbox: [571.5556, 870, 80.4444, 109.375],
    direction: "vertical" as const,
    scores: [
      ["griun-pol-sensibility", 0.7124],
      ["nanum-brush-script", 0.1492],
      ["chosun-gungseo", 0.0657],
      ["black-and-white-picture", 0.0321],
      ["nanum-myeongjo", 0.0109],
      ["dohyeon", 0.008],
      ["single-day", 0.0077],
      ["ridi-batang", 0.0045],
    ] as const,
  },
  {
    bbox: [0, 310.625, 147.5556, 119.375],
    direction: "horizontal" as const,
    scores: [
      ["griun-pol-sensibility", 0.884],
      ["nanum-brush-script", 0.0683],
      ["black-and-white-picture", 0.0221],
      ["chosun-gungseo", 0.0211],
      ["nanum-myeongjo", 0.0018],
      ["ridi-batang", 0.0006],
      ["dohyeon", 0.0005],
      ["start-over", 0.0004],
    ] as const,
  },
  {
    bbox: [696, 610.625, 13.3333, 9.375],
    direction: "horizontal" as const,
    scores: [
      ["black-and-white-picture", 0.7056],
      ["griun-pol-sensibility", 0.1499],
      ["black-han-sans", 0.0294],
      ["single-day", 0.0283],
      ["mongtori", 0.0257],
      ["chosun-gungseo", 0.0242],
      ["gasoek-one", 0.0092],
      ["jua", 0.0076],
    ] as const,
  },
  {
    bbox: [686.2222, 610.625, 14.2222, 8.75],
    direction: "horizontal" as const,
    scores: [
      ["black-and-white-picture", 0.5014],
      ["mongtori", 0.1175],
      ["black-han-sans", 0.0933],
      ["jua", 0.0787],
      ["single-day", 0.0516],
      ["gasoek-one", 0.0507],
      ["griun-pol-sensibility", 0.0305],
      ["dohyeon", 0.0219],
    ] as const,
  },
  {
    bbox: [576, 615.625, 202, 48.375],
    direction: "horizontal" as const,
    scores: [
      ["dohyeon", 0.5781],
      ["kirang-haerang", 0.0853],
      ["jua", 0.0729],
      ["black-han-sans", 0.0635],
      ["seoul-namsan", 0.0609],
      ["nanum-barun-gothic", 0.0565],
      ["nanum-gothic", 0.0317],
      ["seoul-namsan-vertical", 0.0196],
    ] as const,
  },
  {
    bbox: [726.2222, 945.625, 123.5556, 28.75],
    direction: "horizontal" as const,
    scores: [
      ["griun-pol-sensibility", 0.5369],
      ["nanum-myeongjo", 0.1253],
      ["dohyeon", 0.1159],
      ["chosun-gungseo", 0.1076],
      ["black-han-sans", 0.0306],
      ["gasoek-one", 0.028],
      ["ridi-batang", 0.0274],
      ["black-and-white-picture", 0.0129],
    ] as const,
  },
] as const;

function inference({
  blockId,
  role,
  roleConfidence = 0.99,
  roleAlternatives = [],
  candidates = [candidate("ridi-batang", 1, 0.76)],
  handwritten = 0.05,
  irregularity = 0.1,
  slant = 0.05,
  weight = 0.58,
  energy = 0.45,
  serifness = 0.5,
  strokeContrast = 0.5,
  roundness = 0.5,
  width = 0.5,
  distortion = "none",
  glyphMorphology = morphology(),
}: {
  blockId: string;
  role: FontMatchingSemanticRole;
  roleConfidence?: number;
  roleAlternatives?: Array<{
    role: FontMatchingSemanticRole;
    confidence: number;
  }>;
  candidates?: RankedFontCandidateV2[];
  handwritten?: number;
  irregularity?: number;
  slant?: number;
  weight?: number;
  energy?: number;
  serifness?: number;
  strokeContrast?: number;
  roundness?: number;
  width?: number;
  distortion?: "none" | "warped";
  glyphMorphology?:
    | VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
    | null;
}): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    kind: "verified_pixel_inference",
    pageId: "page-1",
    blockId,
    modelVersion: "fixture-model",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: role,
      confidence: roleConfidence,
      alternatives: roleAlternatives,
    },
    sourceStyle: {
      serifness,
      weight,
      width,
      roundness,
      strokeContrast,
      handwritten,
      angularity: 0.5,
      irregularity,
      slant,
      energy,
      unknownFields: [],
    },
    treatment: {
      orientation: "vertical",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion,
      polarity: "normal",
      colorMode: "monochrome",
    },
    selectionCalibration: {
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.9,
      globalRiskLowerConfidenceBound: 0.76,
    },
    ...(glyphMorphology ? { glyphMorphology } : {}),
    localEvidence: {
      rankedCandidates: candidates,
      calibratedConfidence: candidates[0]?.confidence ?? 0,
      noneAcceptable: false,
      catalogVersion: "fixture-catalog",
      modelVersion: "fixture-model",
      rendererHash: "b".repeat(64),
    },
  };
}

function morphology(
  overrides: Partial<
    NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]>
  > = {},
): NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]> {
  return {
    contractVersion: "font-matching-glyph-morphology-v1",
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: 80,
    maskHeight: 40,
    otsuThreshold: 120,
    foregroundPolarity: "dark",
    foregroundPixelCount: 320,
    connectedComponentCount: 4,
    globalForegroundDistanceMean: 1.8,
    medianComponentDistanceMean: 1.8,
    medianComponentFill: 0.62,
    foregroundMeanLuma: 30,
    backgroundMeanLuma: 235,
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
    ...candidate(fontId, rawPixelRank, confidence),
    rawPixelRank,
    rawPixelScore,
    totalScore: rawPixelScore,
  };
}

function candidate(
  fontId: string,
  rank: number,
  confidence = 0,
  supervisedAcceptable = true,
): RankedFontCandidateV2 {
  return {
    rank,
    rawPixelRank: rank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0.8,
    roleFit: 0.9,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    rawPixelScore: rank === 1 ? 0.9 : 0.5,
    totalScore: rank === 1 ? 0.9 : 0.5,
    confidence,
    reasonCodes: [
      "fixture",
      ...(supervisedAcceptable ? ["supervised_top3_acceptability_rerank"] : []),
    ],
  };
}
