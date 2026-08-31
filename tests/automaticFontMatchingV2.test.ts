import { describe, expect, it } from "vitest";
import {
  resolveFontMatchingV2CatalogVersion,
  resolveAutomaticFontDecisionV2,
} from "../src/main/pipeline/automaticFontMatchingV2";
import {
  createAutomaticFontPageCoordinatorV2,
  orderAutomaticFontMatchingPageItemIndexes,
} from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import { applyAutomaticFontChapterBodyPrior } from "../src/main/pipeline/automaticFontMatchingV2ChapterPrior";
import { resolveCombinedAutomaticFontRole } from "../src/main/pipeline/automaticFontMatchingV2Role";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import type { FontMatchingSourceStyleV2 } from "../src/shared/fontMatchingProfileTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
import {
  builtIn,
  makeBlock,
  makeCoordinatorResult,
  makeItem,
  makePage,
  makePixelInference,
  makePixelRoleInference,
  makePixelWinnerInference,
  makeProfile,
  makeRankedCandidate,
  makeReadyRuntimeStatus,
  makeSourceStyle,
} from "./helpers/automaticFontMatchingV2Fixtures";

describe("automatic font matching V2 adapter", () => {
  it("uses verified pixel role evidence unchanged when the LLM role conflicts", () => {
    const pixelRole = {
      primary: "dialogue" as const,
      confidence: 0.61,
      alternatives: [
        { role: "narration" as const, confidence: 0.27 },
        { role: "thought" as const, confidence: 0.12 },
      ],
    };

    const resolved = resolveCombinedAutomaticFontRole(
      makeItem("sfx_impact", 1),
      pixelRole,
    );

    expect(resolved).toBe(pixelRole);
    expect(resolved).toEqual(pixelRole);
  });

  it("does not use an LLM role when verified pixel role evidence is absent", () => {
    const resolved = resolveCombinedAutomaticFontRole(
      makeItem("sfx_impact", 1),
      null,
    );

    expect(resolved).toEqual({
      primary: "unknown_needs_review",
      confidence: 0,
      alternatives: [],
    });
  });

  it("fails closed without pixel evidence even when the LLM supplies a role", () => {
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock({ autoFitText: false }),
      item: makeItem("sfx_impact", 0.98),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [builtIn("dohyeon")],
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "role_unknown",
    });
    expect(decision?.result.decision.topCandidateFontIds).toContain("dohyeon");
  });

  it("abstains from a profile when the semantic role is weak", () => {
    const candidates = [builtIn("ridi-batang"), builtIn("jua")];
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock({ fontFamily: "jua" }),
      item: makeItem("dialogue", 0.35),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        profile: makeProfile({
          catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
        }),
        candidates,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "role_unknown",
    });
  });

  it("does not apply a well-evidenced profile without verified pixel inference", () => {
    const candidates = [builtIn("ridi-batang"), builtIn("jua")];
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock({ fontFamily: "jua" }),
      item: makeItem("dialogue", 0.95),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        profile: makeProfile({
          catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
        }),
        candidates,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "role_unknown",
    });
  });

  it("abstains rather than applying a stale work profile", () => {
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock({ fontFamily: "jua" }),
      item: makeItem("dialogue", 0.95),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        profile: {
          ...makeProfile(),
          catalogVersion: "stale-catalog",
        },
        candidates: [builtIn("ridi-batang"), builtIn("jua")],
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "role_unknown",
    });
  });

  it("does not auto-apply an unverified custom font", () => {
    const custom = makeAutomaticFontCandidate({
      fontId: "custom-brush",
      defaultFont: true,
    });
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock({ fontFamily: "jua" }),
      item: makeItem("sfx_motion", 1),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [custom],
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "role_unknown",
    });
  });

  it("loads a persisted block lock instead of suppressing it with null", () => {
    const candidates = [builtIn("ridi-batang"), builtIn("jua")];
    const now = "2026-08-01T00:00:00.000Z";
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock(),
      item: makeItem("dialogue", 0.95),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        candidates,
        profile: makeProfile({
          catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
          userLocks: [
            {
              id: "block-lock",
              scope: {
                type: "block",
                chapterId: "chapter-1",
                pageId: "page-1",
                blockId: "block-1",
              },
              selection: { fontId: "jua" },
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "jua",
      resolvedBy: "block_user_lock",
    });
  });

  it("does not reinterpret an existing block font as a user lock", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const block = makeBlock({ fontFamily: "ridi-batang" });
    const page = makePage();
    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.95),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        candidates,
        pixelInference: makePixelInference({
          blockId: block.id,
          catalogVersion,
          pageId: page.id,
          scores: [0.7, 0.96],
          sourceStyle: makeSourceStyle(),
        }),
        runtimeArtifactStatus: makeReadyRuntimeStatus(
          candidates,
          catalogVersion,
        ),
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "dohyeon",
      resolvedBy: "v2_automatic",
    });
  });

  it("derives profile compatibility from the actual candidate manifest", () => {
    const regular = builtIn("jua");
    const bold = makeAutomaticFontCandidate({
      ...regular,
      fontId: "jua",
      weight: 700,
    });

    expect(resolveFontMatchingV2CatalogVersion([regular])).not.toBe(
      resolveFontMatchingV2CatalogVersion([bold]),
    );
    expect(
      resolveFontMatchingV2CatalogVersion([
        regular,
        makeAutomaticFontCandidate({ fontId: "custom-a" }),
      ]),
    ).toBe(
      resolveFontMatchingV2CatalogVersion([
        regular,
        makeAutomaticFontCandidate({ fontId: "custom-b" }),
      ]),
    );
  });

  it("honors the supervised operating point instead of reapplying the legacy confidence gate", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const ready = makeReadyRuntimeStatus(candidates, catalogVersion);
    if (ready.state !== "ready") throw new Error("expected ready fixture");
    const status = {
      ...ready,
      policy: {
        ...ready.policy,
        automaticMutation: {
          ...ready.policy.automaticMutation,
          minimumAutomaticConfidence: 0.98,
        },
      },
    } as const;
    const block = makeBlock();
    const page = makePage();
    const pixelInference = makePixelInference({
      blockId: block.id,
      catalogVersion,
      pageId: page.id,
      scores: [0.94, 0.72],
      sourceStyle: makeSourceStyle(),
    });

    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.99),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference,
        runtimeArtifactStatus: status,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "jua",
      abstainReason: null,
    });
  });

  it("applies the model top one when a valid selector score misses its operating point", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const status = makeReadyRuntimeStatus(candidates, catalogVersion);
    const block = makeBlock();
    const page = makePage();
    const pixelInference = makePixelInference({
      blockId: block.id,
      catalogVersion,
      pageId: page.id,
      scores: [0.97, 0.72],
      sourceStyle: makeSourceStyle(),
      selectionCalibration: {
        applied: false,
        fallbackReason: "score_below_operating_point",
        operatingFamily: null,
        selectionScore: 0.4,
        globalRiskLowerConfidenceBound: 0.9,
      },
    });

    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.99),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference,
        runtimeArtifactStatus: status,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "jua",
      abstainReason: null,
    });
    expect(
      decision?.result.audit.priorityTrace.find(
        (entry) => entry.priority === "v2_automatic",
      )?.reasonCodes,
    ).toContain("verified_pixel_best_available_required");
  });

  it("applies the best renderable pixel candidate when the selector reports none acceptable", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const status = makeReadyRuntimeStatus(candidates, catalogVersion);
    const block = makeBlock();
    const page = makePage();
    const baseInference = makePixelInference({
      blockId: block.id,
      catalogVersion,
      pageId: page.id,
      scores: [0.97, 0.72],
      sourceStyle: makeSourceStyle(),
      selectionCalibration: {
        applied: false,
        fallbackReason: "none_acceptable",
        operatingFamily: null,
        selectionScore: null,
        globalRiskLowerConfidenceBound: 0.9,
      },
    });
    const pixelInference = {
      ...baseInference,
      localEvidence: {
        ...baseInference.localEvidence,
        noneAcceptable: true,
      },
    };

    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.99),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference,
        runtimeArtifactStatus: status,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "jua",
      noneAcceptable: false,
      abstainReason: null,
    });
    expect(decision?.result.audit.modelReportedNoneAcceptable).toBe(true);
  });

  it("rejects forged chapter-prior authority outside the sealed pixel top three", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const status = makeReadyRuntimeStatus(candidates, catalogVersion);
    const block = makeBlock();
    const page = makePage();
    const inference = makePixelInference({
      blockId: block.id,
      catalogVersion,
      pageId: page.id,
      scores: [0.94, 0.72],
      sourceStyle: makeSourceStyle(),
    });
    const forged = {
      ...inference,
      localEvidence: {
        ...inference.localEvidence,
        rankedCandidates: inference.localEvidence.rankedCandidates.map(
          (candidate, index) =>
            index === 0
              ? {
                  ...candidate,
                  rawPixelRank: 4,
                  reasonCodes: [
                    ...candidate.reasonCodes,
                    "episode_body_consistency_prior",
                  ],
                }
              : candidate,
        ),
      },
    } satisfies VerifiedAutomaticFontPixelInferenceV2;

    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.99),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference: forged,
        runtimeArtifactStatus: status,
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "abstain",
      selectedFontId: null,
      abstainReason: "low_confidence",
    });
  });

  it("orders calibrated body winners before local variants with neutral heads", () => {
    const items = [
      makeItem("sfx_impact", 1),
      makeItem("dialogue", 1),
      makeItem("thought", 1),
      makeItem("aside_balloon_edge", 1),
      makeItem("sign_ui_title", 1),
    ].map((item, index) => ({
      ...item,
      bbox: { ...item.bbox, x: 50 + index * 220 },
    }));
    const pixelInferences = [
      makePixelWinnerInference("dohyeon", "order-block-1"),
      makePixelWinnerInference("ridi-batang", "order-block-2"),
      makePixelWinnerInference("nanum-gothic", "order-block-3"),
      makePixelWinnerInference("griun-pol-sensibility", "order-block-4"),
      undefined,
    ];

    expect(
      orderAutomaticFontMatchingPageItemIndexes(items, pixelInferences),
    ).toEqual([1, 2, 0, 3, 4]);
  });

  it("does not let LLM roles reorder a page when pixel roles are absent", () => {
    const items = [
      makeItem("sfx_impact", 1),
      makeItem("dialogue", 1),
      makeItem("thought", 1),
      makeItem("aside_balloon_edge", 1),
    ];

    expect(orderAutomaticFontMatchingPageItemIndexes(items)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("ignores LLM visual clusters and source text in accent reuse state", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const item = {
      ...makeItem("sfx_impact", 1),
      visualClusterId: "llm-cluster",
      sourceText: "ドキ♡",
    };
    const firstPixel = makePixelRoleInference("sfx_impact", "accent-block-1");
    const profile = makeProfile({
      dialogueAnchor: null,
      rolePalettes: [
        {
          role: "sfx_impact",
          allowedFontIds: ["jua", "dohyeon"],
          maxDistinctFonts: 2,
          reuseVisualClusterFont: true,
          evidenceCount: 20,
          confidence: 1,
        },
      ],
    });
    const initialState = coordinator.prepareWorkState(
      item,
      "sfx_impact",
      firstPixel,
    );
    expect(initialState).toMatchObject({
      automaticStrategy: "local_visual_first",
    });
    expect(initialState).not.toHaveProperty("visualClusterId");
    expect(initialState).not.toHaveProperty("visualClusterFontId");
    coordinator.recordDecision(
      "sfx_impact",
      initialState,
      makeCoordinatorResult("jua"),
      profile,
      firstPixel,
    );
    const repeatedState = coordinator.prepareWorkState(
      { ...item, sourceText: "ドキ" },
      "sfx_impact",
      makePixelRoleInference("sfx_impact", "accent-block-2"),
    );

    expect(repeatedState).toMatchObject({
      automaticStrategy: "local_visual_first",
      rolePaletteUsedFontIds: ["jua"],
    });
    expect(repeatedState).not.toHaveProperty("visualClusterId");
    expect(repeatedState).not.toHaveProperty("visualClusterFontId");
  });

  it("snapshots and hydrates verified chapter font continuity", () => {
    const profile = makeProfile({
      dialogueAnchor: null,
      rolePalettes: [
        {
          role: "sfx_impact",
          allowedFontIds: ["dohyeon", "jua"],
          maxDistinctFonts: 2,
          reuseVisualClusterFont: true,
          evidenceCount: 20,
          confidence: 1,
        },
      ],
    });
    const source = createAutomaticFontPageCoordinatorV2();
    const inference = makePixelRoleInference(
      "sfx_impact",
      "continuity-accent-block",
    );
    source.recordDecision(
      "sfx_impact",
      undefined,
      makeCoordinatorResult("dohyeon"),
      profile,
      inference,
    );
    source.recordDecision(
      "sfx_impact",
      undefined,
      makeCoordinatorResult("dohyeon"),
      profile,
      inference,
    );

    const accent = source.snapshotPageContinuity?.("pixel-only-order-page");
    expect(accent).toHaveLength(1);
    expect(accent?.[0]).toMatchObject({
      pageId: "pixel-only-order-page",
      blockId: "continuity-accent-block",
      role: "sfx_impact",
      selectedFontId: "dohyeon",
      confidence: 0.97,
    });
    expect(source.snapshotPageContinuity?.("another-page")).toEqual([]);

    const restored = createAutomaticFontPageCoordinatorV2();
    restored.hydrateContinuity?.([
      ...(accent ?? []),
      {
        ...accent?.[0],
        pageId: "body-page",
        blockId: "body-block",
        role: "dialogue",
        selectedFontId: "jua",
      } as NonNullable<typeof accent>[number],
    ]);

    expect(restored.snapshotPageContinuity?.("body-page")).toEqual([
      expect.objectContaining({
        pageId: "body-page",
        blockId: "body-block",
        role: "dialogue",
        selectedFontId: "jua",
      }),
    ]);
    expect(
      restored.prepareWorkState(
        makeItem("sfx_impact", 1),
        "sfx_impact",
        undefined,
      ),
    ).toEqual({ rolePaletteUsedFontIds: ["dohyeon"] });
  });

  it("does not persist weak or mismatched accent continuity evidence", () => {
    const profile = makeProfile({
      dialogueAnchor: null,
      rolePalettes: [
        {
          role: "sfx_impact",
          allowedFontIds: ["dohyeon", "jua"],
          maxDistinctFonts: 2,
          reuseVisualClusterFont: true,
          evidenceCount: 20,
          confidence: 1,
        },
      ],
    });
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const base = makePixelRoleInference("sfx_impact", "weak-accent-base");
    const result = makeCoordinatorResult("dohyeon");
    const withoutRenderedCandidates = {
      ...base,
      blockId: "weak-accent-unrenderable",
      localEvidence: {
        ...base.localEvidence,
        rankedCandidates: base.localEvidence.rankedCandidates.map(
          (candidate) => ({
            ...candidate,
            renderStatus: "unrenderable" as const,
            unrenderableReason: "test fixture",
          }),
        ),
      },
    };
    const lowConfidence = {
      ...base,
      blockId: "weak-accent-confidence",
      localEvidence: {
        ...base.localEvidence,
        calibratedConfidence: 0.2,
      },
    };
    const noneAcceptable = {
      ...base,
      blockId: "weak-accent-none",
      localEvidence: { ...base.localEvidence, noneAcceptable: true },
    };
    const runtimeStatus = makeReadyRuntimeStatus(
      [builtIn("dohyeon"), builtIn("jua")],
      base.localEvidence.catalogVersion,
    );
    if (runtimeStatus.state !== "ready") {
      throw new Error("expected ready fixture");
    }

    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      result,
      profile,
      undefined,
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      result,
      profile,
      noneAcceptable,
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      result,
      profile,
      withoutRenderedCandidates,
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      makeCoordinatorResult("jua"),
      profile,
      { ...base, blockId: "weak-accent-mismatch" },
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      result,
      profile,
      lowConfidence,
      runtimeStatus.policy,
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      {
        ...result,
        audit: { ...result.audit, roleConfidence: 0.2 },
      },
      profile,
      { ...base, blockId: "weak-accent-role" },
    );
    coordinator.recordDecision(
      "sfx_impact",
      undefined,
      makeCoordinatorResult("dohyeon", [], "work_role_user_lock"),
      profile,
      { ...base, blockId: "weak-accent-locked" },
    );

    expect(
      coordinator.snapshotPageContinuity?.("pixel-only-order-page"),
    ).toEqual([]);
  });

  it("keeps continuity hooks optional for custom chapter coordinators", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2({
      chapterCoordinator: {
        prepareWorkState: () => undefined,
        recordDecision: () => undefined,
      },
    });

    expect(() => coordinator.hydrateContinuity?.([])).not.toThrow();
    expect(coordinator.snapshotPageContinuity?.("page-1")).toEqual([]);
  });

  it("uses an AI-selected same-chapter body anchor without mistaking emphasis for a family change", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const status = makeReadyRuntimeStatus(candidates, catalogVersion);
    const regularStyle = makeSourceStyle();

    for (const index of [1, 2]) {
      const page = { ...makePage(), id: `page-${index}` };
      const block = makeBlock({ id: `block-${index}` });
      const pixelInference = makePixelInference({
        blockId: block.id,
        catalogVersion,
        pageId: page.id,
        sourceStyle: regularStyle,
        scores: [0.94, 0.72],
      });
      const decision = resolveAutomaticFontDecisionV2({
        block,
        item: makeItem("dialogue", 0.99),
        page,
        options: {
          enabled: true,
          targetLanguage: "ko",
          candidates,
          pageCoordinator: coordinator,
          pixelInference,
          runtimeArtifactStatus: status,
        },
      });
      expect(decision?.result.decision.selectedFontId).toBe("jua");
    }

    const thirdPage = { ...makePage(), id: "page-3" };
    const thirdBlock = makeBlock({ id: "block-3" });
    const closeLocalAlternative = makePixelInference({
      blockId: thirdBlock.id,
      catalogVersion,
      pageId: thirdPage.id,
      sourceStyle: regularStyle,
      scores: [0.89, 0.91],
    });
    expect(
      closeLocalAlternative.localEvidence.rankedCandidates.map(
        (candidate) => candidate.confidence,
      ),
    ).toEqual([0.97, 0]);
    const consistent = resolveAutomaticFontDecisionV2({
      block: thirdBlock,
      item: makeItem("dialogue", 0.99),
      page: thirdPage,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pageCoordinator: coordinator,
        pixelInference: closeLocalAlternative,
        runtimeArtifactStatus: status,
      },
    });
    expect(consistent?.result.decision.selectedFontId).toBe("jua");
    expect(
      consistent?.result.audit.priorityTrace.find(
        (entry) => entry.priority === "v2_automatic",
      )?.reasonCodes,
    ).toContain("episode_body_consistency_prior");

    const emphasizedSameFamily = makePixelInference({
      blockId: "block-5",
      catalogVersion,
      pageId: "page-5",
      sourceStyle: makeSourceStyle({ weight: 0.94, energy: 0.96 }),
      scores: [0.89, 0.91],
    });
    expect(
      coordinator.prepareWorkState(
        makeItem("dialogue", 0.99),
        "dialogue",
        emphasizedSameFamily,
      ),
    ).toMatchObject({
      automaticStrategy: "body_consistency_soft",
      bodyConsistencyFontId: "jua",
    });

    const strongLocalAlternative = makePixelInference({
      blockId: "block-4",
      catalogVersion,
      pageId: "page-4",
      sourceStyle: regularStyle,
      scores: [0.68, 0.94],
    });
    const localWins = resolveAutomaticFontDecisionV2({
      block: makeBlock({ id: "block-4" }),
      item: makeItem("dialogue", 0.99),
      page: { ...makePage(), id: "page-4" },
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pageCoordinator: coordinator,
        pixelInference: strongLocalAlternative,
        runtimeArtifactStatus: status,
      },
    });
    expect(localWins?.result.decision.selectedFontId).toBe("jua");

    const differentSourceStyle = makePixelInference({
      blockId: "block-6",
      catalogVersion,
      pageId: "page-6",
      sourceStyle: makeSourceStyle({ serifness: 0.92 }),
      scores: [0.74, 0.93],
    });
    expect(
      coordinator.prepareWorkState(
        makeItem("dialogue", 0.99),
        "dialogue",
        differentSourceStyle,
      )?.bodyConsistencyFontId,
    ).toBeUndefined();

    const handwritten = makePixelInference({
      blockId: "block-7",
      catalogVersion,
      pageId: "page-7",
      sourceStyle: makeSourceStyle({ handwritten: 0.91, irregularity: 0.8 }),
      scores: [0.9, 0.88],
    });
    expect(
      coordinator.prepareWorkState(
        makeItem("dialogue", 0.99),
        "dialogue",
        handwritten,
      ),
    ).toEqual({ automaticStrategy: "local_visual_first" });
    expect(
      coordinator.prepareWorkState(
        makeItem("sfx_impact", 0.99),
        "sfx_impact",
        closeLocalAlternative,
      )?.automaticStrategy,
    ).toBe("local_visual_first");
  });

  it("never lets a chapter prior resurrect a candidate outside the pixel top three", () => {
    const ranked = [
      {
        ...makeRankedCandidate("local-top", 0.9, 1),
        rawPixelRank: 1,
        confidence: 0.9,
      },
      { ...makeRankedCandidate("local-2", 0.88, 2), rawPixelRank: 2 },
      { ...makeRankedCandidate("local-3", 0.87, 3), rawPixelRank: 3 },
      { ...makeRankedCandidate("chapter-font", 0.85, 4), rawPixelRank: 4 },
    ];

    const adjusted = applyAutomaticFontChapterBodyPrior(ranked, {
      automaticStrategy: "body_consistency_soft",
      bodyConsistencyFontId: "chapter-font",
      bodyConsistencyScoreBoost: 0.06,
    });

    expect(adjusted[0]?.fontId).toBe("local-top");
    expect(
      adjusted.find((candidate) => candidate.fontId === "chapter-font")
        ?.reasonCodes,
    ).not.toContain("episode_body_consistency_prior");
  });

  it("does not treat a small local score difference as a chapter font change", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const ready = makeReadyRuntimeStatus(candidates, catalogVersion);
    if (ready.state !== "ready") throw new Error("expected ready fixture");
    const status = {
      ...ready,
      policy: {
        ...ready.policy,
        chapterPrior: {
          ...ready.policy.chapterPrior,
          localOverrideMinimumScoreMargin: 0.01,
        },
      },
    } as const;
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const sourceStyle = makeSourceStyle();

    for (const index of [1, 2]) {
      const page = { ...makePage(), id: `policy-page-${index}` };
      const block = makeBlock({ id: `policy-block-${index}` });
      resolveAutomaticFontDecisionV2({
        block,
        item: makeItem("dialogue", 0.99),
        page,
        options: {
          enabled: true,
          targetLanguage: "ko",
          candidates,
          pageCoordinator: coordinator,
          pixelInference: makePixelInference({
            blockId: block.id,
            catalogVersion,
            pageId: page.id,
            scores: [0.94, 0.72],
            sourceStyle,
          }),
          runtimeArtifactStatus: status,
        },
      });
    }

    const page = { ...makePage(), id: "policy-page-3" };
    const block = makeBlock({ id: "policy-block-3" });
    const decision = resolveAutomaticFontDecisionV2({
      block,
      item: makeItem("dialogue", 0.99),
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pageCoordinator: coordinator,
        pixelInference: makePixelInference({
          blockId: block.id,
          catalogVersion,
          pageId: page.id,
          scores: [0.89, 0.91],
          sourceStyle,
        }),
        runtimeArtifactStatus: status,
      },
    });

    expect(decision?.result.decision.selectedFontId).toBe("jua");
    expect(
      decision?.result.audit.priorityTrace.find(
        (entry) => entry.priority === "v2_automatic",
      )?.reasonCodes,
    ).toContain("episode_body_consistency_prior");
  });

  it("honors the verified chapter anchor minimum and score cap", () => {
    const candidates = [builtIn("jua"), builtIn("dohyeon")];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const ready = makeReadyRuntimeStatus(candidates, catalogVersion);
    if (ready.state !== "ready") throw new Error("expected ready fixture");
    const status = {
      ...ready,
      policy: {
        ...ready.policy,
        chapterPrior: {
          ...ready.policy.chapterPrior,
          maximumScoreContribution: 0.01,
          minimumAnchorEvidenceCount: 3,
        },
      },
    } as const;
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const sourceStyle = makeSourceStyle();

    for (const index of [1, 2]) {
      resolveBodyAnchor({
        candidates,
        catalogVersion,
        coordinator,
        index,
        sourceStyle,
        status,
      });
    }
    const probe = makePixelInference({
      blockId: "cap-probe-block",
      catalogVersion,
      pageId: "cap-probe-page",
      scores: [0.89, 0.91],
      sourceStyle,
    });
    expect(
      coordinator.prepareWorkState(
        makeItem("dialogue", 0.99),
        "dialogue",
        probe,
        status.policy,
      )?.bodyConsistencyFontId,
    ).toBeUndefined();

    resolveBodyAnchor({
      candidates,
      catalogVersion,
      coordinator,
      index: 3,
      sourceStyle,
      status,
    });
    expect(
      coordinator.prepareWorkState(
        makeItem("dialogue", 0.99),
        "dialogue",
        probe,
        status.policy,
      ),
    ).toMatchObject({
      bodyConsistencyFontId: "jua",
      bodyConsistencyScoreBoost: 0.01,
    });
  });
});

function resolveBodyAnchor({
  candidates,
  catalogVersion,
  coordinator,
  index,
  sourceStyle,
  status,
}: {
  candidates: ReturnType<typeof builtIn>[];
  catalogVersion: string;
  coordinator: ReturnType<typeof createAutomaticFontPageCoordinatorV2>;
  index: number;
  sourceStyle: FontMatchingSourceStyleV2;
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>;
}): void {
  const page = { ...makePage(), id: `cap-anchor-page-${index}` };
  const block = makeBlock({ id: `cap-anchor-block-${index}` });
  resolveAutomaticFontDecisionV2({
    block,
    item: makeItem("dialogue", 0.99),
    page,
    options: {
      enabled: true,
      targetLanguage: "ko",
      candidates,
      pageCoordinator: coordinator,
      pixelInference: makePixelInference({
        blockId: block.id,
        catalogVersion,
        pageId: page.id,
        scores: [0.94, 0.72],
        sourceStyle,
      }),
      runtimeArtifactStatus: status,
    },
  });
}
