import { describe, expect, it } from "vitest";
import type { ComicPageDetection } from "../src/main/bubbleLayout/contracts";
import { attachEffectReviewToPage } from "../src/main/pipeline/pageResponseParser";
import { toReviewedSoundEffectBlock } from "../src/main/jobs/reviewedSoundEffectBlock";
import { buildHayaiRegionManifest } from "../src/main/textDetection/hayaiRegionGeometry";
import {
  resolveVisibleSoundEffectReviewRegions,
  reviewRegionConflictsWithBlock,
  summarizeSoundEffectReviewChapter,
} from "../src/renderer/src/lib/soundEffectReviewRegions";
import type { MangaPage } from "../src/shared/libraryTypes";
import { ChapterSnapshotSchema } from "../src/shared/ipcLibrarySchemas";
import {
  DismissSoundEffectReviewRegionRequestSchema,
  PrepareSoundEffectTranslationPageSchema,
  PrepareSoundEffectTranslationRequestSchema,
  SoundEffectReviewSchema,
} from "../src/shared/ipcSoundEffectReviewSchemas";
import { LEGACY_REVIEWED_SOUND_EFFECT_NOTE } from "../src/shared/soundEffectBlocks";
import {
  normalizeSoundEffectReview,
  resolveEffectiveSoundEffectReviewRegions,
  resolvePendingSoundEffectReviewRegions,
} from "../src/shared/soundEffectReview";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("sound-effect review boundary", () => {
  it("hides dismissed candidates and candidates that intrude on real text blocks", () => {
    const page = makePage();
    page.blocks = [makeBlock({ x: 100, y: 100, w: 200, h: 300 })];
    page.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
      dismissedRegionIds: ["FX003"],
      regions: [
        makeEffect("FX001", { x: 120, y: 120, w: 90, h: 140 }),
        makeEffect("FX002", { x: 600, y: 120, w: 90, h: 140 }),
        makeEffect("FX003", { x: 800, y: 120, w: 90, h: 140 }),
      ],
    };

    expect(
      resolveVisibleSoundEffectReviewRegions(page).map(({ id }) => id),
    ).toEqual(["FX002"]);
    expect(
      reviewRegionConflictsWithBlock(
        { x: 250, y: 100, w: 200, h: 300 },
        page.blocks[0].bbox,
      ),
    ).toBe(true);
  });

  it("retains user dismissals across a Hayai retranslation", () => {
    const page = makePage();
    page.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
      dismissedRegionIds: ["FX001"],
      regions: [
        {
          ...makeEffect("FX001", { x: 5, y: 5, w: 90, h: 90 }),
          recognizedText: "old",
        },
      ],
    };
    const updated = attachEffectReviewToPage(page, "hayai", {
      hints: [],
      diagnostics: [],
      noTextDetected: true,
      effectReviewRegions: [
        makeEffect("FX001", { x: 10, y: 10, w: 100, h: 100 }),
        makeEffect("FX002", { x: 200, y: 10, w: 100, h: 100 }),
      ],
    });

    expect(updated.soundEffectReview?.dismissedRegionIds).toEqual(["FX001"]);
    expect(updated.soundEffectReview?.regions.map(({ id }) => id)).toEqual([
      "FX001",
      "FX002",
    ]);
    expect(updated.soundEffectReview?.regions[0]?.bbox.x).toBe(10);
  });

  it("keeps the chapter launcher visible when the current page has no candidates", () => {
    const emptyPage = makePage();
    emptyPage.id = "empty";
    const historyPage = makePage();
    historyPage.id = "history";
    historyPage.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      regions: [makeEffect("FX001", { x: 10, y: 10, w: 40, h: 40 })],
      resolvedRegions: [
        {
          regionId: "FX001",
          blockId: "block-1",
          resolvedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    expect(summarizeSoundEffectReviewChapter([emptyPage, historyPage])).toEqual(
      {
        available: true,
        pendingCount: 0,
      },
    );
    expect(resolveVisibleSoundEffectReviewRegions(null)).toEqual([]);

    const dismissedOnly = makePage();
    dismissedOnly.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      regions: [],
      resolvedRegions: [],
      dismissedRegionIds: ["FX-dismissed"],
    };
    expect(summarizeSoundEffectReviewChapter([dismissedOnly])).toEqual({
      available: true,
      pendingCount: 0,
    });
  });

  it("leaves legacy pages untouched and omits an empty Hayai review", () => {
    const page = makePage();
    const legacy = attachEffectReviewToPage(page, "paddle-legacy", {
      hints: [],
      diagnostics: [],
      noTextDetected: false,
      effectReviewRegions: [
        makeEffect("FX001", { x: 10, y: 10, w: 100, h: 100 }),
      ],
    });

    expect(legacy).toBe(page);
    expect(
      attachEffectReviewToPage(page, "hayai", undefined).soundEffectReview,
    ).toBeUndefined();
    const detected = attachEffectReviewToPage(page, "hayai", {
      hints: [],
      diagnostics: [],
      noTextDetected: false,
      effectReviewRegions: [
        makeEffect("FX-new", { x: 10, y: 10, w: 100, h: 100 }),
      ],
    });
    expect(detected.soundEffectReview).not.toHaveProperty("dismissedRegionIds");

    page.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regions: [],
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
      dismissedRegionIds: ["FX-history"],
    };
    expect(
      attachEffectReviewToPage(page, "hayai", undefined).soundEffectReview,
    ).toMatchObject({ dismissedRegionIds: ["FX-history"] });
  });

  it("creates reviewed SFX blocks without automatic source erasure", () => {
    const reviewed = toReviewedSoundEffectBlock({
      ...makeBlock({ x: 10, y: 20, w: 100, h: 120 }),
      fontRole: "dialogue",
      fontRoleConfidence: 0.9,
    });

    expect(reviewed).toMatchObject({
      autoFitText: true,
      textRole: "sound",
    });
    expect(reviewed).not.toHaveProperty("fontRole");
    expect(reviewed).not.toHaveProperty("fontRoleConfidence");
    expect(reviewed).not.toHaveProperty("inpaintExcluded");
    expect(reviewed).not.toHaveProperty("reviewStatus");
  });

  it("keeps separated vertical columns distinct even when Koharu assigns one bubble", () => {
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [
        detection("bubble", 0.99, [2, 0, 9, 7]),
        detection("text", 0.95, [6, 1, 8, 6]),
        detection("text", 0.94, [3, 1, 5, 6]),
        detection("onomatopoeia", 0.9, [1, 8, 3, 10]),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(2);
    expect(
      manifest.dialogueRegions.map(
        ({ sourceDetectionIds }) => sourceDetectionIds,
      ),
    ).toEqual([["T002"], ["T003"]]);
    expect(manifest.diagnostics.dialogueFragmentMerges).toBe(0);
    expect(manifest.effectRegions).toHaveLength(1);
    expect(manifest.effectRegions[0]?.kind).toBe("effect");
  });

  it("keeps high-confidence aligned text fragments separate inside one balloon", () => {
    const bubble: Array<[number, number]> = [];
    const upper: Array<[number, number]> = [];
    const lower: Array<[number, number]> = [];
    for (let y = 1; y < 19; y += 1) {
      for (let x = 2; x < 18; x += 1) bubble.push([x, y]);
    }
    for (let y = 3; y < 14; y += 1) {
      for (let x = 8; x < 12; x += 1) upper.push([x, y]);
    }
    for (let y = 13; y < 18; y += 1) {
      for (let x = 8; x < 12; x += 1) lower.push([x, y]);
    }
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [
        maskedDetection("bubble", 0.99, 20, 20, bubble),
        maskedDetection("text", 0.97, 20, 20, upper),
        maskedDetection("text", 0.95, 20, 20, lower),
      ],
    });
    expect(manifest.dialogueRegions).toHaveLength(2);
    expect(
      manifest.dialogueRegions.map(
        ({ sourceDetectionIds }) => sourceDetectionIds,
      ),
    ).toEqual([["T002"], ["T003"]]);
    expect(
      manifest.dialogueRegions.every((region) => !region.recognitionBboxes),
    ).toBe(true);
    expect(manifest.diagnostics.dialogueFragmentMerges).toBe(0);
  });

  it("does not infer a merge from an aligned 0.85-confidence tail", () => {
    const bubble: Array<[number, number]> = [];
    const body: Array<[number, number]> = [];
    const tail: Array<[number, number]> = [];
    for (let y = 1; y < 19; y += 1) {
      for (let x = 2; x < 18; x += 1) bubble.push([x, y]);
    }
    for (let y = 3; y < 14; y += 1) {
      for (let x = 8; x < 12; x += 1) body.push([x, y]);
    }
    for (let y = 13; y < 18; y += 1) {
      for (let x = 8; x < 12; x += 1) tail.push([x, y]);
    }

    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [
        maskedDetection("bubble", 0.99, 20, 20, bubble),
        maskedDetection("text", 0.9367, 20, 20, body),
        maskedDetection("text", 0.8576, 20, 20, tail),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(2);
    expect(
      manifest.dialogueRegions.map(
        ({ sourceDetectionIds }) => sourceDetectionIds,
      ),
    ).toEqual([["T002"], ["T003"]]);
    expect(manifest.diagnostics.dialogueFragmentMerges).toBe(0);
  });

  it("uses a strongly overlapping composite mask as positive merge evidence", () => {
    const right: Array<[number, number]> = [];
    const left: Array<[number, number]> = [];
    for (let y = 3; y < 16; y += 1) {
      for (let x = 9; x < 13; x += 1) right.push([x, y]);
      for (let x = 6; x < 10; x += 1) left.push([x, y]);
    }
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [
        maskedDetection("text", 0.62, 20, 20, right),
        maskedDetection("text", 0.56, 20, 20, left),
        maskedDetection("text", 0.44, 20, 20, [...right, ...left]),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(1);
    expect(manifest.dialogueRegions[0]?.sourceDetectionIds).toEqual([
      "T001",
      "T002",
      "T003",
    ]);
    expect(manifest.diagnostics.dialogueFragmentMerges).toBe(0);
  });

  it("isolates a composite mask when it borrows two disjoint child blocks", () => {
    const upper: Array<[number, number]> = [];
    const lower: Array<[number, number]> = [];
    for (let y = 3; y < 11; y += 1) {
      for (let x = 15; x < 20; x += 1) upper.push([x, y]);
    }
    for (let y = 17; y < 23; y += 1) {
      for (let x = 5; x < 15; x += 1) lower.push([x, y]);
    }
    const borrowedLower = lower.filter((_, index) => index % 2 === 0);
    const manifest = buildHayaiRegionManifest({
      imageWidth: 300,
      imageHeight: 300,
      detections: [
        maskedDetection("text", 0.38, 30, 30, [...upper, ...borrowedLower]),
        maskedDetection("text", 0.5, 30, 30, upper),
        maskedDetection("text", 0.82, 30, 30, lower),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(2);
    expect(manifest.dialogueRegions[0]).toMatchObject({
      bbox: [145, 25, 205, 115],
      sourceDetectionIds: ["T001", "T002"],
    });
    expect(manifest.dialogueRegions[1]).toMatchObject({
      bbox: [45, 165, 155, 235],
      sourceDetectionIds: ["T003"],
    });
    expect(manifest.diagnostics.dialogueOverlapCuts).toBe(0);
  });

  it("trims mutually borrowed tails when the detector boxes prove ownership", () => {
    const right: Array<[number, number]> = [];
    const left: Array<[number, number]> = [];
    for (let y = 3; y < 15; y += 1) {
      for (let x = 10; x < 13; x += 1) right.push([x, y]);
    }
    for (let y = 4; y < 15; y += 1) {
      for (let x = 3; x < 6; x += 1) left.push([x, y]);
    }
    const rightBorrow = right.slice(0, 5);
    const leftBorrow = left.slice(0, 3);
    const rightDetection = maskedDetection("text", 0.95, 20, 20, [
      ...right,
      ...leftBorrow,
    ]);
    rightDetection.box = [50, 15, 65, 75];
    const leftDetection = maskedDetection("text", 0.83, 20, 20, [
      ...left,
      ...rightBorrow,
    ]);
    leftDetection.box = [15, 20, 30, 75];
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [rightDetection, leftDetection],
    });

    expect(manifest.dialogueRegions).toHaveLength(2);
    expect(manifest.dialogueRegions).toEqual([
      expect.objectContaining({
        bbox: [45, 10, 70, 80],
        sourceDetectionIds: ["T001"],
      }),
      expect.objectContaining({
        bbox: [10, 15, 35, 80],
        sourceDetectionIds: ["T002"],
      }),
    ]);
  });

  it("trims a sub-percent extreme text-mask tail without clipping the dense glyph core", () => {
    const points: Array<[number, number]> = [];
    for (let y = 2; y < 11; y += 1) {
      for (let x = 5; x < 9; x += 1) points.push([x, y]);
    }
    points.push([6, 19]);
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [maskedDetection("text", 0.95, 20, 20, points)],
    });

    expect(manifest.dialogueRegions).toHaveLength(1);
    expect(manifest.dialogueRegions[0]?.bbox).toEqual([20, 5, 50, 60]);
    expect(manifest.diagnostics.rejectedDialogueCount).toBe(0);
  });

  it("rejects a page-spanning sparse text proposal with no bubble or panel support", () => {
    const points = Array.from(
      { length: 10 },
      (_, index) => [index * 2 + 1, index * 2 + 1] as [number, number],
    );
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [maskedDetection("text", 0.4, 20, 20, points)],
    });

    expect(manifest.dialogueRegions).toHaveLength(0);
    expect(manifest.diagnostics.rejectedDialogueCount).toBe(1);
  });

  it("rejects a narrow vertical proposal spanning stacked panels even with strong container support", () => {
    const panel: Array<[number, number]> = [];
    const bubble: Array<[number, number]> = [];
    const text: Array<[number, number]> = [];
    for (let y = 1; y < 20; y += 1) {
      for (let x = 14; x < 19; x += 1) panel.push([x, y]);
    }
    for (let y = 13; y < 20; y += 1) {
      for (let x = 14; x < 19; x += 1) bubble.push([x, y]);
    }
    for (let y = 1; y < 20; y += 3) text.push([16, y]);
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [
        maskedDetection("panel", 0.99, 20, 20, panel),
        maskedDetection("bubble", 0.99, 20, 20, bubble),
        maskedDetection("text", 0.95, 20, 20, text),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(0);
    expect(manifest.diagnostics.rejectedDialogueCount).toBe(1);
  });

  it("keeps a locally tall narrow vertical dialogue proposal", () => {
    const text: Array<[number, number]> = [];
    for (let y = 8; y < 15; y += 1) text.push([10, y]);
    const manifest = buildHayaiRegionManifest({
      imageWidth: 100,
      imageHeight: 100,
      detections: [maskedDetection("text", 0.95, 20, 20, text)],
    });

    expect(manifest.dialogueRegions).toHaveLength(1);
    expect(manifest.diagnostics.rejectedDialogueCount).toBe(0);
  });

  it("trims a tiny distant tail from a page-spanning vertical strip and preserves its local glyph core", () => {
    const core: Array<[number, number]> = [];
    for (let y = 15; y < 20; y += 1) {
      for (let x = 9; x < 12; x += 1) core.push([x, y]);
    }
    const manifest = buildHayaiRegionManifest({
      imageWidth: 40,
      imageHeight: 100,
      detections: [maskedDetection("text", 0.95, 20, 20, [[10, 1], ...core])],
    });

    expect(manifest.dialogueRegions).toHaveLength(1);
    expect(manifest.dialogueRegions[0]?.bbox).toEqual([13, 70, 29, 100]);
    expect(manifest.diagnostics.rejectedDialogueCount).toBe(0);
  });

  it("deduplicates near-identical masks even when sparse edge pixels weaken box overlap", () => {
    const core: Array<[number, number]> = [];
    for (let y = 10; y < 20; y += 1) {
      for (let x = 10; x < 20; x += 1) core.push([x, y]);
    }
    const manifest = buildHayaiRegionManifest({
      imageWidth: 300,
      imageHeight: 300,
      detections: [
        maskedDetection("text", 0.9, 30, 30, [...core, [10, 5], [11, 5]]),
        maskedDetection("text", 0.8, 30, 30, [...core, [10, 21], [11, 21]]),
      ],
    });

    expect(manifest.dialogueRegions).toHaveLength(1);
    expect(manifest.dialogueRegions[0]?.sourceDetectionIds).toEqual([
      "T001",
      "T002",
    ]);
  });

  it("normalizes v1 review data to v3 while preserving legacy dismissals", () => {
    const chapter = {
      id: "00000000-0000-4000-8000-000000000001",
      workId: "00000000-0000-4000-8000-000000000002",
      title: "1화",
      sourceKind: "images",
      status: "completed",
      pageOrder: ["00000000-0000-4000-8000-000000000003"],
      pages: [
        {
          ...makePage(),
          id: "00000000-0000-4000-8000-000000000003",
          soundEffectReview: {
            contractVersion: 1,
            producer: "hayai-regions-v1",
            dismissedRegionIds: ["FX002"],
            regions: [
              {
                ...makeEffect("FX001", { x: 10, y: 20, w: 30, h: 40 }),
                recognizedText: "ドン",
                sourceDetectionIds: ["K001", "K002"],
              },
            ],
          },
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const current =
      ChapterSnapshotSchema.parse(chapter).pages[0]?.soundEffectReview;
    expect(current).toMatchObject({
      contractVersion: 3,
      resolvedRegions: [],
      regionOverrides: [],
      manualRegions: [],
      dismissedRegionIds: ["FX002"],
      regions: [{ id: "FX001", recognizedText: "ドン" }],
    });
    chapter.pages[0].soundEffectReview.dismissedRegionIds = ["FX002", "FX002"];
    expect(ChapterSnapshotSchema.safeParse(chapter).success).toBe(false);
    expect(
      DismissSoundEffectReviewRegionRequestSchema.parse({
        chapterId: chapter.id,
        pageId: chapter.pages[0].id,
        regionId: "FX001",
      }),
    ).toMatchObject({ regionId: "FX001" });

    if (!current) throw new Error("Expected normalized sound-effect review.");
    expect(normalizeSoundEffectReview(current)).toBe(current);
  });

  it("normalizes v2 and invalidates OCR anchors only for edited detector geometry", () => {
    const normalized = normalizeSoundEffectReview({
      contractVersion: 2,
      producer: "hayai-regions-v1",
      regions: [
        {
          ...makeEffect("FX001", { x: 10, y: 20, w: 30, h: 40 }),
          recognizedText: "ドン",
          sourceDetectionIds: ["K001"],
        },
      ],
      resolvedRegions: [],
    });
    expect(normalized).toMatchObject({
      contractVersion: 3,
      regionOverrides: [],
      manualRegions: [],
    });

    const effective = resolveEffectiveSoundEffectReviewRegions({
      ...normalized,
      regionOverrides: [
        {
          regionId: "FX001",
          bbox: { x: 100, y: 200, w: 80, h: 90 },
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      manualRegions: [
        {
          id: "manual-1",
          bbox: { x: 400, y: 500, w: 60, h: 70 },
          detectorConfidence: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    expect(effective).toEqual([
      {
        id: "FX001",
        bbox: { x: 100, y: 200, w: 80, h: 90 },
        detectorConfidence: 0.8,
      },
      {
        id: "manual-1",
        bbox: { x: 400, y: 500, w: 60, h: 70 },
        detectorConfidence: 1,
      },
    ]);
  });

  it("validates legacy review contracts and rejects duplicate edit draft ids", () => {
    expect(
      SoundEffectReviewSchema.parse({
        contractVersion: 1,
        producer: "hayai-regions-v1",
        regions: [makeEffect("FX001", { x: 10, y: 20, w: 30, h: 40 })],
      }),
    ).toMatchObject({ contractVersion: 3, resolvedRegions: [] });
    expect(
      SoundEffectReviewSchema.parse({
        contractVersion: 2,
        producer: "hayai-regions-v1",
        regions: [],
        resolvedRegions: [],
      }),
    ).toMatchObject({ contractVersion: 3, manualRegions: [] });

    const pageDraft = {
      pageId: "00000000-0000-4000-8000-000000000003",
      pageRevision: "page-v1:0123456789abcdef",
      includedRegionIds: ["FX001"],
      editedRegions: [
        { regionId: "FX001", bbox: { x: 10, y: 20, w: 30, h: 40 } },
        { regionId: "FX001", bbox: { x: 50, y: 60, w: 30, h: 40 } },
      ],
      addedRegions: [],
      dismissedRegionIds: [],
    };
    expect(
      PrepareSoundEffectTranslationPageSchema.safeParse(pageDraft).success,
    ).toBe(false);

    const validPage = {
      ...pageDraft,
      editedRegions: pageDraft.editedRegions.slice(0, 1),
    };
    expect(
      PrepareSoundEffectTranslationPageSchema.safeParse(validPage).success,
    ).toBe(true);
    expect(
      PrepareSoundEffectTranslationRequestSchema.safeParse({
        chapterId: "00000000-0000-4000-8000-000000000001",
        pages: [validPage, validPage],
      }).success,
    ).toBe(false);
  });

  it("removes legacy SFX-only badges only from exactly linked generated blocks", () => {
    const page = makePage();
    page.id = "00000000-0000-4000-8000-000000000003";
    page.blocks = [
      {
        ...makeBlock({ x: 10, y: 20, w: 100, h: 120 }),
        id: "generated-sfx",
        textRole: "sound",
        reviewStatus: "needs_review",
        reviewNote: LEGACY_REVIEWED_SOUND_EFFECT_NOTE,
        inpaintExcluded: true,
      },
      {
        ...makeBlock({ x: 200, y: 20, w: 100, h: 120 }),
        id: "user-edited-sfx",
        textRole: "sound",
        reviewStatus: "needs_review",
        reviewNote: "사용자가 남긴 메모",
        inpaintExcluded: true,
      },
    ];
    page.soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regions: [
        makeEffect("FX001", { x: 10, y: 20, w: 100, h: 120 }),
        makeEffect("FX002", { x: 200, y: 20, w: 100, h: 120 }),
      ],
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [
        {
          regionId: "FX001",
          blockId: "generated-sfx",
          resolvedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          regionId: "FX002",
          blockId: "user-edited-sfx",
          resolvedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const parsed = ChapterSnapshotSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      workId: "00000000-0000-4000-8000-000000000002",
      title: "1화",
      sourceKind: "images",
      status: "completed",
      pageOrder: [page.id],
      pages: [page],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.pages[0].blocks[0]).toMatchObject({
      id: "generated-sfx",
      textRole: "sound",
      autoFitText: true,
    });
    expect(parsed.pages[0].blocks[0]).not.toHaveProperty("reviewStatus");
    expect(parsed.pages[0].blocks[0]).not.toHaveProperty("inpaintExcluded");
    expect(parsed.pages[0].blocks[1]).toMatchObject({
      id: "user-edited-sfx",
      reviewStatus: "needs_review",
      inpaintExcluded: true,
      reviewNote: "사용자가 남긴 메모",
    });
  });

  it("keeps SFX blocks independent and detects overlap dominated by a tiny text block", () => {
    const review = {
      contractVersion: 2 as const,
      producer: "hayai-regions-v1" as const,
      regions: [makeEffect("FX001", { x: 0, y: 0, w: 100, h: 100 })],
      resolvedRegions: [],
    };
    expect(
      resolvePendingSoundEffectReviewRegions(review, [
        {
          bbox: { x: 0, y: 0, w: 100, h: 100 },
          textRole: "sound",
        },
      ]).map(({ id }) => id),
    ).toEqual(["FX001"]);
    expect(
      reviewRegionConflictsWithBlock(
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 90, y: 90, w: 10, h: 10 },
      ),
    ).toBe(true);
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/manga/001.png",
    dataUrl: "data:image/png;base64,",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(bbox: TranslationBlock["bbox"]): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox,
    sourceText: "本文",
    translatedText: "본문",
    confidence: 0.99,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.2,
  };
}

function makeEffect(id: string, bbox: TranslationBlock["bbox"]) {
  return { id, bbox, detectorConfidence: 0.8 };
}

function detection(
  label: ComicPageDetection["label"],
  score: number,
  gridBox: [number, number, number, number],
): ComicPageDetection {
  const logits = new Float32Array(100).fill(-1);
  for (let y = gridBox[1]; y < gridBox[3]; y += 1) {
    for (let x = gridBox[0]; x < gridBox[2]; x += 1) {
      logits[y * 10 + x] = 1;
    }
  }
  const labelId = { text: 0, onomatopoeia: 1, bubble: 2, panel: 3 }[label] as
    | 0
    | 1
    | 2
    | 3;
  return {
    label,
    labelId,
    score,
    box: gridBox.map((value) => value * 10) as [number, number, number, number],
    mask: { logits, width: 10, height: 10 },
  };
}

function maskedDetection(
  label: ComicPageDetection["label"],
  score: number,
  width: number,
  height: number,
  points: ReadonlyArray<readonly [number, number]>,
): ComicPageDetection {
  const logits = new Float32Array(width * height).fill(-1);
  for (const [x, y] of points) logits[y * width + x] = 1;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const labelId = { text: 0, onomatopoeia: 1, bubble: 2, panel: 3 }[label] as
    | 0
    | 1
    | 2
    | 3;
  return {
    label,
    labelId,
    score,
    box: [
      (Math.min(...xs) / width) * 100,
      (Math.min(...ys) / height) * 100,
      ((Math.max(...xs) + 1) / width) * 100,
      ((Math.max(...ys) + 1) / height) * 100,
    ],
    mask: { logits, width, height },
  };
}
