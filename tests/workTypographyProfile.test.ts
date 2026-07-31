import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type {
  FontMatchAbstainReason,
  FontMatchDecisionV2,
  FontMatchDecisionEvidenceV2,
  FontMatchRolePredictionV2,
  FontMatchingDecisionPrioritySource,
  FontMatchingSourceStyleAxis,
  FontMatchingSourceStyleV2,
  FontMatchingTreatmentV2,
  FontStyleSelectionV2,
  IntentionalTypographyOverrideV2,
  RankedFontCandidateV2,
  RoleFontPaletteV2,
  WorkTypographyGenrePriorV2,
  WorkTypographyProfileV2,
} from "../src/shared/fontMatchingProfileTypes";
import { FONT_MATCHING_DECISION_PRIORITY } from "../src/shared/fontMatchingProfileTypes";
import { WorkTypographyProfileV2Schema } from "../src/shared/fontMatchingProfileSchemas";
import { FontMatchDecisionEvidenceV2Schema } from "../src/shared/fontMatchingEvidenceSchemas";
import {
  migrateWorkTypographyProfile,
  resolveWorkTypographyLock,
  serializeFontMatchDecisionEvidenceV2,
  serializeWorkTypographyProfileV2,
  validateFontMatchDecisionEvidenceV2,
  validateWorkTypographyProfileV2,
} from "../src/shared/fontMatchingProfileCodec";

const temporaryRoots: string[] = [];
const NOW = "2026-08-01T00:00:00.000Z";
const HASH = "a".repeat(64);

