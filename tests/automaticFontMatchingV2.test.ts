import { describe, expect, it } from "vitest";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
  resolveAutomaticFontDecisionV2,
} from "../src/main/pipeline/automaticFontMatchingV2";
import {
  createAutomaticFontPageCoordinatorV2,
  orderAutomaticFontMatchingPageItemIndexes,
} from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import type { FontMatchingDecisionResultV2 } from "../src/main/pipeline/fontMatchingDecisionV2";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { WorkTypographyProfileV2 } from "../src/shared/fontMatchingProfileTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

describe("automatic font matching V2 adapter", () => {
  it("keeps the semantic bootstrap in shadow mode without pixel evidence", () => {
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
      abstainReason: "low_confidence",
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
      abstainReason: "low_confidence",
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
      abstainReason: "low_confidence",
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
      abstainReason: "low_confidence",
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
      abstainReason: "low_confidence",
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

  it("does not reinterpret keep-mode formatting as a user lock", () => {
    const candidates = [builtIn("ridi-batang"), builtIn("jua")];
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock(),
      item: makeItem("dialogue", 0.95),
      page: makePage(),
      preserveExistingFont: true,
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        candidates,
        profile: makeProfile({
          catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
        }),
      },
    });

    expect(decision).toBeUndefined();
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

  it("orders body anchors before accents while preserving source order", () => {
    const items = [
      makeItem("sfx_impact", 1),
      makeItem("dialogue", 1),
      makeItem("thought", 1),
      makeItem("aside_balloon_edge", 1),
      makeItem("sign_ui_title", 1),
    ];

    expect(orderAutomaticFontMatchingPageItemIndexes(items)).toEqual([
      1, 2, 0, 3, 4,
    ]);
  });

  it("never assigns a visual cluster to ordinary body roles", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const item = Object.assign(makeItem("dialogue", 1), {
      visualClusterId: "explicit-body-cluster",
    });

    expect(coordinator.prepareWorkState(item, "dialogue")).toBeUndefined();
  });

  it("uses explicit clusters for accents but does not derive them for asides", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const aside = makeItem("aside_balloon_edge", 1);
    const explicitAside = Object.assign(
      { ...aside },
      {
        visualClusterId: "aside-cluster-1",
      },
    );

    expect(
      coordinator.prepareWorkState(aside, "aside_balloon_edge"),
    ).toBeUndefined();
    expect(
      coordinator.prepareWorkState(explicitAside, "aside_balloon_edge"),
    ).toMatchObject({ visualClusterId: "aside-cluster-1" });
  });

  it("keeps meaningful Japanese symbols distinct in derived clusters", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const plain = {
      ...makeItem("sfx_emotion", 1),
      jp: "ドキ",
      sourceText: "ドキ",
    };
    const decorated = {
      ...makeItem("sfx_emotion", 1),
      jp: "ドキ♡",
      sourceText: "ドキ♡",
    };

    const plainState = coordinator.prepareWorkState(plain, "sfx_emotion");
    const decoratedState = coordinator.prepareWorkState(
      decorated,
      "sfx_emotion",
    );

    expect(plainState?.visualClusterId).not.toBe(
      decoratedState?.visualClusterId,
    );
  });

  it("does not cache intentional overrides as cluster defaults", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const item = makeItem("sfx_impact", 1);
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
    const initialState = coordinator.prepareWorkState(item, "sfx_impact");
    coordinator.recordDecision(
      "sfx_impact",
      initialState,
      makeCoordinatorResult("jua"),
      profile,
    );
    const clusteredState = coordinator.prepareWorkState(item, "sfx_impact");
    expect(clusteredState?.visualClusterFontId).toBe("jua");

    coordinator.recordDecision(
      "sfx_impact",
      clusteredState,
      makeCoordinatorResult("dohyeon", [
        "intentional_override_margin_passed",
        "role_palette",
      ]),
      profile,
    );

    expect(
      coordinator.prepareWorkState(item, "sfx_impact")?.visualClusterFontId,
    ).toBe("jua");
  });

  it("does not cache a manual role lock as automatic page state", () => {
    const coordinator = createAutomaticFontPageCoordinatorV2();
    const item = makeItem("sfx_impact", 1);
    const profile = makeProfile({
      dialogueAnchor: null,
      rolePalettes: [
        {
          role: "sfx_impact",
          allowedFontIds: ["jua"],
          maxDistinctFonts: 1,
          reuseVisualClusterFont: true,
          evidenceCount: 20,
          confidence: 1,
        },
      ],
    });
    const initialState = coordinator.prepareWorkState(item, "sfx_impact");
    coordinator.recordDecision(
      "sfx_impact",
      initialState,
      makeCoordinatorResult("jua", ["role_palette"], "work_role_user_lock"),
      profile,
    );

    expect(
      coordinator.prepareWorkState(item, "sfx_impact")?.visualClusterFontId,
    ).toBeUndefined();
  });
});

function makeCoordinatorResult(
  fontId: string,
  reasonCodes: string[] = ["role_palette"],
  resolvedBy: "work_profile" | "work_role_user_lock" = "work_profile",
): FontMatchingDecisionResultV2 {
  return {
    decision: {
      mode: "apply",
      selectedFontId: fontId,
      topCandidateFontIds: [fontId],
      noneAcceptable: false,
      abstainReason: null,
      resolvedBy,
    },
    selectedStyle: { fontId },
    audit: {
      policyVersion: "font-matching-decision-v2.0",
      legacyTitleOrRegexFallbackUsed: false,
      modelReportedNoneAcceptable: false,
      localCalibratedConfidence: 0,
      roleConfidence: 1,
      genreContributionCap: 0,
      evaluatedCandidates: [],
      rejectedCandidates: [],
      priorityTrace: [
        {
          priority: "work_profile",
          status: "selected",
          candidateFontId: fontId,
          reasonCodes,
        },
      ],
    },
  };
}

function builtIn(fontId: string) {
  return makeAutomaticFontCandidate({
    source: "built-in",
    fontId,
    defaultFont: fontId === "jua",
  });
}

function makeItem(
  fontRole: OverlayItem["fontRole"],
  fontRoleConfidence: number,
): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: fontRole?.startsWith("sfx_") ? "sound" : "ordinary",
    fontRole,
    fontRoleConfidence,
    bbox: { x: 100, y: 100, w: 200, h: 120 },
    jp: "ドン",
    ko: "쾅!",
    confidence: 1,
  };
}

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 120 },
    bboxSpace: "normalized_1000",
    sourceText: "ドン",
    translatedText: "쾅!",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    rotationDeg: 0,
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
    ...overrides,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeProfile(
  overrides: Partial<WorkTypographyProfileV2> = {},
): WorkTypographyProfileV2 {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: {
      primaryFontId: "ridi-batang",
      allowedFontIds: ["ridi-batang"],
      origin: "manual",
      evidenceCount: 20,
      confidence: 1,
      replacementPolicy: {
        minimumEvidenceCount: 20,
        minimumScoreMargin: 0.1,
      },
      updatedAt: now,
    },
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [],
    intentionalOverrides: [],
    userLocks: [],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: ["seoul-namsan-vertical"],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: 20,
    confidence: 1,
    catalogVersion: "test-profile-without-runtime-manifest",
    modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
    rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
