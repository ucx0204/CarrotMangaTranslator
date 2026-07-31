import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  FontMatchRolePredictionV2,
  IntentionalTypographyOverrideV2,
  RankedFontCandidateV2,
  RoleFontPaletteV2,
  TypographyAnchorV2,
  WorkTypographyProfileV2,
} from "../src/shared/fontMatchingProfileTypes";
import {
  resolveFontMatchingDecisionV2,
  type BlockLocalFontEvidenceV2,
  type FontCandidateDecisionAuditV2,
  type FontCandidateHardRejectReasonV2,
  type FontCandidatePolicyRejectReasonV2,
  type FontCandidateRejectReasonV2,
  type FontCandidateRejectionAuditV2,
  type FontDecisionPriorityTraceV2,
  type FontMatchingDecisionCalibrationV2,
  type FontMatchingDecisionInputV2,
  type FontMatchingDecisionResultV2,
  type FontMatchingWorkStateV2,
  type TranslationFontAssessmentV2,
} from "../src/main/pipeline/fontMatchingDecisionV2";

const RENDERER_HASH = "a".repeat(64);
const CREATED_AT = "2026-08-01T00:00:00.000Z";

describe("font matching V2 decision policy", () => {
  it("exposes one coherent public decision and audit contract", () => {
    type ExportedContracts = [
      FontCandidateDecisionAuditV2,
      FontCandidateHardRejectReasonV2,
      FontCandidatePolicyRejectReasonV2,
      FontCandidateRejectReasonV2,
      FontCandidateRejectionAuditV2,
      FontDecisionPriorityTraceV2,
      FontMatchingDecisionCalibrationV2,
      FontMatchingDecisionInputV2,
      FontMatchingDecisionResultV2,
      FontMatchingWorkStateV2,
    ];
    expectTypeOf<ExportedContracts>().toMatchTypeOf<readonly unknown[]>();
  });

  it("enforces block lock > role lock > profile > automatic", () => {
    const profile = makeProfile({
      dialogueAnchor: anchor("font-b", ["font-b"]),
    });
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        blockUserLock: { fontId: "font-c", fontWeight: 800, italic: true },
        workRoleUserLock: { fontId: "font-b" },
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "font-c",
      resolvedBy: "block_user_lock",
    });
    expect(result.selectedStyle).toEqual({
      fontId: "font-c",
      fontWeight: 800,
      italic: true,
    });
    expect(result.audit.priorityTrace.map((entry) => entry.status)).toEqual([
      "selected",
      "not_reached",
      "not_reached",
      "not_reached",
      "not_reached",
    ]);
  });

  it("hard-rejects an unusable block lock and continues to the role lock", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        blockUserLock: { fontId: "font-c" },
        workRoleUserLock: { fontId: "font-b", outlineWidthScale: 1.2 },
        translationAssessments: [
          assessment("font-a"),
          assessment("font-b"),
          assessment("font-c", { glyphCoverage: 0.9, missingGlyphCount: 1 }),
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      selectedFontId: "font-b",
      resolvedBy: "work_role_user_lock",
    });
    expect(rejectionReasons(result, "font-c", "hard")).toContain(
      "glyph_coverage_incomplete",
    );
    expect(rejectionReasons(result, "font-c", "policy")).toContain(
      "lock_target_unavailable",
    );
  });

  it("never silently replaces an unavailable configured lock with automation", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        blockUserLock: { fontId: "font-c" },
        translationAssessments: [
          assessment("font-a"),
          assessment("font-b"),
          assessment("font-c", { glyphCoverage: 0.9, missingGlyphCount: 1 }),
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "unrenderable_translation",
    });
    expect(result.audit.priorityTrace[3]).toMatchObject({
      priority: "v2_automatic",
      status: "not_reached",
      reasonCodes: ["configured_user_lock_unavailable"],
    });
  });

  it("resolves persisted profile block locks before persisted role locks", () => {
    const profile = makeProfile({
      userLocks: [
        {
          id: "role-lock",
          scope: { type: "role", role: "dialogue" },
          selection: { fontId: "font-b" },
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
        {
          id: "block-lock",
          scope: {
            type: "block",
            chapterId: "chapter-1",
            pageId: "page-1",
            blockId: "block-1",
          },
          selection: { fontId: "font-c" },
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
    });
    const result = resolveFontMatchingDecisionV2(makeInput({ profile }));

    expect(result.decision).toMatchObject({
      selectedFontId: "font-c",
      resolvedBy: "block_user_lock",
    });
  });

  it("keeps a dialogue anchor through low confidence and model none", () => {
    const profile = makeProfile({
      dialogueAnchor: anchor("font-b", ["font-b"]),
    });
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        localEvidence: evidence(undefined, {
          calibratedConfidence: 0.2,
          noneAcceptable: true,
        }),
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "font-b",
      resolvedBy: "work_profile",
    });
    expect(rejectionReasons(result, "font-a", "policy")).toContain(
      "outside_anchor_set",
    );
    expect(result.audit.modelReportedNoneAcceptable).toBe(true);
  });

  it("requires the anchor replacement margin for intentional body overrides", () => {
    const profile = makeProfile({
      dialogueAnchor: anchor("font-b", ["font-b"], 0.1),
      intentionalOverrides: [blockOverride("font-a")],
    });
    const below = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        localEvidence: evidence([
          candidate("font-a", 1, 0.85),
          candidate("font-b", 2, 0.8),
          candidate("font-c", 3, 0.7),
        ]),
      }),
    );
    const above = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        localEvidence: evidence([
          candidate("font-a", 1, 0.95),
          candidate("font-b", 2, 0.8),
          candidate("font-c", 3, 0.7),
        ]),
      }),
    );

    expect(below.decision.selectedFontId).toBe("font-b");
    expect(rejectionReasons(below, "font-a", "policy")).toContain(
      "intentional_override_margin_not_met",
    );
    expect(above.decision).toMatchObject({
      selectedFontId: "font-a",
      resolvedBy: "work_profile",
    });
    expect(rejectionReasons(above, "font-a", "policy")).not.toContain(
      "outside_anchor_set",
    );
  });

  it.each([
    ["narration", "narrationAnchor", "font-b"],
    ["thought", "thoughtAnchor", "font-c"],
  ] as const)("uses the distinct %s anchor", (role, key, expected) => {
    const profile = makeProfile({ [key]: anchor(expected, [expected]) });
    const result = resolveFontMatchingDecisionV2(
      makeInput({ profile, role: rolePrediction(role) }),
    );
    expect(result.decision).toMatchObject({
      selectedFontId: expected,
      resolvedBy: "work_profile",
    });
  });

  it("restricts SFX selection to its role palette", () => {
    const profile = makeProfile({
      rolePalettes: [palette("sfx_impact", ["font-b", "font-c"], 2)],
    });
    const result = resolveFontMatchingDecisionV2(
      makeInput({ profile, role: rolePrediction("sfx_impact") }),
    );

    expect(result.decision).toMatchObject({
      selectedFontId: "font-b",
      resolvedBy: "work_profile",
    });
    expect(rejectionReasons(result, "font-a", "policy")).toContain(
      "outside_role_palette",
    );
  });

  it("reuses a visual-cluster font and enforces the palette distinct limit", () => {
    const profile = makeProfile({
      rolePalettes: [
        palette("emphasis_dialogue", ["font-a", "font-b", "font-c"], 2),
      ],
    });
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        role: rolePrediction("emphasis_dialogue"),
        workState: {
          visualClusterId: "cluster-1",
          visualClusterFontId: "font-c",
          rolePaletteUsedFontIds: ["font-b", "font-c"],
        },
      }),
    );

    expect(result.decision.selectedFontId).toBe("font-c");
    expect(rejectionReasons(result, "font-a", "policy")).toContain(
      "palette_distinct_limit_reached",
    );
  });

  it("does not let an intentional override escape a strict role palette", () => {
    const profile = makeProfile({
      rolePalettes: [palette("sfx_motion", ["font-b", "font-c"], 2)],
      intentionalOverrides: [blockOverride("font-a", "sfx_motion")],
    });
    const result = resolveFontMatchingDecisionV2(
      makeInput({ profile, role: rolePrediction("sfx_motion") }),
    );

    expect(result.decision.selectedFontId).toBe("font-b");
    expect(rejectionReasons(result, "font-a", "policy")).toContain(
      "outside_role_palette",
    );
  });

  it("does not bypass the margin with an override that has no baseline", () => {
    const profile = makeProfile({
      intentionalOverrides: [blockOverride("font-c")],
    });
    const result = resolveFontMatchingDecisionV2(makeInput({ profile }));

    expect(result.decision).toMatchObject({
      selectedFontId: "font-a",
      resolvedBy: "v2_automatic",
    });
    expect(rejectionReasons(result, "font-c", "policy")).toContain(
      "intentional_override_score_missing",
    );
  });

  it("hard-rejects render, glyph, layout, and orientation failures", () => {
    const profile = makeProfile({
      orientationPolicy: {
        horizontalAllowedFontIds: null,
        verticalAllowedFontIds: null,
        verticalOnlyFontIds: ["font-c"],
      },
    });
    const candidates = [
      candidate("font-a", 1, 1),
      candidate("font-b", 2, 0.9),
      candidate("font-c", 3, 0.8, {
        renderStatus: "unrenderable",
        unrenderableReason: "font_load_failed",
      }),
      candidate("font-d", 4, 0.7),
      candidate("font-e", 5, 0.6),
    ];
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        profile,
        localEvidence: evidence(candidates),
        translationAssessments: [
          assessment("font-a", { glyphsRenderable: false }),
          assessment("font-b", { layoutFeasible: false }),
          assessment("font-c"),
          assessment("font-d"),
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      selectedFontId: "font-d",
      resolvedBy: "v2_automatic",
    });
    expect(rejectionReasons(result, "font-a", "hard")).toContain(
      "glyph_render_failure",
    );
    expect(rejectionReasons(result, "font-b", "hard")).toContain(
      "layout_infeasible",
    );
    expect(rejectionReasons(result, "font-c", "hard")).toContain(
      "horizontal_orientation_forbidden",
    );
    expect(rejectionReasons(result, "font-c", "hard")).toContain(
      "render_unavailable",
    );
    expect(rejectionReasons(result, "font-e", "hard")).toContain(
      "translation_assessment_missing",
    );
  });

  it("abstains as unrenderable when every translation candidate fails", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        userDefaultCandidate: { fontId: "font-d" },
        translationAssessments: [
          assessment("font-a", { glyphCoverage: 0.5, missingGlyphCount: 1 }),
          assessment("font-b", { layoutFeasible: false }),
          assessment("font-c", { glyphsRenderable: false }),
          assessment("font-d", { layoutFeasible: false }),
        ],
      }),
    );

    expect(result.decision).toEqual({
      mode: "abstain",
      selectedFontId: null,
      topCandidateFontIds: [],
      noneAcceptable: false,
      abstainReason: "unrenderable_translation",
      resolvedBy: "user_default_or_top3",
    });
    expect(rejectionReasons(result, "font-d", "policy")).toContain(
      "user_default_unavailable",
    );
  });

  it("abstains on low confidence with user default followed by deterministic Top-3", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        localEvidence: evidence(undefined, { calibratedConfidence: 0.4 }),
        userDefaultCandidate: { fontId: "font-d" },
        translationAssessments: [
          assessment("font-a"),
          assessment("font-b"),
          assessment("font-c"),
          assessment("font-d"),
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "abstain",
      topCandidateFontIds: ["font-d", "font-a", "font-b"],
      abstainReason: "low_confidence",
      resolvedBy: "user_default_or_top3",
    });
    expect(result.audit.legacyTitleOrRegexFallbackUsed).toBe(false);
  });

  it("honors the independent none-acceptable head without forcing a font", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        localEvidence: evidence(undefined, { noneAcceptable: true }),
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      noneAcceptable: true,
      abstainReason: "no_acceptable_candidate",
    });
    expect(rejectionReasons(result, "font-a", "policy")).toContain(
      "model_reported_none_acceptable",
    );
  });

  it("lets a hard-gate-safe block lock override an unknown semantic role", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        role: rolePrediction("unknown_needs_review", 0.1),
        blockUserLock: { fontId: "font-b" },
      }),
    );
    const withoutLock = resolveFontMatchingDecisionV2(
      makeInput({ role: rolePrediction("unknown_needs_review", 0.1) }),
    );

    expect(result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "font-b",
      resolvedBy: "block_user_lock",
    });
    expect(withoutLock.decision).toMatchObject({
      mode: "abstain",
      abstainReason: "role_unknown",
    });
  });

  it("replaces stale layout evidence with the translation layout score", () => {
    const candidates = [
      candidate("font-a", 1, 1, { layoutFit: 0.5 }),
      candidate("font-b", 2, 0.8, { layoutFit: 0 }),
    ];
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        localEvidence: evidence(candidates),
        translationAssessments: [
          assessment("font-a", { layoutScore: -0.5 }),
          assessment("font-b", { layoutScore: 0.3 }),
        ],
      }),
    );

    expect(result.decision.selectedFontId).toBe("font-b");
    expect(evaluated(result, "font-a").effectiveScore).toBeCloseTo(0);
    expect(evaluated(result, "font-b").effectiveScore).toBeCloseTo(1.1);
  });

  it("removes unconfigured genre scores and clamps configured style bias", () => {
    const candidates = [
      candidate("font-a", 1, 1, { genrePriorContribution: 0.1 }),
      candidate("font-b", 2, 0.98),
    ];
    const profile = makeProfile({
      genrePrior: {
        source: "context_model",
        labels: [{ label: "action", probability: 0.8 }],
        styleBias: { energy: 0.4 },
        maxScoreContribution: 0.04,
      },
    });
    const withGenre = resolveFontMatchingDecisionV2(
      makeInput({ profile, localEvidence: evidence(candidates) }),
    );
    const withoutGenre = resolveFontMatchingDecisionV2(
      makeInput({ localEvidence: evidence(candidates) }),
    );

    expect(withGenre.decision.selectedFontId).toBe("font-b");
    expect(withGenre.audit.genreContributionCap).toBe(0.04);
    expect(evaluated(withGenre, "font-a")).toMatchObject({
      appliedGenreContribution: 0.04,
      genreContributionClamped: true,
    });
    expect(evaluated(withoutGenre, "font-a")).toMatchObject({
      appliedGenreContribution: 0,
      genreContributionClamped: true,
    });
  });

  it("abstains on a stale catalog instead of invoking automatic or legacy rules", () => {
    const result = resolveFontMatchingDecisionV2(
      makeInput({
        profile: makeProfile({
          catalogVersion: "old-catalog",
          genrePrior: {
            source: "manual",
            labels: [{ label: "action", probability: 1 }],
            styleBias: { energy: 1 },
            maxScoreContribution: 0.1,
          },
        }),
      }),
    );

    expect(result.decision).toMatchObject({
      mode: "abstain",
      abstainReason: "catalog_mismatch",
    });
    expect(result.audit.priorityTrace[3]).toMatchObject({
      priority: "v2_automatic",
      status: "not_reached",
    });
    expect(result.audit.legacyTitleOrRegexFallbackUsed).toBe(false);
    expect(result.audit.genreContributionCap).toBe(0);
  });

  it("never consumes a persisted lock from a different work profile", () => {
    const profile = makeProfile({
      workId: "other-work",
      userLocks: [
        {
          id: "foreign-block-lock",
          scope: {
            type: "block",
            chapterId: "chapter-1",
            pageId: "page-1",
            blockId: "block-1",
          },
          selection: { fontId: "font-c" },
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
    });
    const result = resolveFontMatchingDecisionV2(makeInput({ profile }));

    expect(result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "profile_conflict",
    });
    expect(result.audit.priorityTrace[0]).toMatchObject({
      priority: "block_user_lock",
      status: "skipped",
    });
  });

  it("is deterministic, does not mutate inputs, and rejects duplicate IDs", () => {
    const input = makeInput();
    const before = JSON.stringify(input);
    const first = resolveFontMatchingDecisionV2(input);
    const second = resolveFontMatchingDecisionV2(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(() =>
      resolveFontMatchingDecisionV2(
        makeInput({
          localEvidence: evidence([
            candidate("font-a", 1, 1),
            candidate("font-a", 2, 0.9),
          ]),
        }),
      ),
    ).toThrow("duplicate ranked candidate fontId: font-a");
  });
});