describe("font matching V2 contracts", () => {
  it("keeps the public component types wired to the versioned roots", () => {
    expectTypeOf<
      z.output<typeof WorkTypographyProfileV2Schema>
    >().toEqualTypeOf<WorkTypographyProfileV2>();
    expectTypeOf<
      z.output<typeof FontMatchDecisionEvidenceV2Schema>
    >().toEqualTypeOf<FontMatchDecisionEvidenceV2>();
    expectTypeOf<FontMatchingSourceStyleV2>().toEqualTypeOf<
      FontMatchDecisionEvidenceV2["sourceStyle"]
    >();
    expectTypeOf<FontMatchingTreatmentV2>().toEqualTypeOf<
      FontMatchDecisionEvidenceV2["treatment"]
    >();
    expectTypeOf<FontMatchRolePredictionV2>().toEqualTypeOf<
      FontMatchDecisionEvidenceV2["role"]
    >();
    expectTypeOf<RankedFontCandidateV2>().toEqualTypeOf<
      FontMatchDecisionEvidenceV2["rankedCandidates"][number]
    >();
    expectTypeOf<FontMatchDecisionV2>().toEqualTypeOf<
      FontMatchDecisionEvidenceV2["decision"]
    >();
    expectTypeOf<FontStyleSelectionV2>().toEqualTypeOf<
      WorkTypographyProfileV2["userLocks"][number]["selection"]
    >();
    expectTypeOf<RoleFontPaletteV2>().toEqualTypeOf<
      WorkTypographyProfileV2["rolePalettes"][number]
    >();
    expectTypeOf<IntentionalTypographyOverrideV2>().toEqualTypeOf<
      WorkTypographyProfileV2["intentionalOverrides"][number]
    >();
    expectTypeOf<WorkTypographyGenrePriorV2>().toEqualTypeOf<
      NonNullable<WorkTypographyProfileV2["genrePrior"]>
    >();
    expectTypeOf<FontMatchingSourceStyleAxis>().toEqualTypeOf<
      keyof WorkTypographyGenrePriorV2["styleBias"]
    >();
    expectTypeOf<FontMatchAbstainReason>().toEqualTypeOf<
      Extract<FontMatchDecisionV2, { mode: "abstain" }>["abstainReason"]
    >();
    expectTypeOf<FontMatchingDecisionPrioritySource>().toEqualTypeOf<
      (typeof FONT_MATCHING_DECISION_PRIORITY)[number]
    >();
    expect(FONT_MATCHING_DECISION_PRIORITY).toEqual([
      "block_user_lock",
      "work_role_user_lock",
      "work_profile",
      "v2_automatic",
      "user_default_or_top3",
    ]);
  });

  it("validates and deterministically serializes a work profile", () => {
    const profile = makeProfile();
    const serialized = serializeWorkTypographyProfileV2(profile);
    const parsed = JSON.parse(serialized) as WorkTypographyProfileV2;

    expect(parsed.rolePalettes.map((palette) => palette.role)).toEqual([
      "aside_balloon_edge",
      "sfx_impact",
    ]);
    expect(parsed.rolePalettes[0]?.allowedFontIds).toEqual([
      "cafe24-gowoonbam",
      "gaegu",
    ]);
    expect(parsed.userLocks.map((lock) => lock.id)).toEqual([
      "block-lock",
      "role-lock",
    ]);
    expect(serializeWorkTypographyProfileV2(parsed)).toBe(serialized);
    expect(validateWorkTypographyProfileV2(parsed)).toEqual(parsed);
  });

  it("enforces body-anchor, SFX palette, and weak genre-prior invariants", () => {
    const profile = makeProfile();
    expect(() =>
      validateWorkTypographyProfileV2({
        ...profile,
        dialogueAnchor: {
          ...profile.dialogueAnchor,
          primaryFontId: "not-allowed",
        },
      }),
    ).toThrow(/primaryFontId|allowedFontIds/);
    expect(() =>
      validateWorkTypographyProfileV2({
        ...profile,
        rolePalettes: [
          {
            ...profile.rolePalettes[0],
            allowedFontIds: ["gaegu"],
            maxDistinctFonts: 2,
          },
        ],
      }),
    ).toThrow(/rolePalettes|allowedFontIds/);
    expect(() =>
      validateWorkTypographyProfileV2({
        ...profile,
        genrePrior: {
          ...profile.genrePrior,
          maxScoreContribution: 0.1001,
        },
      }),
    ).toThrow(/genrePrior|maxScoreContribution/);
    expect(() =>
      validateWorkTypographyProfileV2({
        ...profile,
        narrationAnchor: {
          ...profile.dialogueAnchor,
          evidenceCount: 1,
        },
      }),
    ).toThrow(/narrationAnchor|repeated evidence/);
    expect(() =>
      validateWorkTypographyProfileV2({
        ...profile,
        consistencyPolicy: {
          ...profile.consistencyPolicy,
          maxAccentFontsPerRole: 2,
        },
        rolePalettes: [
          {
            ...profile.rolePalettes[0],
            allowedFontIds: ["dohyeon", "jua", "start-over"],
            maxDistinctFonts: 3,
          },
        ],
      }),
    ).toThrow(/consistency policy|rolePalettes/);
  });

  it("migrates the version-one draft without inventing genre evidence", () => {
    const migrated = migrateWorkTypographyProfile({
      schemaVersion: 1,
      workId: "work-1",
      dialogueAnchorFontId: "nanum-gothic",
      narrationAnchorFontId: null,
      thoughtAnchorFontId: null,
      rolePalettes: [
        {
          role: "sfx_impact",
          fontIds: ["dohyeon", "jua"],
        },
      ],
      userRoleLocks: [{ role: "dialogue", fontId: "nanum-gothic" }],
      evidenceCount: 60,
      confidence: 0.86,
      catalogVersion: "font-catalog-v1",
      modelVersion: "matcher-shadow-v1",
      rendererHash: HASH,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.dialogueAnchor).toMatchObject({
      primaryFontId: "nanum-gothic",
      origin: "migrated",
    });
    expect(migrated.genrePrior).toBeNull();
    expect(migrated.userLocks[0]).toMatchObject({
      scope: { type: "role", role: "dialogue" },
    });
  });

  it("resolves a block lock before a work-role lock", () => {
    const profile = makeProfile();
    const block = resolveWorkTypographyLock(profile, {
      role: "dialogue",
      chapterId: "chapter-1",
      pageId: "page-1",
      blockId: "block-1",
    });
    const role = resolveWorkTypographyLock(profile, {
      role: "dialogue",
      chapterId: "chapter-1",
      pageId: "page-1",
      blockId: "unlocked-block",
    });

    expect(block?.id).toBe("block-lock");
    expect(role?.id).toBe("role-lock");
  });

  it("validates ranked decisions and preserves explicit abstention", () => {
    const evidence = makeEvidence();
    const serialized = serializeFontMatchDecisionEvidenceV2(evidence);
    const parsed = JSON.parse(serialized) as FontMatchDecisionEvidenceV2;

    expect(parsed.rankedCandidates.map((candidate) => candidate.rank)).toEqual([
      1, 2,
    ]);
    expect(validateFontMatchDecisionEvidenceV2(parsed)).toEqual(parsed);
    expect(() =>
      validateFontMatchDecisionEvidenceV2({
        ...evidence,
        decision: {
          mode: "abstain",
          selectedFontId: null,
          topCandidateFontIds: [],
          noneAcceptable: true,
          abstainReason: "low_confidence",
          resolvedBy: "user_default_or_top3",
        },
      }),
    ).toThrow(/noneAcceptable|no_acceptable_candidate/);
    expect(() =>
      validateFontMatchDecisionEvidenceV2({
        ...evidence,
        role: {
          primary: "unknown_needs_review",
          confidence: 0.4,
          alternatives: [],
        },
      }),
    ).toThrow(/unknown roles|role_unknown/);
  });
});

describe("work typography profile files", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    while (temporaryRoots.length > 0) {
      const root = temporaryRoots.pop();
      if (root) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("treats a missing profile as absent without changing existing work data", async () => {
    const root = await createLibrary();
    const store = await loadStore(root);
    const workPath = join(root, "works", "work-1", "work.json");
    const before = await readFile(workPath, "utf8");

    await expect(store.readWorkTypographyProfile("work-1")).resolves.toBeNull();
    expect(await readFile(workPath, "utf8")).toBe(before);
  });

  it("atomically writes a canonical profile and reads it back", async () => {
    const root = await createLibrary();
    const store = await loadStore(root);
    const saved = await store.writeWorkTypographyProfile(makeProfile());
    const profilePath = join(
      root,
      "works",
      "work-1",
      store.WORK_TYPOGRAPHY_PROFILE_FILE_NAME,
    );
    const disk = await readFile(profilePath, "utf8");

    expect(disk).toBe(serializeWorkTypographyProfileV2(saved));
    await expect(store.readWorkTypographyProfile("work-1")).resolves.toEqual(
      saved,
    );
  });

  it("migrates version one on read without silently rewriting the source file", async () => {
    const root = await createLibrary();
    const legacy = {
      schemaVersion: 1,
      workId: "work-1",
      dialogueAnchorFontId: "nanum-gothic",
      evidenceCount: 40,
      confidence: 0.8,
      catalogVersion: "catalog-v1",
      modelVersion: "model-v1",
      rendererHash: HASH,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const path = join(root, "works", "work-1", "typography-profile.json");
    await writeJson(path, legacy);
    const before = await readFile(path, "utf8");
    const store = await loadStore(root);

    await expect(
      store.readWorkTypographyProfile("work-1"),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      dialogueAnchor: { primaryFontId: "nanum-gothic" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects a profile stored under a different work", async () => {
    const root = await createLibrary();
    const path = join(root, "works", "work-1", "typography-profile.json");
    await writeFile(
      path,
      serializeWorkTypographyProfileV2(makeProfile("work-2")),
      "utf8",
    );
    const store = await loadStore(root);

    await expect(store.readWorkTypographyProfile("work-1")).rejects.toThrow(
      /보관함 위치/,
    );
  });
});

function makeProfile(workId = "work-1"): WorkTypographyProfileV2 {
  return {
    schemaVersion: 2,
    workId,
    dialogueAnchor: {
      primaryFontId: "nanum-gothic",
      allowedFontIds: ["nanum-barun-gothic", "nanum-gothic"],
      origin: "learned",
      evidenceCount: 80,
      confidence: 0.92,
      replacementPolicy: { minimumEvidenceCount: 20, minimumScoreMargin: 0.12 },
      updatedAt: NOW,
    },
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [
      {
        role: "sfx_impact",
        allowedFontIds: ["jua", "dohyeon"],
        maxDistinctFonts: 2,
        reuseVisualClusterFont: true,
        evidenceCount: 20,
        confidence: 0.87,
      },
      {
        role: "aside_balloon_edge",
        allowedFontIds: ["gaegu", "cafe24-gowoonbam"],
        maxDistinctFonts: 2,
        reuseVisualClusterFont: true,
        evidenceCount: 16,
        confidence: 0.84,
      },
    ],
    intentionalOverrides: [],
    userLocks: [
      {
        id: "role-lock",
        scope: { type: "role", role: "dialogue" },
        selection: { fontId: "nanum-gothic" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "block-lock",
        scope: {
          type: "block",
          chapterId: "chapter-1",
          pageId: "page-1",
          blockId: "block-1",
        },
        selection: { fontId: "nanum-myeongjo", fontWeight: 700 },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    orientationPolicy: {
      horizontalAllowedFontIds: ["nanum-gothic"],
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: ["seoul-namsan-vertical"],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: {
      source: "context_model",
      labels: [
        { label: "action", probability: 0.7 },
        { label: "romance", probability: 0.2 },
      ],
      styleBias: { energy: 0.2, serifness: -0.05 },
      maxScoreContribution: 0.1,
    },
    evidenceCount: 120,
    confidence: 0.9,
    catalogVersion: "font-catalog-v1",
    modelVersion: "matcher-shadow-v2",
    rendererHash: HASH,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeEvidence(): FontMatchDecisionEvidenceV2 {
  const candidate = (rank: number, font: string, score: number) => ({
    rank,
    fontId: font,
    renderStatus: "rendered" as const,
    unrenderableReason: null,
    styleFit: score,
    roleFit: score,
    layoutFit: null,
    glyphCoverage: 1,
    workProfileFit: score,
    userPreferenceFit: 0,
    genrePriorContribution: 0.05,
    switchPenalty: 0,
    totalScore: score,
    confidence: score,
    reasonCodes: ["role_fit", "visual_fit"],
  });
  return {
    schemaVersion: 2,
    workId: "work-1",
    chapterId: "chapter-1",
    pageId: "page-1",
    blockId: "block-1",
    role: {
      primary: "dialogue",
      confidence: 0.9,
      alternatives: [{ role: "thought", confidence: 0.1 }],
    },
    sourceStyle: {
      serifness: 0.1,
      weight: 0.5,
      width: 0.5,
      roundness: 0.4,
      strokeContrast: 0.2,
      handwritten: 0,
      angularity: 0.3,
      irregularity: 0.1,
      slant: 0,
      energy: 0.3,
      unknownFields: [],
    },
    treatment: {
      orientation: "vertical",
      outline: "single",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "normal",
      colorMode: "monochrome",
    },
    rankedCandidates: [
      candidate(2, "nanum-barun-gothic", 0.7),
      candidate(1, "nanum-gothic", 0.9),
    ],
    decision: {
      mode: "apply",
      selectedFontId: "nanum-gothic",
      topCandidateFontIds: ["nanum-gothic", "nanum-barun-gothic"],
      noneAcceptable: false,
      abstainReason: null,
      resolvedBy: "v2_automatic",
    },
    catalogVersion: "font-catalog-v1",
    modelVersion: "matcher-shadow-v2",
    rendererHash: HASH,
    createdAt: NOW,
  };
}

async function createLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "manga-typography-profile-"));
  temporaryRoots.push(root);
  await writeJson(join(root, "index.json"), { workOrder: ["work-1"] });
  await writeJson(join(root, "works", "work-1", "work.json"), {
    id: "work-1",
    title: "작품",
    chapterOrder: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return root;
}

async function loadStore(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root }),
  }));
  return import("../src/main/libraryStore/workTypographyProfileFiles");
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