function makeInput(
  overrides: Partial<FontMatchingDecisionInputV2> = {},
): FontMatchingDecisionInputV2 {
  return {
    workId: "work-1",
    chapterId: "chapter-1",
    pageId: "page-1",
    blockId: "block-1",
    role: rolePrediction("dialogue"),
    treatment: { orientation: "horizontal" },
    localEvidence: evidence(),
    translationAssessments: [
      assessment("font-a"),
      assessment("font-b"),
      assessment("font-c"),
    ],
    profile: null,
    userDefaultCandidate: null,
    calibration: {
      minimumAutomaticConfidence: 0.7,
      minimumRoleConfidence: 0.6,
      minimumIntentionalOverrideConfidence: 0.8,
      intentionalOverrideMinimumScoreMargin: 0.1,
    },
    ...overrides,
  };
}

function evidence(
  candidates: readonly RankedFontCandidateV2[] = [
    candidate("font-a", 1, 1),
    candidate("font-b", 2, 0.8),
    candidate("font-c", 3, 0.6),
  ],
  overrides: Partial<BlockLocalFontEvidenceV2> = {},
): BlockLocalFontEvidenceV2 {
  return {
    rankedCandidates: candidates,
    calibratedConfidence: 0.95,
    noneAcceptable: false,
    catalogVersion: "catalog-v1",
    modelVersion: "model-v1",
    rendererHash: RENDERER_HASH,
    ...overrides,
  };
}

function candidate(
  fontId: string,
  rank: number,
  totalScore: number,
  overrides: Partial<RankedFontCandidateV2> = {},
): RankedFontCandidateV2 {
  return {
    rank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0.8,
    roleFit: 0.8,
    layoutFit: 0,
    glyphCoverage: 1,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore,
    confidence: 0.95,
    reasonCodes: [],
    ...overrides,
  };
}

function assessment(
  fontId: string,
  overrides: Partial<TranslationFontAssessmentV2> = {},
): TranslationFontAssessmentV2 {
  return {
    fontId,
    glyphCoverage: 1,
    glyphsRenderable: true,
    missingGlyphCount: 0,
    layoutScore: 0,
    layoutFeasible: true,
    ...overrides,
  };
}

function rolePrediction(
  primary: FontMatchRolePredictionV2["primary"],
  confidence = 0.95,
): FontMatchRolePredictionV2 {
  return { primary, confidence, alternatives: [] };
}

function makeProfile(
  overrides: Partial<WorkTypographyProfileV2> = {},
): WorkTypographyProfileV2 {
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: null,
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [],
    intentionalOverrides: [],
    userLocks: [],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: [],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: 100,
    confidence: 0.9,
    catalogVersion: "catalog-v1",
    modelVersion: "model-v1",
    rendererHash: RENDERER_HASH,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function anchor(
  primaryFontId: string,
  allowedFontIds: string[],
  minimumScoreMargin = 0.1,
): TypographyAnchorV2 {
  return {
    primaryFontId,
    allowedFontIds,
    origin: "learned",
    evidenceCount: 30,
    confidence: 0.9,
    replacementPolicy: { minimumEvidenceCount: 20, minimumScoreMargin },
    updatedAt: CREATED_AT,
  };
}

function palette(
  role: RoleFontPaletteV2["role"],
  allowedFontIds: string[],
  maxDistinctFonts: number,
): RoleFontPaletteV2 {
  return {
    role,
    allowedFontIds,
    maxDistinctFonts,
    reuseVisualClusterFont: true,
    evidenceCount: 20,
    confidence: 0.9,
  };
}

function blockOverride(
  fontId: string,
  role: IntentionalTypographyOverrideV2["role"] = "dialogue",
): IntentionalTypographyOverrideV2 {
  return {
    id: `override-${fontId}`,
    scope: {
      type: "block",
      chapterId: "chapter-1",
      pageId: "page-1",
      blockId: "block-1",
    },
    role,
    selection: { fontId },
    reasonCode: "visual_style_switch",
    origin: "adjudicated",
    confidence: 0.95,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function rejectionReasons(
  result: ReturnType<typeof resolveFontMatchingDecisionV2>,
  fontId: string,
  kind: "hard" | "policy",
): readonly string[] {
  return (
    result.audit.rejectedCandidates.find(
      (entry) => entry.fontId === fontId && entry.kind === kind,
    )?.reasonCodes ?? []
  );
}

function evaluated(
  result: ReturnType<typeof resolveFontMatchingDecisionV2>,
  fontId: string,
) {
  const entry = result.audit.evaluatedCandidates.find(
    (candidateEntry) => candidateEntry.fontId === fontId,
  );
  if (!entry) throw new Error(`missing candidate audit: ${fontId}`);
  return entry;
}
